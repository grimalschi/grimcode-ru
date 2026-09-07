import { newId, type Pool } from '@template/shared';

export interface EventRow {
  id: string;
  type: string;
  dedupe_key: string;
  recipient_email: string;
  payload: Record<string, unknown>;
  status: 'accepted' | 'routed' | 'failed';
  error: string | null;
  delivery_id: string | null;
  created_at: Date;
  routed_at: Date | null;
}

const COLUMNS = `
  id, type, dedupe_key, recipient_email, payload, status, error, delivery_id, created_at, routed_at
`;

export class NotificationsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Accepts an event, or reports the already stored one.
   *
   * `ON CONFLICT DO NOTHING` plus the unique index on `dedupe_key` is what makes a repeated
   * delivery harmless — the second call never produces a second routing.
   */
  async accept(
    type: string,
    dedupeKey: string,
    recipientEmail: string,
    payload: Record<string, unknown>,
  ): Promise<{ row: EventRow; created: boolean }> {
    const { rows } = await this.pool.query<EventRow>(
      `INSERT INTO events (id, type, dedupe_key, recipient_email, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [newId(), type, dedupeKey, recipientEmail, JSON.stringify(payload)],
    );

    const inserted = rows[0];
    if (inserted) return { row: inserted, created: true };

    const existing = await this.findByDedupeKey(dedupeKey);
    if (!existing) throw new Error('Event conflicted but could not be read back');
    return { row: existing, created: false };
  }

  async findByDedupeKey(dedupeKey: string): Promise<EventRow | null> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLUMNS} FROM events WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<EventRow | null> {
    const { rows } = await this.pool.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  async markRouted(id: string, deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE events SET status = 'routed', delivery_id = $2, routed_at = now(), error = NULL
        WHERE id = $1`,
      [id, deliveryId],
    );
  }


  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE events SET status = 'failed', error = $2 WHERE id = $1`, [
      id,
      error.slice(0, 1000),
    ]);
  }

  async list(
    filters: { query?: string; type?: string; status?: string },
    limit: number,
    offset: number,
  ): Promise<{ rows: EventRow[]; total: number }> {
    const search = filters.query ? `%${filters.query.toLowerCase()}%` : null;
    const params = [search, filters.type ?? null, filters.status ?? null];

    const where = `
      WHERE ($1::text IS NULL OR lower(recipient_email) LIKE $1)
        AND ($2::text IS NULL OR type = $2)
        AND ($3::text IS NULL OR status = $3)
    `;

    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLUMNS} FROM events ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [...params, limit, offset],
    );

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events ${where}`,
      params,
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }
}
