import { describe, expect, it } from 'vitest';

import { day, describeDevice, sinceNow } from './device';

describe('a sign-in described for a person', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome, Windows', 'computer'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge, Windows', 'computer'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari, macOS', 'computer'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36', 'Яндекс Браузер, macOS', 'computer'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari, iPhone', 'phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'Chrome, iPhone', 'phone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari, iPad', 'tablet'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome, Android', 'phone'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox, Linux', 'computer'],
  ])('names %s', (userAgent, name, kind) => {
    expect(describeDevice(userAgent)).toEqual({ name, kind });
  });

  it('admits what it cannot tell', () => {
    expect(describeDevice('curl/7.88.1')).toEqual({ name: 'Неизвестное устройство', kind: 'unknown' });
    expect(describeDevice(null)).toEqual({ name: 'Неизвестное устройство', kind: 'unknown' });
  });

  it('says how long ago rather than when', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(sinceNow('2026-10-16T11:59:30Z', now)).toBe('Сейчас');
    expect(sinceNow('2026-10-16T11:55:00Z', now)).toBe('5 минут назад');
    expect(sinceNow('2026-10-16T09:00:00Z', now)).toBe('3 часа назад');
    expect(sinceNow('2026-10-15T12:00:00Z', now)).toBe('Вчера');
    expect(sinceNow('2026-10-09T12:00:00Z', now)).toBe('7 дней назад');
  });

  it('names the day of the sign-in, with the year only when it differs', () => {
    const now = new Date('2026-10-16T12:00:00');
    expect(day('2026-10-16T09:00:00', now)).toBe('16 октября');
    expect(day('2025-03-02T09:00:00', now)).toBe('2 марта 2025 г.');
  });
});
