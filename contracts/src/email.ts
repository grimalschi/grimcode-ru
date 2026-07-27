import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

/**
 * Editor document marker stored next to every template version.
 *
 * A new editor library never rewrites stored documents on start: moving the marker forward is a
 * separate Email migration.
 */
export const EDITOR_FORMAT = 'maily@1' as const;
export const editorFormatSchema = z.literal(EDITOR_FORMAT);

/** Maily saves a TipTap-style document. Email keeps it verbatim and compiles it on publish. */
export const editorDocumentSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const templateSchema = z.object({
  id: idSchema,
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Expected a lowercase kebab-case key'),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable(),
  /** Variables the editor may reference and the publish step validates against. */
  variables: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const templateVersionStatusSchema = z.enum(['draft', 'published', 'archived']);

export const templateVersionSchema = z.object({
  id: idSchema,
  templateId: idSchema,
  version: z.number().int().min(1),
  status: templateVersionStatusSchema,
  subject: z.string().min(1).max(300),
  editorFormat: editorFormatSchema,
  editorDocument: editorDocumentSchema,
  /** Filled by the server on publish; runtime delivery only ever uses these. */
  compiledHtml: z.string().nullable(),
  compiledText: z.string().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const deliveryStatusSchema = z.enum(['queued', 'sent', 'failed']);

/** Row of the delivery log. `html` and `text` are the immutable snapshot of what was sent. */
export const deliverySchema = z.object({
  id: idSchema,
  templateKey: z.string().max(80),
  templateVersionId: idSchema.nullable(),
  recipientEmail: emailSchema,
  subject: z.string().max(300),
  html: z.string(),
  text: z.string(),
  transport: z.enum(['log', 'unisender']),
  status: deliveryStatusSchema,
  providerMessageId: z.string().max(200).nullable(),
  providerStatus: z.string().max(200).nullable(),
  error: z.string().max(2000).nullable(),
  createdAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
});

export const deliveryListItemSchema = deliverySchema.omit({ html: true, text: true });

export const emailInternalContract = {
  /**
   * Runtime delivery. Sends the published version of the template, stores the
   * immutable snapshot of the produced message and hands it to the configured transport.
   */
  send: oc
    .input(
      z.object({
        templateKey: z.string().min(1).max(80),
        to: emailSchema,
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        dedupeKey: z.string().min(1).max(200),
      }),
    )
    .output(
      z.object({
        ok: z.literal(true),
        deliveryId: idSchema,
        deduplicated: z.boolean(),
        status: deliveryStatusSchema,
      }),
    ),
};

export const emailAdminContract = {
  listTemplates: oc.input(paginationInputSchema).output(pageOf(templateSchema)),

  getTemplate: oc.input(z.object({ id: idSchema })).output(
    z.object({
      template: templateSchema,
      versions: z.array(templateVersionSchema.omit({ editorDocument: true })),
    }),
  ),

  createTemplate: oc
    .input(templateSchema.pick({ key: true, name: true, description: true, variables: true }))
    .output(z.object({ ok: z.literal(true), template: templateSchema })),

  updateTemplate: oc
    .input(
      z.object({
        id: idSchema,
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(1000).nullable().optional(),
        variables: z.array(z.string()).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), template: templateSchema })),

  getVersion: oc
    .input(z.object({ id: idSchema }))
    .output(z.object({ version: templateVersionSchema })),

  /** Creates a new draft, copying the latest version when one exists. */
  createDraft: oc
    .input(z.object({ templateId: idSchema }))
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema })),

  saveDraft: oc
    .input(
      z.object({
        id: idSchema,
        subject: z.string().min(1).max(300),
        editorDocument: editorDocumentSchema,
      }),
    )
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema })),

  /** Compiles, validates and sanitizes the document, then publishes the resulting HTML and text. */
  publishDraft: oc
    .input(z.object({ id: idSchema }))
    .output(z.object({ ok: z.literal(true), version: templateVersionSchema })),

  /** Server-side render of a draft or published version, shown in a sandboxed iframe. */
  previewVersion: oc
    .input(
      z.object({
        id: idSchema,
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    )
    .output(z.object({ subject: z.string(), html: z.string(), text: z.string() })),

  testSend: oc
    .input(
      z.object({
        id: idSchema,
        to: emailSchema,
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    )
    .output(z.object({ ok: z.literal(true), deliveryId: idSchema })),

  listDeliveries: oc
    .input(paginationInputSchema.extend({ status: deliveryStatusSchema.optional() }))
    .output(pageOf(deliveryListItemSchema)),

  /** Full immutable snapshot of one actually sent message. */
  getDelivery: oc.input(z.object({ id: idSchema })).output(z.object({ delivery: deliverySchema })),

  uploadImage: oc
    .input(
      z.object({
        fileName: z.string().min(1).max(200),
        contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        /** Base64 payload, size-limited by the service. */
        data: z.string().min(1),
      }),
    )
    .output(z.object({ ok: z.literal(true), url: z.string() })),

  reindexSeedTemplates: oc.input(z.object({})).output(okSchema),
};

export const emailContract = {
  internal: emailInternalContract,
  admin: emailAdminContract,
};
