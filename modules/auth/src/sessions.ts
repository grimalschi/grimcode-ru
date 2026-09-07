import { newToken } from '@template/shared';

export function newSessionToken(): string {
  return newToken(32);
}
