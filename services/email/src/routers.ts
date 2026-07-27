import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  EDITOR_FORMAT,
  emailAdminContract,
  emailInternalContract,
  type AdminContext,
} from '@template/contracts';
import { isCsrfValid, type Logger } from '@template/shared';

import { sendTemplate, UnknownTemplateError } from './delivery.js';
import type { EmailRepository, TemplateRow, VersionRow } from './repository.js';
import {
  assertDeclaredVariables,
  redactOneTimeTokens,
  renderMessage,
  TemplateRenderError,
  type VariableValue,
} from './render.js';
import type { Transport } from './transport.js';

export interface InternalContext {
  repo: EmailRepository;
  transport: Transport;
  logger: Logger;
}

export interface AdminRpcContext {
  repo: EmailRepository;
  transport: Transport;
  logger: Logger;
  request: Request;
  admin: AdminContext | null;
}

function toTemplate(row: TemplateRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    variables: row.variables ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersion(row: VersionRow) {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    status: row.status,
    subject: row.subject,
    editorFormat: EDITOR_FORMAT,
    editorDocument: row.editor_document,
    compiledHtml: row.compiled_html,
    compiledText: row.compiled_text,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const internalOs = implement(emailInternalContract).$context<InternalContext>();

export const internalRouter = internalOs.router({
  send: internalOs.send.handler(async ({ input, context }) => {
    try {
      const result = await sendTemplate(input, context);
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof UnknownTemplateError) {
        throw new ORPCError('NOT_FOUND', { message: error.message });
      }
      throw error;
    }
  }),
});

const adminOs = implement(emailAdminContract).$context<AdminRpcContext>();

function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Контекст администратора отсутствует' });
  return context.admin;
}

function requireMutation(context: AdminRpcContext): AdminContext {
  const admin = requireAdmin(context);
  if (!isCsrfValid(context.request.headers, 'email')) {
    throw new ORPCError('FORBIDDEN', { message: 'CSRF-токен отсутствует или неверен' });
  }
  return admin;
}

async function loadVersion(repo: EmailRepository, id: string): Promise<VersionRow> {
  const row = await repo.findVersion(id);
  if (!row) throw new ORPCError('NOT_FOUND', { message: 'Версия шаблона не найдена' });
  return row;
}

function renderFailure(error: unknown): never {
  if (error instanceof TemplateRenderError) {
    throw new ORPCError('BAD_REQUEST', { message: error.message });
  }
  throw error;
}

export const adminRouter = adminOs.router({
  listTemplates: adminOs.listTemplates.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.listTemplates(input.query, input.limit, input.offset);
    return { items: rows.map(toTemplate), total, limit: input.limit, offset: input.offset };
  }),

  getTemplate: adminOs.getTemplate.handler(async ({ input, context }) => {
    requireAdmin(context);
    const template = await context.repo.findTemplateById(input.id);
    if (!template) throw new ORPCError('NOT_FOUND', { message: 'Шаблон не найден' });

    const versions = await context.repo.listVersions(template.id);
    return {
      template: toTemplate(template),
      // The list omits the editor document; it is fetched per version when the editor opens.
      versions: versions.map((row) => {
        const { editorDocument: _editorDocument, ...rest } = toVersion(row);
        return rest;
      }),
    };
  }),

  createTemplate: adminOs.createTemplate.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    if (await context.repo.findTemplateByKey(input.key)) {
      throw new ORPCError('CONFLICT', { message: 'Шаблон с таким ключом уже есть' });
    }

    const row = await context.repo.createTemplate(
      input.key,
      input.name,
      input.description,
      input.variables,
    );
    await context.repo.audit({
      action: 'template.created',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { key: input.key },
    });

    return { ok: true as const, template: toTemplate(row) };
  }),

  updateTemplate: adminOs.updateTemplate.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const row = await context.repo.updateTemplate(input.id, input);
    await context.repo.audit({
      action: 'template.updated',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { key: row.key },
    });
    return { ok: true as const, template: toTemplate(row) };
  }),

  getVersion: adminOs.getVersion.handler(async ({ input, context }) => {
    requireAdmin(context);
    return { version: toVersion(await loadVersion(context.repo, input.id)) };
  }),

  createDraft: adminOs.createDraft.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const template = await context.repo.findTemplateById(input.templateId);
    if (!template) throw new ORPCError('NOT_FOUND', { message: 'Шаблон не найден' });

    const row = await context.repo.createDraft(template.id, {
      subject: template.name,
      document: { type: 'doc', content: [] },
    });
    await context.repo.audit({
      action: 'version.draft.created',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { templateKey: template.key, version: row.version },
    });

    return { ok: true as const, version: toVersion(row) };
  }),

  saveDraft: adminOs.saveDraft.handler(async ({ input, context }) => {
    requireMutation(context);
    try {
      const row = await context.repo.saveDraft(input.id, input.subject, input.editorDocument);
      return { ok: true as const, version: toVersion(row) };
    } catch (error) {
      throw new ORPCError('BAD_REQUEST', {
        message: error instanceof Error ? error.message : 'Draft could not be saved',
      });
    }
  }),

  /**
   * Publishing is where the server takes over: it validates the document's variables, renders it,
   * sanitizes the HTML and derives the plain text from that HTML. Runtime delivery then only ever
   * sends this stored result.
   */
  publishDraft: adminOs.publishDraft.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const draft = await loadVersion(context.repo, input.id);

    const template = await context.repo.findTemplateById(draft.template_id);
    if (!template) throw new ORPCError('NOT_FOUND', { message: 'Шаблон не найден' });

    let compiled;
    try {
      assertDeclaredVariables(draft.editor_document, template.variables ?? []);
      compiled = await renderMessage(draft.editor_document, draft.subject);
    } catch (error) {
      renderFailure(error);
    }

    const row = await context.repo.publish(draft.id, {
      html: compiled.html,
      text: compiled.text,
    });

    await context.repo.audit({
      action: 'version.published',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { templateKey: template.key, version: row.version },
    });

    return { ok: true as const, version: toVersion(row) };
  }),

  previewVersion: adminOs.previewVersion.handler(async ({ input, context }) => {
    requireAdmin(context);
    const version = await loadVersion(context.repo, input.id);

    try {
      return await renderMessage(
        version.editor_document,
        version.subject,
        input.variables as Record<string, VariableValue>,
      );
    } catch (error) {
      renderFailure(error);
    }
  }),

  testSend: adminOs.testSend.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const version = await loadVersion(context.repo, input.id);
    const template = await context.repo.findTemplateById(version.template_id);
    if (!template) throw new ORPCError('NOT_FOUND', { message: 'Шаблон не найден' });

    let rendered;
    try {
      rendered = await renderMessage(
        version.editor_document,
        version.subject,
        input.variables as Record<string, VariableValue>,
      );
    } catch (error) {
      renderFailure(error);
    }

    // A test send is a real send: it goes through the transport and is recorded in the log with
    // the exact content that left the system.
    const dedupeKey = `test:${version.id}:${input.to}:${Date.now()}`;
    const { row } = await context.repo.openDelivery({
      dedupeKey,
      templateKey: template.key,
      templateVersionId: version.id,
      recipientEmail: input.to,
      subject: rendered.subject,
      html: redactOneTimeTokens(rendered.html),
      text: redactOneTimeTokens(rendered.text),
      transport: context.transport.name,
    });

    try {
      const result = await context.transport.send({ dedupeKey, to: input.to, ...rendered });
      await context.repo.markSent(row.id, result);
    } catch (error) {
      await context.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
    }

    await context.repo.audit({
      action: 'version.test-sent',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { templateKey: template.key, to: input.to },
    });

    return { ok: true as const, deliveryId: row.id };
  }),

  listDeliveries: adminOs.listDeliveries.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.listDeliveries(
      { query: input.query, status: input.status },
      input.limit,
      input.offset,
    );

    return {
      // The list never carries message bodies; they are fetched one at a time.
      items: rows.map((row) => ({
        id: row.id,
        templateKey: row.template_key,
        templateVersionId: row.template_version_id,
            recipientEmail: row.recipient_email,
        subject: row.subject,
        transport: row.transport,
        status: row.status,
        providerMessageId: row.provider_message_id,
        providerStatus: row.provider_status,
        error: row.error,
        createdAt: row.created_at.toISOString(),
        sentAt: row.sent_at?.toISOString() ?? null,
      })),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  }),

  /** The immutable snapshot of one actually sent message, body included. */
  getDelivery: adminOs.getDelivery.handler(async ({ input, context }) => {
    requireAdmin(context);
    const row = await context.repo.findDelivery(input.id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: 'Отправка не найдена' });

    return {
      delivery: {
        id: row.id,
        templateKey: row.template_key,
        templateVersionId: row.template_version_id,
            recipientEmail: row.recipient_email,
        subject: row.subject,
        html: row.html,
        text: row.text,
        transport: row.transport,
        status: row.status,
        providerMessageId: row.provider_message_id,
        providerStatus: row.provider_status,
        error: row.error,
        createdAt: row.created_at.toISOString(),
        sentAt: row.sent_at?.toISOString() ?? null,
      },
    };
  }),

  uploadImage: adminOs.uploadImage.handler(async ({ input, context }) => {
    requireMutation(context);

    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > 2_000_000) {
      throw new ORPCError('BAD_REQUEST', { message: 'Изображение не больше 2 МБ' });
    }

    // The template stores images inline in the document, so nothing has to be hosted or served,
    // and a published message never depends on an asset that might later disappear.
    return { ok: true as const, url: `data:${input.contentType};base64,${bytes.toString('base64')}` };
  }),

  reindexSeedTemplates: adminOs.reindexSeedTemplates.handler(async ({ context }) => {
    const admin = requireMutation(context);
    const created = await context.repo.ensureSeedTemplates((document, subject) =>
      renderMessage(document, subject).then(({ html, text }) => ({ html, text })),
    );
    await context.repo.audit({
      action: 'seed.reindexed',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { created },
    });
    return { ok: true as const };
  }),
});
