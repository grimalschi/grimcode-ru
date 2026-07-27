import type {
  ContractRouterClient,
  NotificationEvent,
  notificationsInternalContract,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  REQUEST_ID_HEADER,
  type Logger,
} from '@template/shared';

type NotificationsClient = ContractRouterClient<typeof notificationsInternalContract>;

/**
 * Auth's outgoing side.
 *
 * Auth owns no templates and no delivery. It only reports typed events; Notifications routes them,
 * and Email renders and sends them.
 */
export class Notifier {
  constructor(
    private readonly logger: Logger,
    private readonly requestIdOf: () => string,
  ) {}

  private client<T>(service: 'notifications', path: string): T {
    return createRpcClient<T>({
      url: `${internalServiceUrl(service)}${path}`,
      headers: { [REQUEST_ID_HEADER]: this.requestIdOf() },
    });
  }


  /**
   * Emitting a notification must never fail a security flow. A password reset the user asked for
   * still consumed its token; a failed hand-off is logged and reported through the delivery log.
   */
  async emit(event: NotificationEvent, dedupeKey: string): Promise<void> {
    try {
      const notifications = this.client<NotificationsClient>('notifications', '/internal/rpc');
      await notifications.emit({ event, dedupeKey });
    } catch (error) {
      this.logger.error('notification could not be handed to notifications', {
        type: event.type,
        error,
      });
    }
  }
}
