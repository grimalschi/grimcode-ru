import type { Administrator, AdminRole } from '@template/contracts/modules/admin';
import { randomUUID } from 'node:crypto';
import { withTransaction } from './db/pool.js';
import { type Pool, type PoolClient } from './db/database.js';

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
  ARRAY(SELECT g.module FROM administrator_grants g
         WHERE g.administrator_id = a.id ORDER BY g.module) AS grants
`;

export function toAdministrator(row: AdministratorRow): Administrator {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    enabled: row.enabled,
    grants: (row.grants ?? []) as string[],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class AdminRepository {
  constructor(private readonly pool: Pool, private readonly sql: Pool | PoolClient = pool) {}

  async isRegistryEmpty(): Promise<boolean> {
    const { rows } = await this.sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM administrators',
    );
    return Number(rows[0]?.count ?? 0) === 0;
  }

  async findByUserId(userId: string): Promise<AdministratorRow | null> {
    const { rows } = await this.sql.query<AdministratorRow>(
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
        [randomUUID(), userId, email],
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
    const { rows } = await this.sql.query<AdministratorRow>(
      `SELECT ${COLUMNS} FROM administrators a WHERE a.bootstrap LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async list(): Promise<AdministratorRow[]> {
    const { rows } = await this.sql.query<AdministratorRow>(
      `SELECT ${COLUMNS} FROM administrators a ORDER BY a.created_at ASC, a.id ASC`,
    );
    return rows;
  }

  async withRegistryLock<T>(operation: (repo: AdminRepository) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE administrators IN SHARE ROW EXCLUSIVE MODE');
      return operation(new AdminRepository(this.pool, client));
    });
  }

  /** Called inside withRegistryLock so the administrator, grants and audit commit together. */
  async add(
    userId: string,
    email: string,
    role: AdminRole,
    grants: readonly string[],
  ): Promise<AdministratorRow> {
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO administrators (id, user_id, email, role) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [randomUUID(), userId, email, role],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Administrator insert returned no row');
    await this.replaceGrants(id, grants, this.sql);

    const row = await this.findByUserId(userId);
    if (!row) throw new Error('Administrator could not be read back');
    return row;
  }

  /** Owners other than this one, as this registry sees them. Whether they can sign in is Auth's fact. */
  async otherActiveOwnerIds(userId: string): Promise<string[]> {
    const { rows } = await this.sql.query<{ user_id: string }>(
      `SELECT user_id FROM administrators
        WHERE role = 'owner' AND enabled AND user_id <> $1`,
      [userId],
    );
    return rows.map((row) => row.user_id);
  }

  /** Called inside withRegistryLock after Auth resolves the remaining owners. */
  async update(
    userId: string,
    patch: { role?: AdminRole; enabled?: boolean; grants?: readonly string[] },
    guard: (next: { role: AdminRole; enabled: boolean }, activeOwners: number) => void,
    eligibleOwnerIds: readonly string[],
  ): Promise<AdministratorRow> {
    const client = this.sql;
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
        WHERE role = 'owner' AND enabled AND user_id <> $1 AND user_id = ANY($2)`,
      [userId, eligibleOwnerIds],
    );
    guard(next, Number(ownerRows[0]?.count ?? 0));

    await client.query(
      'UPDATE administrators SET role = $2, enabled = $3, updated_at = now() WHERE user_id = $1',
      [userId, next.role, next.enabled],
    );

    if (patch.grants) await this.replaceGrants(current.id, patch.grants, client);

    const row = await this.findByUserId(userId);
    if (!row) throw new Error('Administrator could not be read back');
    return row;
  }

  private async replaceGrants(
    administratorId: string,
    grants: readonly string[],
    client: Pick<PoolClient, 'query'>,
  ): Promise<void> {
    await client.query('DELETE FROM administrator_grants WHERE administrator_id = $1', [
      administratorId,
    ]);
    for (const module of grants) {
      await client.query(
        'INSERT INTO administrator_grants (administrator_id, module) VALUES ($1, $2)',
        [administratorId, module],
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
    const runner = client ?? this.sql;
    await runner.query(
      `INSERT INTO admin_audit (id, action, actor_user_id, subject_user_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        randomUUID(),
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

    const { rows } = await this.sql.query(
      `SELECT id, action, actor_user_id, subject_user_id, details, created_at
         FROM admin_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
