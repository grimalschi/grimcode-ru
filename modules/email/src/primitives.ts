import { z } from 'zod';

/** Validation rules owned by this module's HTTP and caller surfaces. */
export const idSchema = z.uuid();
export const emailSchema = z.email().max(320).toLowerCase().trim();
export const isoDateTimeSchema = z.iso.datetime();

export const paginationInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
}
