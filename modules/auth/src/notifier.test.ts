import type { NotificationEvent, NotificationsApi } from '@template/contracts/modules/notifications';
import { describe, expect, it, vi } from 'vitest';

import { Notifier } from './notifier.js';

const event: NotificationEvent = {
  type: 'auth.password.reset_requested',
  recipient: { identityId: '00000000-0000-4000-8000-000000000001', email: 'user@example.com' },
  payload: { resetUrl: 'https://example.com/reset?token=one' },
};

describe('notification caller dependency', () => {
  it('uses the ready API without emitting during construction', async () => {
    const emit = vi.fn<NotificationsApi['emit']>().mockResolvedValue({
      ok: true, eventId: '00000000-0000-4000-8000-000000000002', deduplicated: false,
    });
    const notifier = new Notifier({ emit });
    expect(emit).not.toHaveBeenCalled();

    await Promise.all([
      notifier.emit(event, 'dedupe-first'),
      notifier.emit(event, 'dedupe-second'),
    ]);
    expect(emit.mock.calls).toEqual([
      [{ event, dedupeKey: 'dedupe-first' }],
      [{ event, dedupeKey: 'dedupe-second' }],
    ]);
  });

  it('keeps a dependency failure from interrupting the security flow', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unavailable = new Notifier({ emit: () => { throw new Error('unavailable'); } });
    await expect(unavailable.emit(event, 'dedupe')).resolves.toBeUndefined();

    const emit = vi.fn<NotificationsApi['emit']>().mockRejectedValue(new Error('delivery failed'));
    const failed = new Notifier({ emit });
    await expect(failed.emit(event, 'dedupe')).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('reset?token');
    errorLog.mockRestore();
  });
});
