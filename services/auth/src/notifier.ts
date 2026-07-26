import type {
  ContractRouterClient,
  NotificationEvent,
  notificationsInternalContract,
  usersInternalContract,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  REQUEST_ID_HEADER,
  type Logger,
} from '@template/shared';

type NotificationsClient = ContractRouterClient<typeof notificationsInternalContract>;
type UsersClient = ContractRouterClient<typeof usersInternalContract>;

/**
 * Auth's outgoing side.
 *
 * Auth owns no templates and no delivery. It only reports typed events; Notifications routes them
 * and Email renders and sends them. The recipient's locale is a product preference, so it is read
 * from Users through its contract — never from its database.
 */
export class Notifier {
  constructor(
    private readonly logger: Logger,
    private readonly requestIdOf: () => string,
  ) {}

  private client<T>(service: 'notifications' | 'users', path: string): T {
    return createRpcClient<T>({
      url: `${internalServiceUrl(service)}${path}`,
      headers: { [REQUEST_ID_HEADER]: this.requestIdOf() },
    });
  }

  /** Falls back to `en` when Users has no profile yet or is temporarily unreachable. */
  async localeOf(identityId: string): Promise<string> {
    try {
      const users = this.client<UsersClient>('users', '/internal/rpc');
      const { profile } = await users.getProfileByIdentityId({ identityId });
      return profile?.locale ?? 'en';
    } catch (error) {
      this.logger.warn('could not read recipient locale, falling back to en', { error });
      return 'en';
    }
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
