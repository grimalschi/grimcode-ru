export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(service: string, base: Record<string, unknown> = {}): Logger {
  const minimum = LEVEL_ORDER[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVEL_ORDER.info;

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < minimum) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      service,
      message,
      ...base,
    };
    for (const [key, value] of Object.entries(fields ?? {})) entry[key] = serialize(value);
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(service, { ...base, ...fields }),
  };
}
