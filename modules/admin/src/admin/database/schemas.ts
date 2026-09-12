import { z } from 'zod';
import { BOOLEAN_CONDITIONS, JSON_CONDITIONS, TEXT_CONDITIONS, UUID_CONDITIONS, VALUE_CONDITIONS } from './filters.js';

const name = z.string().min(1);
const condition = z.enum([...TEXT_CONDITIONS, ...VALUE_CONDITIONS, ...BOOLEAN_CONDITIONS, ...UUID_CONDITIONS, ...JSON_CONDITIONS]);
// z.record drops the legal PostgreSQL column name "__proto__"; validate without rebuilding the object.
export const valuesSchema = z.custom<Record<string, string | null>>((value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.values(value).every((cell) => cell === null || typeof cell === 'string'),
  'Values must be an object of PostgreSQL text values or SQL NULL.');
export const tableInputSchema = z.strictObject({ schema: name, table: name });
export const rowsInputSchema = tableInputSchema.extend({
  filters: z.array(z.strictObject({ column: name, condition, value: z.unknown().optional() })).nullish(),
  combine: z.enum(['and', 'or']).nullish(),
  order: z.array(z.strictObject({ column: name, direction: z.enum(['asc', 'desc']) })).nullish(),
  limit: z.number().int().nullish(),
  offset: z.number().int().nullish(),
});

const column = z.object({
  name, type: z.string(), nullable: z.boolean(), hasDefault: z.boolean(), generated: z.boolean(),
  conditions: z.array(condition), readOnlyReason: z.string().nullable(),
});
export const tablesOutputSchema = z.object({ tables: z.array(z.object({
  schema: name, name, primaryKey: z.array(name), columns: z.array(column),
  naturalOrder: name.nullable(), readOnlyReason: z.string().nullable(), deleteReadOnlyReason: z.string().nullable(),
  rows: z.object({ count: z.number().int().nonnegative(), kind: z.enum(['exact', 'estimate', 'more']) }),
})) });
export const rowsOutputSchema = z.object({
  columns: z.array(column), primaryKey: z.array(name), rows: z.array(valuesSchema),
  readOnlyReason: z.string().nullable(), deleteReadOnlyReason: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
