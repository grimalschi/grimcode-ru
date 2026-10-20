/**
 * A browser's own description of itself, said the way a person would name the device.
 *
 * The raw user-agent string means nothing to most people, and a list of sign-ins is only useful if
 * an unfamiliar one stands out. A handful of rules covers the browsers and systems people actually
 * use; anything else is "Неизвестное устройство", and the screen keeps the raw string in a tooltip.
 */
export type DeviceKind = 'phone' | 'tablet' | 'computer' | 'unknown';

export interface Device {
  name: string;
  kind: DeviceKind;
}

// Order matters: Edge, Opera and Yandex also say "Chrome", and Chrome also says "Safari".
const BROWSERS: [RegExp, string][] = [
  [/YaBrowser\//, 'Яндекс Браузер'],
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
];

export function describeDevice(userAgent: string | null): Device {
  if (!userAgent) return { name: 'Неизвестное устройство', kind: 'unknown' };

  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const [system, kind] = systemOf(userAgent);

  const name = [browser, system].filter(Boolean).join(', ');
  return name ? { name, kind } : { name: 'Неизвестное устройство', kind: 'unknown' };
}

function systemOf(userAgent: string): [string | undefined, DeviceKind] {
  if (/iPhone/.test(userAgent)) return ['iPhone', 'phone'];
  if (/iPad/.test(userAgent)) return ['iPad', 'tablet'];
  if (/Android/.test(userAgent)) return ['Android', /Mobile/.test(userAgent) ? 'phone' : 'tablet'];
  if (/Windows/.test(userAgent)) return ['Windows', 'computer'];
  if (/Mac OS X|Macintosh/.test(userAgent)) return ['macOS', 'computer'];
  if (/CrOS/.test(userAgent)) return ['ChromeOS', 'computer'];
  if (/Linux/.test(userAgent)) return ['Linux', 'computer'];
  return [undefined, 'unknown'];
}

const MINUTE = 60_000;

/** "Сейчас", "5 минут назад", "вчера" — how long ago, not a timestamp to decode. */
export function sinceNow(iso: string, now = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < MINUTE) return 'Сейчас';

  const format = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  const minutes = Math.round(elapsed / MINUTE);
  if (minutes < 60) return capitalize(format.format(-minutes, 'minute'));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return capitalize(format.format(-hours, 'hour'));
  const days = Math.round(hours / 24);
  if (days < 30) return capitalize(format.format(-days, 'day'));
  const months = Math.round(days / 30);
  if (months < 12) return capitalize(format.format(-months, 'month'));
  return capitalize(format.format(-Math.round(months / 12), 'year'));
}

/** "16 октября", with the year only when it is not this one. */
export function day(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
