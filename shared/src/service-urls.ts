import { optionalEnv } from './env.js';

/**
 * Fixed internal ports of the template.
 *
 * They are pinned in the images and in Compose. Nobody types them by hand: locally `.env` only
 * chooses the published host ports of Gateway and PostgreSQL.
 */
export const INTERNAL_PORTS = {
  gateway: 8080,
  site: 3000,
  app: 3001,
  admin: 3002,
  auth: 3003,
  users: 3004,
  notifications: 3005,
  email: 3006,
  adminer: 8080,
} as const;

export type InternalServiceName = keyof typeof INTERNAL_PORTS;

/**
 * Base URL of another service on the internal Docker network.
 *
 * Services talk to each other directly over this network; nothing here is published outwards.
 */
export function internalServiceUrl(service: InternalServiceName): string {
  return optionalEnv(
    `SERVICE_URL_${service.toUpperCase()}`,
    `http://${service}:${INTERNAL_PORTS[service]}`,
  );
}

/** Port this service listens on inside its own container. */
export function ownPort(service: InternalServiceName): number {
  const raw = process.env.PORT;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return INTERNAL_PORTS[service];
}
