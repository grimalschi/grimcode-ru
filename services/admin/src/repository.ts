import type { Administrator, AdminRole, AssignableServiceId } from '@template/contracts';
import { newId, withTransaction, type Pool, type PoolClient } from '@template/shared';

export interface AdministratorRow {
  id: string;
  user_id: string;
  email: string;
  role: AdminRole;
  enabled: boolean;
  bootstrap: boolean;
  created_at: Date;
  updated_at: Date;
  grants: string[] | null;
}

const COLUMNS = `
  a.id, a.user_id, a.email, a.role, a.enabled, a.bootstrap, a.created_at, a.updated_at,
  ARRAY(SELECT g.service FROM administrator_grants g
         WHERE g.administrator_id = a.id ORDER BY g.service) AS grants
`;

export function toAdministrator(row: AdministratorRow): Administrator {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    enabled: row.enabled,
    grants: (row.grants ?? []) as AssignableServiceId[],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class AdminRepository {
  constructor(private readonly pool: Pool) {}

  async isRegistryEmpty(): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM administrators',
    );
    return Number(rows[0]?.count ?? 0) === 0;
  }

  async findByUserId(userId: string): Promise<AdministratorRow | null> {
    const { rows } = await this.pool.query<AdministratorRow>(
      `SELECT ${COLUMNS} FROM administrators a WHERE a.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }


  /**
   * Idempotently promotes the first registered Auth identity to owner.
   *
   * Returns whether *this* call performed the insert, so only the request that really created the
   * owner writes the bootstrap audit entry. The partial unique index on `bootstrap` is what makes
   * two concurrent requests converge on one owner.
   */
  async bootstrapOwner(
    userId: string,
    email: string,
  ): Promise<{ row: AdministratorRow; created: boolean }> {
    const created = await withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO administrators (id, user_id, email, role, bootstrap)
         VALUES ($1, $2, $3, 'owner', true)
         ON CONFLICT DO NOTHING`,
        [newId(), userId, email],
      );

      if (rowCount === 1) {
        await this.audit(
          { action: 'owner.bootstrapped', actorUserId: null, subjectUserId: userId },
          client,
        );
        return true;
      }
      return false;
    });

    const row = await this.findByUserId(userId);
    if (!row) {
      // Another identity won the bootstrap race; the caller is not an administrator.
      const existing = await this.firstBootstrapOwner();
      if (!existing) throw new Error('Bootstrap owner could not be read back');
      return { row: existing, created: false };
    }
    return { row, created };
  }

  async firstBootstrapOwner(): Promise<AdministratorRow | null> {
    const { rows } = await this.pool.query<AdministratorRow>(
      `SELECT ${COLUMNS} FROM administrators a WHERE a.bootstrap LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async list(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: AdministratorRow[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.pool.query<AdministratorRow>(
      `SELECT ${COLUMNS} FROM administrators a
        WHERE $1::text IS NULL OR lower(a.email) LIKE $1
        ORDER BY a.created_at ASC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM administrators
        WHERE $1::text IS NULL OR lower(email) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }

  async add(
    userId: string,
    email: string,
    role: AdminRole,
    grants: readonly string[],
  ): Promise<AdministratorRow> {
    await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO administrators (id, user_id, email, role) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [newId(), userId, email, role],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Administrator insert returned no row');
      await this.replaceGrants(id, grants, client);
    });

    const row = await this.findByUserId(userId);
    if (!row) throw new Error('Administrator could not be read back');
    return row;
  }

  /**
   * Applies a change while holding the whole administrators table against concurrent writes, so
   * the "last active owner" rule cannot be bypassed by two simultaneous requests.
   */
  async update(
    userId: string,
    patch: { role?: AdminRole; enabled?: boolean; grants?: readonly string[] },
    guard: (next: { role: AdminRole; enabled: boolean }, activeOwners: number) => void,
  ): Promise<AdministratorRow> {
    await withTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE administrators IN SHARE ROW EXCLUSIVE MODE');

      const { rows } = await client.query<{ id: string; role: AdminRole; enabled: boolean }>(
        'SELECT id, role, enabled FROM administrators WHERE user_id = $1',
        [userId],
      );
      const current = rows[0];
      if (!current) throw new Error('Administrator not found');

      const next = {
        role: patch.role ?? current.role,
        enabled: patch.enabled ?? current.enabled,
      };

      const { rows: ownerRows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM administrators
          WHERE role = 'owner' AND enabled AND user_id <> $1`,
        [userId],
      );
      guard(next, Number(ownerRows[0]?.count ?? 0));

      await client.query(
        'UPDATE administrators SET role = $2, enabled = $3, updated_at = now() WHERE user_id = $1',
        [userId, next.role, next.enabled],
      );

      if (patch.grants) await this.replaceGrants(current.id, patch.grants, client);
    });

    const row = await this.findByUserId(userId);
    if (!row) throw new Error('Administrator could not be read back');
    return row;
  }

  private async replaceGrants(
    administratorId: string,
    grants: readonly string[],
    client: PoolClient,
  ): Promise<void> {
    await client.query('DELETE FROM administrator_grants WHERE administrator_id = $1', [
      administratorId,
    ]);
    for (const service of grants) {
      await client.query(
        'INSERT INTO administrator_grants (administrator_id, service) VALUES ($1, $2)',
        [administratorId, service],
      );
    }
  }

  async audit(
    entry: {
      action: string;
      actorUserId: string | null;
      subjectUserId: string | null;
      details?: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `INSERT INTO admin_audit (id, action, actor_user_id, subject_user_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        newId(),
        entry.action,
        entry.actorUserId,
        entry.subjectUserId,
        JSON.stringify(entry.details ?? {}),
      ],
    );
  }

  async listAudit(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.pool.query(
      `SELECT id, action, actor_user_id, subject_user_id, details, created_at
         FROM admin_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
