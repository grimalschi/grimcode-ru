import { z } from 'zod';
import {
  ARRAY_CONDITIONS, BOOLEAN_CONDITIONS, JSON_CONDITIONS, PLAIN_CONDITIONS, RANGE_CONDITIONS,
  TEXT_CONDITIONS, UUID_CONDITIONS, VALUE_CONDITIONS,
} from './filters.js';

const name = z.string().min(1);
const condition = z.enum([
  ...TEXT_CONDITIONS, ...VALUE_CONDITIONS, ...BOOLEAN_CONDITIONS, ...UUID_CONDITIONS, ...JSON_CONDITIONS,
  ...ARRAY_CONDITIONS, ...RANGE_CONDITIONS, ...PLAIN_CONDITIONS,
]);
// z.record drops the legal PostgreSQL column name "__proto__"; validate without rebuilding the object.
export const valuesSchema = z.custom<Record<string, string | null>>((value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.values(value).every((cell) => cell === null || typeof cell === 'string'),
  'Values must be an object of PostgreSQL text values or SQL NULL.');
export const tableInputSchema = z.strictObject({ schema: name, table: name });
export const rowsInputSchema = tableInputSchema.extend({
  filters: z.array(z.strictObject({
    column: name, condition, value: z.unknown().optional(), join: z.enum(['and', 'or']).optional(),
  })).nullish(),
  caseSensitive: z.boolean().nullish(),
  order: z.array(z.strictObject({ column: name, direction: z.enum(['asc', 'desc']) })).nullish(),
  limit: z.number().int().nullish(),
  offset: z.number().int().nullish(),
});

const reference = z.object({ schema: name, table: name, column: name });
const foreignKey = z.object({ columns: z.array(name), target: z.object({ schema: name, table: name, columns: z.array(name) }) });
const column = z.object({
  name, type: z.string(), nullable: z.boolean(), hasDefault: z.boolean(), generated: z.boolean(),
  // PostgreSQL's own spelling, `format_type`: `varchar(3)`, `text[]`. `type` above is the information_schema family the conditions are picked by.
  sqlType: z.string(),
  conditions: z.array(condition), readOnlyReason: z.string().nullable(),
  // The row this value points at, when the column alone is a foreign key.
  references: reference.nullable(),
});
export const tablesOutputSchema = z.object({ tables: z.array(z.object({
  schema: name, name, kind: z.enum(['table', 'view']), primaryKey: z.array(name), columns: z.array(column),
  // Every key leaving the table and every one arriving at it (`target` is then the pointing table).
  foreignKeys: z.array(foreignKey), referencedBy: z.array(foreignKey),
  naturalOrder: name.nullable(), readOnlyReason: z.string().nullable(), deleteReadOnlyReason: z.string().nullable(),
  // A warning shown above a table that stays editable, unlike the reasons that lock it.
  notice: z.string().nullable(),
  rows: z.object({ count: z.number().int().nonnegative(), kind: z.enum(['exact', 'estimate', 'more']) }),
})) });
export const rowsOutputSchema = z.object({
  columns: z.array(column), primaryKey: z.array(name), rows: z.array(valuesSchema),
  readOnlyReason: z.string().nullable(), deleteReadOnlyReason: z.string().nullable(), notice: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
