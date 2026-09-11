import { initTRPC } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RPC_TIMEOUT_MS, withDeadlineOn } from './rpc.js';

describe('calling a neighbour in this process over tRPC', () => {
  const t = initTRPC.create();

  /** A module with one procedure and the caller a neighbour is handed, deadline and all. */
  function callNeighbour(answer: () => Promise<{ pong: string }>, timeoutMs = RPC_TIMEOUT_MS) {
    const router = t.router({
      ping: t.procedure
        .input(z.object({ say: z.string() }))
        .output(z.object({ pong: z.string() }))
        .query(answer),
    });

    return withDeadlineOn(router.createCaller({}), 'email', timeoutMs);
  }

  it('reaches it without a request and answers through the contract', async () => {
    const email = callNeighbour(() => Promise.resolve({ pong: 'pong' }));

    expect(await email.ping({ say: 'hi' })).toEqual({ pong: 'pong' });
  });

  it('refuses input the schema does not allow, exactly as a request would', async () => {
    const email = callNeighbour(() => Promise.resolve({ pong: 'pong' }));

    await expect(email.ping({ say: 42 as unknown as string })).rejects.toThrow(/say/i);
  });

  /**
   * The deadline is the module's to put on the caller it hands out, and this is what keeps every
   * fail-closed branch above it reachable: nothing else ends the wait, because a direct call has no
   * signal to abort.
   */
  it('stops waiting when the neighbour hangs, which no signal would do here', async () => {
    const email = callNeighbour(
      () => new Promise((resolve) => setTimeout(() => resolve({ pong: 'late' }), 1_000)),
      50,
    );

    const started = Date.now();
    await expect(email.ping({ say: 'hi' })).rejects.toThrow(
      /email\.ping did not answer within 50 ms/,
    );
    expect(Date.now() - started).toBeLessThan(500);
  });
});
