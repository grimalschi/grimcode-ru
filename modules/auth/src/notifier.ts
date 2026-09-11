import type { NotificationEvent, NotificationsApi } from '@template/contracts/modules/notifications';

/**
 * Auth's outgoing side.
 *
 * Auth owns no templates and no delivery. It only reports typed events; Notifications routes them,
 * and Email renders and sends them.
 */
export class Notifier {
  constructor(private readonly notifications: NotificationsApi) {}

  async emit(event: NotificationEvent, dedupeKey: string): Promise<void> {
    try {
      await this.notifications.emit({ event, dedupeKey });
    } catch (error) {
      console.error('Auth notification hand-off failed', { type: event.type }, error);
    }
  }
}
