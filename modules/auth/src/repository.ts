import type { Identity } from '@template/contracts/modules/auth';
import { sha256 } from './crypto.js';
import { randomUUID } from 'node:crypto';
import { withTransaction } from './db/pool.js';
import { type Pool, type PoolClient } from './db/database.js';

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
  /** Set by the panel for its owners: a protected identity is never blocked. */
  blocking_protected_at: Date | null;
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
    blockingProtectedAt: row.blocking_protected_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const IDENTITY_COLUMNS = `
  id, email, password_hash, email_verified_at, blocked_at, blocking_protected_at, created_at, last_login_at
`;

/**
 * Data access for the Auth schema only. Auth never reads or writes another module's schema:
 * everything it needs from elsewhere comes through contracts.
 *
 * A repository runs on the pool, or on one transaction's connection when `withTransaction` handed
 * it out. Every statement goes through `sql`, so the same method writes into whichever it was given.
 */
export class AuthRepository {
  constructor(private readonly pool: Pool, private readonly sql: Pool | PoolClient = pool) {}

  /**
   * A change and its audit entry commit together, or neither does — the record of a security
   * action is part of the action, not a note added afterwards. The procedure gets a repository bound
   * to one transaction; inside it, methods that would open their own transaction join this one.
   * Anything the database cannot roll back — a notification hand-off — belongs after this returns.
   */
  async withTransaction<T>(operation: (repo: AuthRepository) => Promise<T>): Promise<T> {
    if (this.sql !== this.pool) return operation(this);
    return withTransaction(this.pool, (client) => operation(new AuthRepository(this.pool, client)));
  }

  /** The repository's own transactional methods: a new transaction on the pool, or the one already open. */
  private inTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.sql !== this.pool) return handler(this.sql as PoolClient);
    return withTransaction(this.pool, handler);
  }

  async findIdentityById(id: string): Promise<IdentityRow | null> {
    const { rows } = await this.sql.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** One query for a page of ids. Unknown ones are simply not in the result. */
  async findIdentitiesByIds(ids: readonly string[]): Promise<IdentityRow[]> {
    if (ids.length === 0) return [];

    const { rows } = await this.sql.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows;
  }

  /** Blocked identities are included: an owner may well be looking for one to unblock. */
  async searchIdentities(query: string, limit: number): Promise<IdentityRow[]> {
    const { rows } = await this.sql.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities
        WHERE lower(email) LIKE $1 ORDER BY email ASC LIMIT $2`,
      [`%${query.toLowerCase()}%`, limit],
    );
    return rows;
  }

  async findIdentityByEmail(email: string): Promise<IdentityRow | null> {
    const { rows } = await this.sql.query<IdentityRow>(
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
    const { rows } = await this.sql.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities ORDER BY sequence ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async createIdentity(email: string, passwordHash: string): Promise<IdentityRow> {
    const { rows } = await this.sql.query<IdentityRow>(
      `INSERT INTO identities (id, email, password_hash) VALUES ($1, $2, $3)
       RETURNING ${IDENTITY_COLUMNS}`,
      [randomUUID(), email, passwordHash],
    );
    const row = rows[0];
    if (!row) throw new Error('Identity insert returned no row');
    return row;
  }

  async changePassword(identityId: string, expectedHash: string, passwordHash: string): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const identity = await this.lockIdentity(client, identityId);
      if (!identity || identity.blocked_at || identity.password_hash !== expectedHash) return false;
      await client.query('UPDATE identities SET password_hash = $2, updated_at = now() WHERE id = $1',
        [identityId, passwordHash]);
      await this.invalidateAccess(client, identityId);
      return true;
    });
  }

  async resetPassword(token: string, passwordHash: string): Promise<string | null> {
    return this.useToken(token, 'password-reset', async (client, consumed) => {
      await client.query('UPDATE identities SET password_hash = $2, updated_at = now() WHERE id = $1',
        [consumed.identity_id, passwordHash]);
      await this.invalidateAccess(client, consumed.identity_id);
      return consumed.identity_id;
    });
  }

  async verifyEmail(token: string): Promise<string | null> {
    return this.useToken(token, 'email-verification', async (client, consumed) => {
      await client.query('UPDATE identities SET email_verified_at = now(), updated_at = now() WHERE id = $1',
        [consumed.identity_id]);
      return consumed.identity_id;
    });
  }

  async confirmEmailChange(token: string): Promise<{ identityId: string; previousEmail: string; tokenId: string } | null> {
    return this.useToken(token, 'email-change', async (client, consumed, identity) => {
      if (typeof consumed.payload.email !== 'string') throw new Error('Invalid email-change token payload');
      await client.query(
        'UPDATE identities SET email = $2, email_verified_at = now(), updated_at = now() WHERE id = $1',
        [identity.id, consumed.payload.email]);
      await this.invalidateAccess(client, identity.id);
      return { identityId: identity.id, previousEmail: identity.email, tokenId: consumed.id };
    });
  }

  /**
   * Blocks or unblocks. The identity row is locked first, so a protection set or cleared by the
   * panel in another transaction is seen in order; a protected identity is never blocked.
   */
  async setBlocked(identityId: string, blocked: boolean): Promise<'done' | 'missing' | 'protected'> {
    return this.inTransaction(async (client) => {
      const identity = await this.lockIdentity(client, identityId);
      if (!identity) return 'missing';
      if (blocked && identity.blocking_protected_at !== null) return 'protected';
      await client.query(
        `UPDATE identities SET blocked_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1`, [identityId, blocked]);
      if (blocked) await this.invalidateAccess(client, identityId);
      return 'done';
    });
  }

  /** The panel's mark on its owners. Idempotent: setting what is already set is `unchanged`, so the caller can keep its audit quiet. */
  async setBlockingProtection(identityId: string, isProtected: boolean): Promise<'done' | 'unchanged' | 'missing'> {
    return this.inTransaction(async (client) => {
      const identity = await this.lockIdentity(client, identityId);
      if (!identity) return 'missing';
      if ((identity.blocking_protected_at !== null) === isProtected) return 'unchanged';
      await client.query(
        `UPDATE identities SET blocking_protected_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1`, [identityId, isProtected]);
      return 'done';
    });
  }

  async touchLogin(identityId: string): Promise<void> {
    await this.sql.query('UPDATE identities SET last_login_at = now() WHERE id = $1', [identityId]);
  }

  async listIdentities(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: (IdentityRow & { active_session_count: string })[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.sql.query<IdentityRow & { active_session_count: string }>(
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

    const { rows: countRows } = await this.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identities
        WHERE $1::text IS NULL OR lower(email) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }

  // --- Sessions -------------------------------------------------------------

  async createSession(
    expected: IdentityRow,
    token: string,
    ttlSeconds: number,
    userAgent: string | null,
  ): Promise<string | null> {
    return this.inTransaction(async (client) => {
      const identity = await this.lockIdentity(client, expected.id);
      if (!identity || identity.blocked_at || identity.password_hash !== expected.password_hash || identity.email !== expected.email) return null;
      const id = randomUUID();
      await client.query(
        `INSERT INTO sessions (id, identity_id, token_hash, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
        [id, expected.id, sha256(token), userAgent?.slice(0, USER_AGENT_MAX) ?? null, ttlSeconds]);
      return id;
    });
  }

  /** Resolves a live session and refreshes its last-seen stamp in one statement. */
  async resolveSession(token: string): Promise<{ session: SessionRow; identity: IdentityRow } | null> {
    const { rows } = await this.sql.query<SessionRow & IdentityRow & { session_id: string }>(
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
    const { rows } = await this.sql.query<SessionRow & { token_hash: string }>(
      `SELECT id, identity_id, token_hash, created_at, last_seen_at, expires_at, user_agent
         FROM sessions
        WHERE identity_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [identityId],
    );
    return rows;
  }

  async revokeSessionByToken(token: string): Promise<void> {
    await this.sql.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [sha256(token)],
    );
  }

  async revokeAllSessions(identityId: string): Promise<number> {
    const { rowCount } = await this.sql.query(
      'UPDATE sessions SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL',
      [identityId],
    );
    return rowCount ?? 0;
  }

  // --- Single-use tokens ----------------------------------------------------

  /**
   * `too-soon`: a live link of this purpose was issued inside `resendAfterSeconds` — the caller may say
   * so or stay quiet. `stale`: the account is gone, blocked, or its email or password moved since the
   * caller read them — sign in again.
   */
  async issueToken(
    identityId: string,
    purpose: TokenPurpose,
    token: string,
    ttlSeconds: number,
    options: {
      payload?: Record<string, unknown>;
      resendAfterSeconds?: number;
      email?: string;
      passwordHash?: string;
    } = {},
  ): Promise<'issued' | 'too-soon' | 'stale'> {
    return this.inTransaction(async (client) => {
      const identity = await this.lockIdentity(client, identityId);
      if (!identity || identity.blocked_at ||
          (options.email !== undefined && identity.email !== options.email) ||
          (options.passwordHash !== undefined && identity.password_hash !== options.passwordHash)) return 'stale';
      if (options.resendAfterSeconds) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM auth_tokens WHERE identity_id = $1 AND purpose = $2
             AND used_at IS NULL AND expires_at > now()
             AND created_at > now() - make_interval(secs => $3)`,
          [identityId, purpose, options.resendAfterSeconds]);
        if (rowCount) return 'too-soon';
      }
      await client.query(
        `UPDATE auth_tokens SET used_at = now()
          WHERE identity_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [identityId, purpose]);
      await client.query(
        `INSERT INTO auth_tokens (id, identity_id, purpose, token_hash, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now() + make_interval(secs => $6))`,
        [randomUUID(), identityId, purpose, sha256(token), JSON.stringify(options.payload ?? {}), ttlSeconds]);
      return 'issued';
    });
  }

  /**
   * Whether another account asked for an email change to this address inside the window. Counted
   * whatever became of the link — replaced or used — so many accounts cannot take turns at one mailbox.
   */
  async recentEmailChangeTo(email: string, exceptIdentityId: string, windowSeconds: number): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      `SELECT 1 FROM auth_tokens
        WHERE purpose = 'email-change' AND payload->>'email' = $1 AND identity_id <> $2
          AND created_at > now() - make_interval(secs => $3)
        LIMIT 1`,
      [email, exceptIdentityId, windowSeconds]);
    return Boolean(rowCount);
  }

  private async lockIdentity(client: PoolClient, identityId: string): Promise<IdentityRow | null> {
    const { rows } = await client.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = $1 FOR UPDATE`, [identityId]);
    return rows[0] ?? null;
  }

  // All credentials operations lock the identity first, then its tokens and sessions.
  private async useToken<T>(
    token: string,
    purpose: TokenPurpose,
    apply: (client: PoolClient, consumed: AuthTokenRow, identity: IdentityRow) => Promise<T>,
  ): Promise<T | null> {
    return this.inTransaction(async (client) => {
      const hash = sha256(token);
      const { rows: candidates } = await client.query<{ identity_id: string }>(
        'SELECT identity_id FROM auth_tokens WHERE token_hash = $1 AND purpose = $2', [hash, purpose]);
      const candidate = candidates[0];
      if (!candidate) return null;
      const identity = await this.lockIdentity(client, candidate.identity_id);
      if (!identity || identity.blocked_at) return null;
      const { rows } = await client.query<AuthTokenRow>(
        `UPDATE auth_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING id, identity_id, purpose, payload, expires_at`, [hash, purpose]);
      return rows[0] ? apply(client, rows[0], identity) : null;
    });
  }

  private async invalidateAccess(client: PoolClient, identityId: string): Promise<void> {
    await client.query('UPDATE auth_tokens SET used_at = now() WHERE identity_id = $1 AND used_at IS NULL', [identityId]);
    await client.query('UPDATE sessions SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL', [identityId]);
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
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO auth_audit (id, identity_id, action, actor_user_id, actor_role, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        randomUUID(),
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

    const { rows } = await this.sql.query(
      `SELECT id, identity_id, action, actor_user_id, actor_role, details, created_at
         FROM auth_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );

    const { rows: countRows } = await this.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_audit
        WHERE $1::text IS NULL OR lower(action) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
