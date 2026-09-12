import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '../context.js';
import { emailSchema, idSchema, pageOf, paginationInputSchema } from '../primitives.js';
import { z } from 'zod';

import {
  deliveryListItemSchema,
  deliverySchema,
  deliveryStatusSchema,
  templateSchema,
  templateVersionSchema,
} from '../schemas.js';
import type { AdminContext } from '@template/contracts/module-instance';
import { isCsrfValid } from '../http/csrf.js';
import { initTRPC, TRPCError } from '@trpc/server';

import type { EmailEnv } from '../env.js';
import type { EmailRepository, TemplateRow, VersionRow } from '../repository.js';
import {
  assertDeclaredVariables,
  fillHtml,
  fillText,
  redactOneTimeTokens,
  renderMessage,
  renderSubject,
  TemplateRenderError,
  type VariableValue,
} from '../render.js';

interface AdminRpcContext extends ModuleContext {
  request: Request;
  adminContext: AdminContext;
  env: Pick<EmailEnv, 'csrfCookieName'>;
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
    source: row.source,
    compiledHtml: row.compiled_html,
    compiledText: row.compiled_text,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadVersion(repo: EmailRepository, id: string): Promise<VersionRow> {
  const row = await repo.findVersion(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия шаблона не найдена' });
  return row;
}

function renderFailure(error: unknown): never {
  if (error instanceof TemplateRenderError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

function renderVersion(version: VersionRow, variables: Record<string, VariableValue>) {
  if (version.compiled_html !== null && version.compiled_text !== null) {
    return {
      subject: renderSubject(version.subject, variables),
      html: fillHtml(version.compiled_html, variables),
      text: fillText(version.compiled_text, variables),
    };
  }
  return renderMessage(version.source, version.subject, variables);
}

const adminT = initTRPC.context<AdminRpcContext>().create();

const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.adminContext)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  return next({ ctx: { adminContext: ctx.adminContext } });
});

const adminMutation = adminProcedure.use(({ ctx, next }) => {
  if (!isCsrfValid(ctx.request.headers, ctx.env.csrfCookieName)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF-токен отсутствует или неверен' });
  }
  return next();
});

export const adminRouter = adminT.router({
  listTemplates: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(templateSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listTemplates(input.query, input.limit, input.offset);
      return { items: rows.map(toTemplate), total, limit: input.limit, offset: input.offset };
    }),

  getTemplate: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(
      z.object({
        template: templateSchema,
        versions: z.array(templateVersionSchema.omit({ source: true })),
      }),
    )
    .query(async ({ input, ctx }) => {
      const template = await ctx.repo.findTemplateById(input.id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      const versions = await ctx.repo.listVersions(template.id);
      return {
        template: toTemplate(template),
        // Source is fetched when a version opens.
        versions: versions.map((row) => {
          const { source: _source, ...rest } = toVersion(row);
          return rest;
        }),
      };
    }),

  createTemplate: adminMutation
    .input(templateSchema.pick({ key: true, name: true, description: true, variables: true }))
    .output(z.object({ ok: z.literal(true), template: templateSchema }))
    .mutation(async ({ input, ctx }) => {
      if (await ctx.repo.findTemplateByKey(input.key)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Шаблон с таким ключом уже есть' });
      }

      const row = await ctx.repo.createTemplate(
        input.key,
        input.name,
        input.description,
        input.variables,
      );
      await ctx.repo.audit({
        action: 'template.created',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { key: input.key },
      });

      return { ok: true as const, template: toTemplate(row) };
    }),

  updateTemplate: adminMutation
    .input(
      z.object({
        id: idSchema,
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(1000).nullable().optional(),
        variables: z.array(z.string()).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), template: templateSchema }))
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.repo.updateTemplate(input.id, input);
      await ctx.repo.audit({
        action: 'template.updated',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { key: row.key },
      });
      return { ok: true as const, template: toTemplate(row) };
    }),

  getVersion: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ version: templateVersionSchema }))
    .query(async ({ input, ctx }) => ({
      version: toVersion(await loadVersion(ctx.repo, input.id)),
    })),

  createDraft: adminMutation
    .input(z.object({ templateId: idSchema }))
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema }))
    .mutation(async ({ input, ctx }) => {
      const template = await ctx.repo.findTemplateById(input.templateId);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      const row = await ctx.repo.createDraft(template.id, {
        subject: template.name,
        source: `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Текст письма</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
      });
      await ctx.repo.audit({
        action: 'version.draft.created',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { templateKey: template.key, version: row.version },
      });

      return { ok: true as const, version: toVersion(row) };
    }),

  saveDraft: adminMutation
    .input(
      templateVersionSchema.pick({ id: true, subject: true, source: true }),
    )
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        const row = await ctx.repo.saveDraft(input.id, input.subject, input.source);
        return { ok: true as const, version: toVersion(row) };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Draft could not be saved',
        });
      }
    }),

  /** Validates variables and stores compiled HTML and text with the publication. */
  publishDraft: adminMutation
    .input(z.object({ id: idSchema }))
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema }))
    .mutation(async ({ input, ctx }) => {
      const draft = await loadVersion(ctx.repo, input.id);

      const template = await ctx.repo.findTemplateById(draft.template_id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      let row;
      try {
        row = await ctx.repo.publish(draft.id, async (current, variables) => {
          assertDeclaredVariables(current.source, current.subject, variables);
          return renderMessage(current.source, current.subject);
        });
      } catch (error) {
        renderFailure(error);
      }

      await ctx.repo.audit({
        action: 'version.published',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { templateKey: template.key, version: row.version },
      });

      return { ok: true as const, version: toVersion(row) };
    }),

  previewVersion: adminProcedure
    .input(
      z.object({
        id: idSchema,
        draft: templateVersionSchema.pick({ subject: true, source: true }).optional(),
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    )
    .output(z.object({ subject: z.string(), html: z.string(), text: z.string() }))
    .query(async ({ input, ctx }) => {
      const version = await loadVersion(ctx.repo, input.id);

      try {
        return await (input.draft
          ? renderMessage(input.draft.source, input.draft.subject, input.variables)
          : renderVersion(version, input.variables));
      } catch (error) {
        renderFailure(error);
      }
    }),

  testSend: adminMutation
    .input(
      z.object({
        id: idSchema,
        to: emailSchema,
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    )
    .output(z.object({ ok: z.literal(true), deliveryId: idSchema }))
    .mutation(async ({ input, ctx }) => {
      const version = await loadVersion(ctx.repo, input.id);
      const template = await ctx.repo.findTemplateById(version.template_id);
      if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });

      let rendered;
      try {
        rendered = await renderVersion(version, input.variables);
      } catch (error) {
        renderFailure(error);
      }

      // A test send is a real send: it goes through the transport and is recorded in the log with
      // the exact content that left the system.
      const dedupeKey = `test:${randomUUID()}`;
      const { row } = await ctx.repo.openDelivery({
        dedupeKey,
        templateKey: template.key,
        templateVersionId: version.id,
        recipientEmail: input.to,
        subject: redactOneTimeTokens(rendered.subject),
        html: redactOneTimeTokens(rendered.html),
        text: redactOneTimeTokens(rendered.text),
        transport: ctx.transport.name,
      });

      let result;
      try {
        result = await ctx.transport.send({ dedupeKey, to: input.to, ...rendered });
      } catch (error) {
        await ctx.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Провайдер не подтвердил отправку', cause: error });
      }
      await ctx.repo.markSent(row.id, result);

      await ctx.repo.audit({
        action: 'version.test-sent',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { templateKey: template.key, to: input.to },
      });

      return { ok: true as const, deliveryId: row.id };
    }),

  listDeliveries: adminProcedure
    .input(paginationInputSchema.extend({ status: deliveryStatusSchema.optional() }))
    .output(pageOf(deliveryListItemSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listDeliveries(
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
  getDelivery: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ delivery: deliverySchema }))
    .query(async ({ input, ctx }) => {
      const row = await ctx.repo.findDelivery(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Отправка не найдена' });

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

});

/** The browser client of this module's admin screen is typed from this, and from nothing else. */
export type EmailAdminRouter = typeof adminRouter;
