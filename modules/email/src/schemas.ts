import { z } from 'zod';

import { emailSchema, idSchema, isoDateTimeSchema } from '@template/shared/vocabulary';

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

/** The stored editor document, as the version editor in the browser reads it. */
export type EditorDocument = z.infer<typeof editorDocumentSchema>;

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
