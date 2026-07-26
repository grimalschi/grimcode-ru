import type { UserProfile } from '@template/contracts';
import { newId, type Pool } from '@template/shared';

export interface ProfileRow {
  id: string;
  identity_id: string;
  display_name: string | null;
  time_zone: string | null;
  locale: string;
  theme: 'light' | 'dark' | 'system';
  product_emails: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, identity_id, display_name, time_zone, locale, theme, product_emails,
  created_at, updated_at
`;

export function toProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    identityId: row.identity_id,
    displayName: row.display_name,
    timeZone: row.time_zone,
    preferences: {
      locale: row.locale,
      theme: row.theme,
      productEmails: row.product_emails,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Data access for the Users database only. */
export class UsersRepository {
  constructor(private readonly pool: Pool) {}

  async findByIdentityId(identityId: string): Promise<ProfileRow | null> {
    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM profiles WHERE identity_id = $1`,
      [identityId],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<ProfileRow | null> {
    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM profiles WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Idempotent: a profile is created on first access and concurrent first requests converge on
   * the same row thanks to the unique constraint on `identity_id`.
   */
  async ensure(identityId: string): Promise<ProfileRow> {
    const { rows } = await this.pool.query<ProfileRow>(
      `INSERT INTO profiles (id, identity_id) VALUES ($1, $2)
       ON CONFLICT (identity_id) DO UPDATE SET identity_id = EXCLUDED.identity_id
       RETURNING ${COLUMNS}`,
      [newId(), identityId],
    );
    const row = rows[0];
    if (!row) throw new Error('Profile upsert returned no row');
    return row;
  }

  async updateProfile(
    identityId: string,
    patch: { displayName?: string | null; timeZone?: string | null },
  ): Promise<ProfileRow> {
    const { rows } = await this.pool.query<ProfileRow>(
      `UPDATE profiles
          SET display_name = COALESCE($2, display_name),
              time_zone    = COALESCE($3, time_zone),
              updated_at   = now()
        WHERE identity_id = $1
      RETURNING ${COLUMNS}`,
      [identityId, patch.displayName ?? null, patch.timeZone ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Profile not found');
    return row;
  }

  async updatePreferences(
    identityId: string,
    patch: { locale?: string; theme?: 'light' | 'dark' | 'system'; productEmails?: boolean },
  ): Promise<ProfileRow> {
    const { rows } = await this.pool.query<ProfileRow>(
      `UPDATE profiles
          SET locale         = COALESCE($2, locale),
              theme          = COALESCE($3, theme),
              product_emails = COALESCE($4, product_emails),
              updated_at     = now()
        WHERE identity_id = $1
      RETURNING ${COLUMNS}`,
      [identityId, patch.locale ?? null, patch.theme ?? null, patch.productEmails ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Profile not found');
    return row;
  }

  async list(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: ProfileRow[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM profiles
        WHERE $1::text IS NULL OR lower(display_name) LIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM profiles
        WHERE $1::text IS NULL OR lower(display_name) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
