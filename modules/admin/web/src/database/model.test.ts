import { describe, expect, it } from 'vitest';
import { fieldDraft, fieldValue } from './model';

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
