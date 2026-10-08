import { describe, expect, it } from 'vitest';
import { CONDITION_LABELS, fieldDraft, fieldValue, groupConditions } from './model';
import {
  ARRAY_CONDITIONS, BOOLEAN_CONDITIONS, JSON_CONDITIONS, PLAIN_CONDITIONS, RANGE_CONDITIONS,
  TEXT_CONDITIONS, UUID_CONDITIONS, VALUE_CONDITIONS,
} from '../../../src/admin/database/filters.js';

describe('the condition menu', () => {
  const every = [...new Set([
    ...TEXT_CONDITIONS, ...VALUE_CONDITIONS, ...BOOLEAN_CONDITIONS, ...UUID_CONDITIONS,
    ...JSON_CONDITIONS, ...ARRAY_CONDITIONS, ...RANGE_CONDITIONS, ...PLAIN_CONDITIONS,
  ])];

  it('has a label and a heading for every condition the server offers', () => {
    for (const condition of every) expect(CONDITION_LABELS[condition], condition).toBeTruthy();
    const grouped = groupConditions(every);
    expect(grouped.every((group) => group.label !== '')).toBe(true);
    expect(grouped.flatMap((group) => group.conditions).sort()).toEqual([...every].sort());
  });

  it('keeps the server\'s conditions under their headings in menu order, dropping empty groups', () => {
    expect(groupConditions(TEXT_CONDITIONS).map((group) => group.label)).toEqual(['Сравнение', 'По тексту', 'Пустое', 'Длина']);
    expect(groupConditions(VALUE_CONDITIONS).map((group) => group.label)).toEqual(['Сравнение', 'Порядок', 'Пустое']);
    expect(groupConditions(ARRAY_CONDITIONS).map((group) => group.label)).toEqual(['Сравнение', 'Элементы', 'Пустое']);
    expect(groupConditions(JSON_CONDITIONS).map((group) => group.label)).toEqual(['Сравнение', 'По тексту', 'Ключи', 'Пустое']);
    expect(groupConditions(BOOLEAN_CONDITIONS).map((group) => group.label)).toEqual(['Сравнение', 'Пустое']);
    expect(groupConditions(TEXT_CONDITIONS)[0]?.conditions).toEqual(['is', 'is-not', 'not-equals-or-empty', 'one-of', 'not-one-of']);
  });

  it('puts a condition it has no heading for last, without one', () => {
    expect(groupConditions(['is-empty', 'brand-new'])).toEqual([
      { label: 'Пустое', conditions: ['is-empty'] }, { label: '', conditions: ['brand-new'] },
    ]);
  });
});

describe('the database editor text representation', () => {
  it.each([
    ['empty string', ''],
    ['literal null', 'null'],
    ['SQL NULL', null],
    ['default', undefined],
    ['large numbers', '999999999999999999999999999999.12345678901234567890'],
    ['timestamp precision', '2026-09-12 04:05:06.123456+00'],
    ['JSON precision and whitespace', '{ "number": 9007199254740993, "number": -0 }'],
    ['quoted array', '[0:2]={"",NULL,"null"}'],
    ['binary text', '\\x000aff'],
    ['CRLF, lone CR and LF', 'first\r\nsecond\rthird\nfourth'],
    ['tabs and escaped characters', '\t\\n"quoted"'],
    ['Unicode', 'Привет 👩🏽‍💻 e\u0301 \u2028\u2029'],
    ['object property name', '__proto__'],
  ])('preserves %s exactly', (_description, value) => {
    expect(fieldValue(fieldDraft(value))).toBe(value);
  });

  it('round-trips every UTF-16 code unit, including controls and surrogate pairs', () => {
    for (let code = 0; code <= 0xffff; code++) {
      const value = `before${String.fromCharCode(code)}after`;
      expect(fieldValue(fieldDraft(value))).toBe(value);
    }
  });

  it('does not change a value when its presentation is toggled', () => {
    const value = '{ "number": 9007199254740993 }';
    expect(fieldValue({ mode: 'value', text: JSON.stringify(value), escaped: true })).toBe(value);
  });

  it.each(['null', '123', '{}', '[]', 'true', '"bad\rnewline"', '"unfinished'])('rejects a non-string or invalid escaped value: %s', (text) => {
    expect(() => fieldValue({ mode: 'value', text, escaped: true })).toThrow();
  });

  it('keeps explicit empty, null and default states distinct', () => {
    expect(fieldValue({ mode: 'value', text: '', escaped: false })).toBe('');
    expect(fieldValue({ mode: 'null', text: '', escaped: false })).toBeNull();
    expect(fieldValue({ mode: 'default', text: '', escaped: false })).toBeUndefined();
  });
});
