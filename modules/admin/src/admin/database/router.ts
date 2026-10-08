import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminT, ownerMutation, ownerProcedure } from '../rpc.js';
import { explainPostgresError } from './errors.js';
import { rowsInputSchema, rowsOutputSchema, tableInputSchema, tablesOutputSchema, valuesSchema } from './schemas.js';

// A refusal of what a person typed is their 400, in their words; the original error stays as `cause`.
const databaseErrors = adminT.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.code === 'INTERNAL_SERVER_ERROR') {
    const cause = result.error.cause;
    const explained = explainPostgresError(cause);
    if (explained) throw new TRPCError({ ...explained, cause });
  }
  return result;
});

const query = ownerProcedure.use(databaseErrors);
const mutation = ownerMutation.use(databaseErrors);

export const databaseRouter = adminT.router({
  schemas: query.input(z.strictObject({}))
    .output(z.object({ schemas: z.array(z.object({ name: z.string().min(1) })) }))
    .query(({ ctx }) => ctx.databaseBrowser.schemas()),
  tables: query.input(z.strictObject({ schema: z.string().min(1) })).output(tablesOutputSchema)
    .query(({ ctx, input }) => ctx.databaseBrowser.tables(input)),
  rows: query.input(rowsInputSchema).output(rowsOutputSchema)
    .query(({ ctx, input }) => ctx.databaseBrowser.rows(input)),
  insert: mutation.input(tableInputSchema.extend({ values: valuesSchema }))
    .output(z.object({ inserted: valuesSchema.nullable() }))
    .mutation(({ ctx, input }) => ctx.databaseBrowser.insert(input)),
  update: mutation.input(tableInputSchema.extend({ original: valuesSchema, values: valuesSchema }))
    .output(z.object({ updated: z.number().int().nonnegative() }))
    .mutation(({ ctx, input }) => ctx.databaseBrowser.update(input)),
  delete: mutation.input(tableInputSchema.extend({ original: valuesSchema }))
    .output(z.object({ deleted: z.number().int().positive() }))
    .mutation(({ ctx, input }) => ctx.databaseBrowser.delete(input)),
});
