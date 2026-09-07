import { describe, expect, it } from 'vitest';

import {
  ADMIN_SERVICE_IDS,
  ASSIGNABLE_SERVICE_IDS,
  adminContextSchema,
  assignableServiceIdSchema,
  paginationInputSchema,
} from './vocabulary.js';

describe('service ids', () => {
  it('never lets an owner grant the database area to a regular administrator', () => {
    expect(ASSIGNABLE_SERVICE_IDS).not.toContain('database' as never);
    expect(assignableServiceIdSchema.safeParse('database').success).toBe(false);
  });

  it('keeps assignable services a subset of admin services', () => {
    for (const id of ASSIGNABLE_SERVICE_IDS) {
      expect(ADMIN_SERVICE_IDS).toContain(id);
    }
  });
});

describe('admin context', () => {
  it('rejects a context without a request id', () => {
    const result = adminContextSchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'owner@example.com',
      role: 'owner',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a complete verified context', () => {
    const result = adminContextSchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'Owner@Example.com',
      role: 'owner',
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('owner@example.com');
  });
});

describe('pagination', () => {
  it('applies safe defaults and an upper bound', () => {
    expect(paginationInputSchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(paginationInputSchema.safeParse({ limit: 1000 }).success).toBe(false);
  });
});
