/**
 * Every name this template gives a service. A name and nothing else: the modules share one process,
 * and a neighbour is reached through the caller its owner was handed, never through an address.
 *
 * There is no address anywhere near this list any more. The database section used to be the one
 * exception — a third-party application in its own container, dialled for real — and its own
 * interface lives in this process like everything else.
 */
export type InternalServiceName =
  | 'gateway'
  | 'site'
  | 'app'
  | 'admin'
  | 'auth'
  | 'users'
  | 'notifications'
  | 'email';
