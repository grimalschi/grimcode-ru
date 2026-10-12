import { describe, expect, it } from 'vitest';
import { CONDITION_LABELS, controlSegments, decodeControlSpelling, decodeFilterValues, fieldDraft, fieldValue, groupConditions, hasControlCharacters, spellControls, type Filter } from './model';
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

describe('control characters in a table cell', () => {
  it('spells each control character the way the row dialog does and keeps the rest as text', () => {
    expect(controlSegments('first\r\nsecond\tend')).toEqual([
      { text: 'first', control: false }, { text: '\\r', control: true }, { text: '\\n', control: true },
      { text: 'second', control: false }, { text: '\\t', control: true }, { text: 'end', control: false },
    ]);
    expect(controlSegments('\u0001\u007f\u0085')).toEqual([
      { text: '\\u0001', control: true }, { text: '\\u007f', control: true }, { text: '\\u0085', control: true },
    ]);
  });

  it('leaves plain text, quotes and backslashes alone', () => {
    expect(controlSegments('say "hi" \\ there')).toEqual([{ text: 'say "hi" \\ there', control: false }]);
    expect(controlSegments('')).toEqual([]);
  });

  it('spells pasted bytes the way the cell shows them, and reads them back exactly', () => {
    expect(spellControls('first\r\nsecond\tend')).toBe('first\\r\\nsecond\\tend');
    expect(spellControls('C:\\new\nline')).toBe('C:\\\\new\\nline');
    for (const text of ['first\r\nsecond', 'C:\\new\nline', 'plain', '\u0001\\u0001']) {
      expect(decodeControlSpelling(spellControls(text))).toBe(text);
    }
  });

  it('reads the same spelling back in a filter value', () => {
    expect(decodeControlSpelling('first\\r\\nsecond\\tend')).toBe('first\r\nsecond\tend');
    expect(decodeControlSpelling('\\u0001\\u007f\\u0085')).toBe('\u0001\u007f\u0085');
    expect(decodeControlSpelling('C:\\data\\\\n \\x \\')).toBe('C:\\data\\n \\x \\');
    for (const text of ['first\r\nsecond\tend', '\u0001\u009f', 'back\\slash']) {
      expect(decodeControlSpelling(controlSegments(text).map((segment) => segment.control ? segment.text : segment.text.replaceAll('\\', '\\\\')).join(''))).toBe(text);
    }
  });

  it('decodes filter values only for text-matching conditions on text columns', () => {
    const columns = [{ name: 'label', conditions: ['is', 'contains', 'empty-string'] }, { name: 'amount', conditions: ['is', 'contains'] }];
    const filters: Filter[] = [
      { column: 'label', condition: 'contains', value: 'a\\nb' },
      { column: 'label', condition: 'one-of', value: ['a\\tb', 'c'] },
      { column: 'label', condition: 'length-over', value: '\\n' },
      { column: 'amount', condition: 'contains', value: '\\n' },
    ];
    expect(decodeFilterValues(filters, columns).map((filter) => filter.value)).toEqual(['a\nb', ['a\tb', 'c'], '\\n', '\\n']);
  });

  it('agrees with the dialog about what counts as a control character', () => {
    for (const text of ['plain', 'tab\tbed', 'crlf\r\n', '\u009f']) {
      expect(controlSegments(text).some((segment) => segment.control)).toBe(hasControlCharacters(text));
    }
  });
});
