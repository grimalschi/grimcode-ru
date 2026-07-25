import type { editorDocumentSchema } from '@template/contracts';
import type { z } from 'zod';

export type EditorDocument = z.infer<typeof editorDocumentSchema>;
