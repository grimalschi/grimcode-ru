import type { NotificationEvent } from '@template/notifications/contract';
import type { NotificationsInternalCaller } from '@template/notifications/contract';

/**
 * Auth's outgoing side.
 *
 * Auth owns no templates and no delivery. It only reports typed events; Notifications routes them,
 * and Email renders and sends them.
 */
export class Notifier {
  constructor(
    private readonly requestIdOf: () => string,
    private readonly callNotifications: (call: { requestId: string }) => NotificationsInternalCaller,
  ) {}

  /**
   * Emitting must never fail a security flow: the token a reset consumed is gone either way, so a
   * failed hand-off is swallowed. Nothing reports it — the cost of having no logging — and what makes
   * that `catch` reachable at all is the deadline Notifications puts on its own caller, because
   * nothing here honours an abort signal.
   */
  async emit(event: NotificationEvent, dedupeKey: string): Promise<void> {
    try {
      const notifications = this.callNotifications({ requestId: this.requestIdOf() });

      await notifications.emit({ event, dedupeKey });
    } catch {
      // Deliberately empty: see above.
    }
  }
}
