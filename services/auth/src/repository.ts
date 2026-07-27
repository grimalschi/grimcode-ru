import type { Identity } from '@template/contracts';
import { newId, sha256, withTransaction, type Pool, type PoolClient } from '@template/shared';

/**
 * As much of a User-Agent as the session listing carries.
 *
 * Beyond this it is noise, and storing more than the contract allows made the listing fail
 * validation rather than show the sessions — the screen someone opens precisely when they suspect
 * one of them is not theirs.
 */
const USER_AGENT_MAX = 400;

export type TokenPurpose = 'email-verification' | 'password-reset' | 'email-change';

export interface IdentityRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  blocked_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
}

export interface SessionRow {
  id: string;
  identity_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string | null;
}

export interface AuthTokenRow {
  id: string;
  identity_id: string;
  purpose: TokenPurpose;
  payload: Record<string, unknown>;
  expires_at: Date;
}

export function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    blockedAt: row.blocked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const IDENTITY_COLUMNS = `
  id, email, password_hash, email_verified_at, blocked_at, created_at, last_login_at
`;

/**
 * Data access for the Auth database only. Auth never reads or writes another service's database:
 * everything it needs from elsewhere comes through contracts.
 */
export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findIdentityById(id: string): Promise<IdentityRow | null> {
    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** One query for a page of ids. Unknown ones are simply not in the result. */
  async findIdentitiesByIds(ids: readonly string[]): Promise<IdentityRow[]> {
    if (ids.length === 0) return [];

    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows;
  }

  /** Blocked identities are included: an owner may well be looking for one to unblock. */
  async searchIdentities(query: string, limit: number): Promise<IdentityRow[]> {
    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities
        WHERE lower(email) LIKE $1 ORDER BY email ASC LIMIT $2`,
      [`%${query.toLowerCase()}%`, limit],
    );
    return rows;
  }

  async findIdentityByEmail(email: string): Promise<IdentityRow | null> {
    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE email = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  /**
   * Earliest registered identity in a deterministic order.
   *
   * Admin uses this to bootstrap the very first owner, so the order must never depend on clock
   * resolution or row layout — it follows the identity sequence.
   */
  async findFirstIdentity(): Promise<IdentityRow | null> {
    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities ORDER BY sequence ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async createIdentity(email: string, passwordHash: string): Promise<IdentityRow> {
    const { rows } = await this.pool.query<IdentityRow>(
      `INSERT INTO identities (id, email, password_hash) VALUES ($1, $2, $3)
       RETURNING ${IDENTITY_COLUMNS}`,
      [newId(), email, passwordHash],
    );
    const row = rows[0];
    if (!row) throw new Error('Identity insert returned no row');
    return row;
  }

  async setPasswordHash(identityId: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE identities SET password_hash = $2, updated_at = now() WHERE id = $1',
      [identityId, passwordHash],
    );
  }

  async markEmailVerified(identityId: string): Promise<void> {
    await this.pool.query(
      'UPDATE identities SET email_verified_at = now(), updated_at = now() WHERE id = $1',
      [identityId],
    );
  }

  async setEmail(identityId: string, email: string): Promise<void> {
    await this.pool.query(
      `UPDATE identities
         SET email = $2, email_verified_at = now(), updated_at = now()
       WHERE id = $1`,
      [identityId, email],
    );
  }

  async setBlocked(identityId: string, blocked: boolean): Promise<IdentityRow | null> {
    const { rows } = await this.pool.query<IdentityRow>(
      `UPDATE identities SET blocked_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1 RETURNING ${IDENTITY_COLUMNS}`,
      [identityId, blocked],
    );
    return rows[0] ?? null;
  }

  async touchLogin(identityId: string): Promise<void> {
    await this.pool.query('UPDATE identities SET last_login_at = now() WHERE id = $1', [identityId]);
  }

  async listIdentities(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: (IdentityRow & { active_session_count: string })[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.pool.query<IdentityRow & { active_session_count: string }>(
      `SELECT ${IDENTITY_COLUMNS},
              (SELECT count(*) FROM sessions s
                WHERE s.identity_id = i.id AND s.revoked_at IS NULL AND s.expires_at > now())
                AS active_session_count
         FROM identities i
        WHERE $1::text IS NULL OR lower(i.email) LIKE $1
        ORDER BY sequence DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identities
        WHERE $1::text IS NULL OR lower(email) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }

  // --- Sessions -------------------------------------------------------------

  async createSession(
    identityId: string,
    token: string,
    ttlSeconds: number,
    userAgent: string | null,
  ): Promise<string> {
    const id = newId();
    await this.pool.query(
      `INSERT INTO sessions (id, identity_id, token_hash, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [id, identityId, sha256(token), userAgent?.slice(0, USER_AGENT_MAX) ?? null, ttlSeconds],
    );
    return id;
  }

  /** Resolves a live session and refreshes its last-seen stamp in one statement. */
  async resolveSession(token: string): Promise<{ session: SessionRow; identity: IdentityRow } | null> {
    const { rows } = await this.pool.query<SessionRow & IdentityRow & { session_id: string }>(
      `UPDATE sessions s
          SET last_seen_at = now()
        FROM identities i
        WHERE s.token_hash = $1
          AND s.identity_id = i.id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
      RETURNING s.id AS session_id, s.identity_id, s.created_at AS session_created_at,
                s.last_seen_at, s.expires_at, s.user_agent,
                i.id, i.email, i.password_hash, i.email_verified_at, i.blocked_at,
                i.created_at, i.last_login_at`,
      [sha256(token)],
    );

    const row = rows[0] as (SessionRow & IdentityRow & Record<string, unknown>) | undefined;
    if (!row) return null;

    return {
      session: {
        id: String(row.session_id),
        identity_id: row.identity_id,
        created_at: row.session_created_at as Date,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        user_agent: row.user_agent,
      },
      identity: row,
    };
  }

  async listSessions(identityId: string): Promise<(SessionRow & { token_hash: string })[]> {
    const { rows } = await this.pool.query<SessionRow & { token_hash: string }>(
      `SELECT id, identity_id, token_hash, created_at, last_seen_at, expires_at, user_agent
         FROM sessions
        WHERE identity_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [identityId],
    );
    return rows;
  }

  async revokeSessionByToken(token: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [sha256(token)],
    );
  }

  async revokeAllSessions(identityId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL',
      [identityId],
    );
    return rowCount ?? 0;
  }

  // --- Single-use tokens ----------------------------------------------------

  async issueToken(
    identityId: string,
    purpose: TokenPurpose,
    token: string,
    ttlSeconds: number,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // A new token of the same purpose invalidates the previous outstanding ones.
      await client.query(
        `UPDATE auth_tokens SET used_at = now()
          WHERE identity_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [identityId, purpose],
      );
      await client.query(
        `INSERT INTO auth_tokens (id, identity_id, purpose, token_hash, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now() + make_interval(secs => $6))`,
        [newId(), identityId, purpose, sha256(token), JSON.stringify(payload), ttlSeconds],
      );
    });
  }

  /** Atomically consumes a token, so a link works exactly once even under a double click. */
  async consumeToken(token: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
    const { rows } = await this.pool.query<AuthTokenRow>(
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING id, identity_id, purpose, payload, expires_at`,
      [sha256(token), purpose],
    );
    return rows[0] ?? null;
  }

  async revokeTokens(identityId: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_tokens SET used_at = now() WHERE identity_id = $1 AND used_at IS NULL',
      [identityId],
    );
  }

  // --- Audit ----------------------------------------------------------------

  async audit(
    entry: {
      identityId: string | null;
      action: string;
      actorUserId?: string | null;
      actorRole?: string | null;
      details?: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `INSERT INTO auth_audit (id, identity_id, action, actor_user_id, actor_role, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        newId(),
        entry.identityId,
        entry.action,
        entry.actorUserId ?? null,
        entry.actorRole ?? null,
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
      `SELECT id, identity_id, action, actor_user_id, actor_role, details, created_at
         FROM auth_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
