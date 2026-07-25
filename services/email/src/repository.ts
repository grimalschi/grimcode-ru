import { EDITOR_FORMAT } from '@template/contracts';
import { newId, withTransaction, type Pool, type PoolClient } from '@template/shared';

import { SEED_TEMPLATES } from './seed.js';
import type { EditorDocument } from './types.js';

export interface TemplateRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  variables: string[];
  created_at: Date;
  updated_at: Date;
}

export interface VersionRow {
  id: string;
  template_id: string;
  locale: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  subject: string;
  editor_format: string;
  editor_document: EditorDocument;
  compiled_html: string | null;
  compiled_text: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryRow {
  id: string;
  dedupe_key: string;
  template_key: string;
  template_version_id: string | null;
  locale: string;
  recipient_email: string;
  subject: string;
  html: string;
  text: string;
  transport: 'log' | 'unisender';
  status: 'queued' | 'sent' | 'failed' | 'suppressed';
  provider_message_id: string | null;
  provider_status: string | null;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

const TEMPLATE_COLUMNS = 'id, key, name, description, variables, created_at, updated_at';
const VERSION_COLUMNS = `
  id, template_id, locale, version, status, subject, editor_format, editor_document,
  compiled_html, compiled_text, published_at, created_at, updated_at
`;
const DELIVERY_COLUMNS = `
  id, dedupe_key, template_key, template_version_id, locale, recipient_email, subject, html, text,
  transport, status, provider_message_id, provider_status, error, created_at, sent_at
`;

export class EmailRepository {
  constructor(private readonly pool: Pool) {}

  // --- Templates ------------------------------------------------------------

  async findTemplateById(id: string): Promise<TemplateRow | null> {
    const { rows } = await this.pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findTemplateByKey(key: string): Promise<TemplateRow | null> {
    const { rows } = await this.pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE key = $1`,
      [key],
    );
    return rows[0] ?? null;
  }

  async listTemplates(
    query: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ rows: TemplateRow[]; total: number }> {
    const filter = query ? `%${query.toLowerCase()}%` : null;

    const { rows } = await this.pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM templates
        WHERE $1::text IS NULL OR lower(key) LIKE $1 OR lower(name) LIKE $1
        ORDER BY key ASC LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM templates
        WHERE $1::text IS NULL OR lower(key) LIKE $1 OR lower(name) LIKE $1`,
      [filter],
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }

  async createTemplate(
    key: string,
    name: string,
    description: string | null,
    variables: readonly string[],
  ): Promise<TemplateRow> {
    const { rows } = await this.pool.query<TemplateRow>(
      `INSERT INTO templates (id, key, name, description, variables)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${TEMPLATE_COLUMNS}`,
      [newId(), key, name, description, JSON.stringify(variables)],
    );
    const row = rows[0];
    if (!row) throw new Error('Template insert returned no row');
    return row;
  }

  async updateTemplate(
    id: string,
    patch: { name?: string; description?: string | null; variables?: readonly string[] },
  ): Promise<TemplateRow> {
    const { rows } = await this.pool.query<TemplateRow>(
      `UPDATE templates
          SET name        = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              variables   = COALESCE($5::jsonb, variables),
              updated_at  = now()
        WHERE id = $1 RETURNING ${TEMPLATE_COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.variables ? JSON.stringify(patch.variables) : null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Template not found');
    return row;
  }

  // --- Versions -------------------------------------------------------------

  async findVersion(id: string): Promise<VersionRow | null> {
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM template_versions WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listVersions(templateId: string): Promise<VersionRow[]> {
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM template_versions
        WHERE template_id = $1 ORDER BY locale ASC, version DESC`,
      [templateId],
    );
    return rows;
  }

  /** The version runtime delivery must use: the published one for that template and locale. */
  async findPublished(templateKey: string, locale: string): Promise<VersionRow | null> {
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT v.id, v.template_id, v.locale, v.version, v.status, v.subject, v.editor_format,
              v.editor_document, v.compiled_html, v.compiled_text, v.published_at,
              v.created_at, v.updated_at
         FROM template_versions v
         JOIN templates t ON t.id = v.template_id
        WHERE t.key = $1 AND v.locale = $2 AND v.status = 'published'`,
      [templateKey, locale],
    );
    return rows[0] ?? null;
  }

  /** Creates a draft, copying the newest version of the same locale when one exists. */
  async createDraft(
    templateId: string,
    locale: string,
    fallback: { subject: string; document: EditorDocument },
  ): Promise<VersionRow> {
    return withTransaction(this.pool, async (client) => {
      const { rows: latest } = await client.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM template_versions
          WHERE template_id = $1 AND locale = $2 ORDER BY version DESC LIMIT 1`,
        [templateId, locale],
      );

      const previous = latest[0];
      const nextVersion = (previous?.version ?? 0) + 1;

      const { rows } = await client.query<VersionRow>(
        `INSERT INTO template_versions
           (id, template_id, locale, version, status, subject, editor_format, editor_document)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7::jsonb)
         RETURNING ${VERSION_COLUMNS}`,
        [
          newId(),
          templateId,
          locale,
          nextVersion,
          previous?.subject ?? fallback.subject,
          EDITOR_FORMAT,
          JSON.stringify(previous?.editor_document ?? fallback.document),
        ],
      );

      const row = rows[0];
      if (!row) throw new Error('Draft insert returned no row');
      return row;
    });
  }

  async saveDraft(id: string, subject: string, document: EditorDocument): Promise<VersionRow> {
    const { rows } = await this.pool.query<VersionRow>(
      `UPDATE template_versions
          SET subject = $2, editor_document = $3::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'draft'
      RETURNING ${VERSION_COLUMNS}`,
      [id, subject, JSON.stringify(document)],
    );
    const row = rows[0];
    if (!row) throw new Error('Only a draft can be edited');
    return row;
  }

  /**
   * Publishes a draft together with the HTML and text the server produced.
   *
   * The previously published version of the same locale is archived in the same transaction, so
   * the partial unique index always sees exactly one published version.
   */
  async publish(id: string, compiled: { html: string; text: string }): Promise<VersionRow> {
    return withTransaction(this.pool, async (client) => {
      const { rows: current } = await client.query<{ template_id: string; locale: string }>(
        `SELECT template_id, locale FROM template_versions WHERE id = $1 AND status = 'draft'`,
        [id],
      );
      const target = current[0];
      if (!target) throw new Error('Only a draft can be published');

      await client.query(
        `UPDATE template_versions SET status = 'archived', updated_at = now()
          WHERE template_id = $1 AND locale = $2 AND status = 'published'`,
        [target.template_id, target.locale],
      );

      const { rows } = await client.query<VersionRow>(
        `UPDATE template_versions
            SET status = 'published', compiled_html = $2, compiled_text = $3,
                published_at = now(), updated_at = now()
          WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
        [id, compiled.html, compiled.text],
      );

      const row = rows[0];
      if (!row) throw new Error('Publish returned no row');
      return row;
    });
  }

  // --- Deliveries -----------------------------------------------------------

  /**
   * Records the message about to be sent, or reports the one already recorded.
   *
   * The snapshot is written *before* the transport runs, so a message that leaves the system is
   * never missing from the log.
   */
  async openDelivery(input: {
    dedupeKey: string;
    templateKey: string;
    templateVersionId: string | null;
    locale: string;
    recipientEmail: string;
    subject: string;
    html: string;
    text: string;
    transport: 'log' | 'unisender';
  }): Promise<{ row: DeliveryRow; created: boolean }> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `INSERT INTO deliveries
         (id, dedupe_key, template_key, template_version_id, locale, recipient_email,
          subject, html, text, transport)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${DELIVERY_COLUMNS}`,
      [
        newId(),
        input.dedupeKey,
        input.templateKey,
        input.templateVersionId,
        input.locale,
        input.recipientEmail,
        input.subject,
        input.html,
        input.text,
        input.transport,
      ],
    );

    const inserted = rows[0];
    if (inserted) return { row: inserted, created: true };

    const existing = await this.findDeliveryByDedupeKey(input.dedupeKey);
    if (!existing) throw new Error('Delivery conflicted but could not be read back');
    return { row: existing, created: false };
  }

  async findDeliveryByDedupeKey(dedupeKey: string): Promise<DeliveryRow | null> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    return rows[0] ?? null;
  }

  async findDelivery(id: string): Promise<DeliveryRow | null> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async markSent(
    id: string,
    result: { providerMessageId: string | null; providerStatus: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries
          SET status = 'sent', sent_at = now(), provider_message_id = $2, provider_status = $3,
              error = NULL
        WHERE id = $1`,
      [id, result.providerMessageId, result.providerStatus],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
      id,
      error.slice(0, 2000),
    ]);
  }

  async listDeliveries(
    filters: { query?: string; status?: string },
    limit: number,
    offset: number,
  ): Promise<{ rows: DeliveryRow[]; total: number }> {
    const search = filters.query ? `%${filters.query.toLowerCase()}%` : null;
    const params = [search, filters.status ?? null];
    const where = `
      WHERE ($1::text IS NULL OR lower(recipient_email) LIKE $1 OR lower(subject) LIKE $1)
        AND ($2::text IS NULL OR status = $2)
    `;

    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries ${where}
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [...params, limit, offset],
    );
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deliveries ${where}`,
      params,
    );

    return { rows, total: Number(countRows[0]?.count ?? 0) };
  }

  // --- Audit and seeding ----------------------------------------------------

  async audit(
    entry: {
      action: string;
      actorUserId: string | null;
      actorRole: string | null;
      details?: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<void> {
    await (client ?? this.pool).query(
      `INSERT INTO email_audit (id, action, actor_user_id, actor_role, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        newId(),
        entry.action,
        entry.actorUserId,
        entry.actorRole,
        JSON.stringify(entry.details ?? {}),
      ],
    );
  }

  /**
   * Creates the seed templates that are still missing, as ready published versions.
   *
   * Idempotent: an existing template is never overwritten, so local edits survive a restart.
   * Returns how many templates were created.
   */
  async ensureSeedTemplates(
    compile: (
      document: EditorDocument,
      subject: string,
      variables: readonly string[],
    ) => Promise<{ html: string; text: string }>,
  ): Promise<number> {
    let created = 0;

    for (const seed of SEED_TEMPLATES) {
      if (await this.findTemplateByKey(seed.key)) continue;

      const template = await this.createTemplate(
        seed.key,
        seed.name,
        seed.description,
        seed.variables,
      );
      const draft = await this.createDraft(template.id, seed.locale, {
        subject: seed.subject,
        document: seed.document,
      });
      await this.saveDraft(draft.id, seed.subject, seed.document);

      const compiled = await compile(seed.document, seed.subject, seed.variables);
      await this.publish(draft.id, compiled);
      created += 1;
    }

    return created;
  }
}
