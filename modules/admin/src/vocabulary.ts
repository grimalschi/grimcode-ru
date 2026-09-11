import { z } from 'zod';

/** Module names are supplied by composition. */
export const adminModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);

export const adminModuleDescriptorSchema = z.object({
  id: adminModuleIdSchema,
  admin: z.object({
    title: z.string().min(1).max(120),
    icon: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80),
    assignable: z.boolean().optional(),
  }),
});
export type CatalogueEntry = z.infer<typeof adminModuleDescriptorSchema>;

/** Reject ambiguous or invalid installations before serving any traffic. */
export function validateCatalogue(catalogue: readonly CatalogueEntry[]): readonly CatalogueEntry[] {
  const parsed = z.array(adminModuleDescriptorSchema).parse(catalogue);
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('Duplicate administrative module id');
  }
  return parsed;
}

export const adminRoleSchema = z.enum(['owner', 'admin']);

/** Router selects the panel itself or an installed module. */
export const adminTargetSchema = z.discriminatedUnion('area', [
  z.object({ area: z.literal('panel') }),
  z.object({ area: z.literal('module'), module: adminModuleIdSchema }),
]);
