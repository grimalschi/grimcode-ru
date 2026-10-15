import { describe, expect, it } from 'vitest';

import { explainPostgresError } from './errors.js';

// Messages verbatim from PostgreSQL 16, probed on 8 October 2026 with every editable type.
const refused = (code: string, message: string, detail?: string) => explainPostgresError({ code, message, detail });

describe('a value PostgreSQL could not read', () => {
  it.each([
    ['22P02', 'invalid input syntax for type integer: "12,5"', 'Ожидается целое число, например 42. Получено: «12,5»'],
    ['22P02', 'invalid input syntax for type smallint: ""', 'Ожидается целое число, например 42. Получено: «»'],
    ['22P02', 'invalid input syntax for type bigint: "1e30"', 'Ожидается целое число, например 42. Получено: «1e30»'],
    ['22P02', 'invalid input syntax for type numeric: "12,5"', 'Ожидается число, дробная часть через точку: 12.5. Получено: «12,5»'],
    ['22P02', 'invalid input syntax for type double precision: "12,5"', 'Ожидается число, дробная часть через точку: 12.5. Получено: «12,5»'],
    ['22P02', 'invalid input syntax for type real: "abc"', 'Ожидается число, дробная часть через точку: 12.5. Получено: «abc»'],
    ['22P02', 'invalid input syntax for type boolean: "да"', 'Ожидается true или false. Получено: «да»'],
    ['22P02', 'invalid input syntax for type uuid: "null"', 'Ожидается uuid вида 11111111-1111-1111-1111-111111111111. Получено: «null»'],
    ['22007', 'invalid input syntax for type date: "вчера"', 'Дата записывается как ГГГГ-ММ-ДД, например 2026-10-07. Получено: «вчера»'],
    ['22007', 'invalid input syntax for type timestamp with time zone: "abc"', 'Дата и время записываются как ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-10-07 12:30. Получено: «abc»'],
    ['22007', 'invalid input syntax for type timestamp without time zone: "abc"', 'Дата и время записываются как ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-10-07 12:30. Получено: «abc»'],
    ['22007', 'invalid input syntax for type time: "10-00"', 'Время записывается как ЧЧ:ММ, например 12:30. Получено: «10-00»'],
    ['22007', 'invalid input syntax for type time with time zone: "abc"', 'Время записывается как ЧЧ:ММ, например 12:30. Получено: «abc»'],
    ['22007', 'invalid input syntax for type interval: "1,5 часа"', 'Интервал записывается как «1 day 02:30:00» или «90 minutes». Получено: «1,5 часа»'],
    ['22P02', 'invalid input syntax for type inet: "10.0.0"', 'Ожидается IP-адрес, например 10.0.0.5 или подсеть 10.0.0.0/8. Получено: «10.0.0»'],
    ['22P02', 'invalid input syntax for type point: "(1,2"', 'Значение не подходит для типа point. Получено: «(1,2»'],
    ['22P02', 'invalid input syntax for type money: "abc"', 'Значение не подходит для типа money. Получено: «abc»'],
    ['22P02', 'invalid input syntax for type macaddr: "abc"', 'Значение не подходит для типа macaddr. Получено: «abc»'],
    ['22P02', 'invalid input syntax for type json', 'Ожидается JSON, например {"plan": "pro"}'],
    ['22P02', 'invalid input value for enum probe_mood: "готово"', 'Значение «готово» не входит в список допустимых для типа probe_mood'],
    ['22P02', 'malformed array literal: "a,b"', 'Массив записывается в фигурных скобках: {a,b}. Получено: «a,b»'],
    ['22P02', 'malformed range literal: "18-30"', 'Диапазон записывается как [18,30): квадратная скобка включает границу, круглая нет. Получено: «18-30»'],
    ['22P02', 'malformed multirange literal: "[1,2)"', 'Мультидиапазон записывается как {[1,2),[5,7)}. Получено: «[1,2)»'],
    ['22008', 'date/time field value out of range: "07.10.2026"', 'Неверная дата или время. Формат ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-10-07 12:30. Получено: «07.10.2026»'],
    ['22003', 'value "99999" is out of range for type smallint', 'Число не помещается в тип smallint. Получено: «99999»'],
    ['22003', 'numeric field overflow', 'Число не помещается в колонку: слишком много знаков'],
    ['22001', 'value too long for type character varying(3)', 'Значение длиннее, чем допускает колонка (character varying(3))'],
    ['22000', 'range lower bound must be less than or equal to range upper bound', 'Начало диапазона больше конца'],
    ['2200N', 'invalid XML content', 'Ожидается корректный XML'],
    ['22023', 'invalid hexadecimal digit: "z"', 'Двоичные данные записываются как \\x и шестнадцатеричные цифры'],
    ['22021', 'invalid byte sequence for encoding "UTF8": 0x00', 'Текст содержит недопустимый символ (код 0)'],
    ['22P02', '"2" is not a valid binary digit', 'Ожидаются только 0 и 1. Получено: «2»'],
    ['22P02', 'invalid cidr value: "10.0.0.5/8"', 'Подсеть записывается с нулями после маски: 10.0.0.0/8. Получено: «10.0.0.5/8»'],
  ])('%s %s', (code, message, expected) => {
    expect(refused(code, message)).toEqual({ code: 'BAD_REQUEST', message: expected });
  });

  it('keeps a multi-line value whole', () => {
    expect(refused('22P02', 'invalid input syntax for type integer: "1\n2"')).toEqual({
      code: 'BAD_REQUEST', message: 'Ожидается целое число, например 42. Получено: «1\n2»',
    });
  });

  it('passes an unknown class-22 text through unchanged, still as a 400', () => {
    expect(refused('22P03', 'invalid binary representation')).toEqual({ code: 'BAD_REQUEST', message: 'invalid binary representation' });
  });
});

describe('a constraint the row would break', () => {
  it('names the key for a duplicate and a missing reference, from detail', () => {
    expect(refused('23505', 'duplicate key value violates unique constraint "probe_w_email_key"', 'Key (email)=(a@x) already exists.')).toEqual({
      code: 'BAD_REQUEST', message: 'duplicate key value violates unique constraint "probe_w_email_key" Key (email)=(a@x) already exists.',
    });
    expect(refused('23503', 'insert or update on table "probe_w" violates foreign key constraint "probe_w_parent_fkey"', 'Key (parent)=(99) is not present in table "probe_w".')).toEqual({
      code: 'BAD_REQUEST', message: 'insert or update on table "probe_w" violates foreign key constraint "probe_w_parent_fkey" Key (parent)=(99) is not present in table "probe_w".',
    });
  });

  it('leaves the failing row out for not-null and check violations', () => {
    expect(refused('23502', 'null value in column "email" of relation "probe_w" violates not-null constraint', 'Failing row contains (2, null, null, null, null).')).toEqual({
      code: 'BAD_REQUEST', message: 'null value in column "email" of relation "probe_w" violates not-null constraint',
    });
    expect(refused('23514', 'new row for relation "probe_w" violates check constraint "probe_w_age_check"', 'Failing row contains (3, c@x, -5, null, null).')).toEqual({
      code: 'BAD_REQUEST', message: 'new row for relation "probe_w" violates check constraint "probe_w_age_check"',
    });
  });
});

describe('a search value PostgreSQL parses as a language', () => {
  it('treats a malformed tsvector or tsquery as the value\'s fault', () => {
    expect(refused('42601', 'syntax error in tsvector: "\'a"')).toEqual({ code: 'BAD_REQUEST', message: 'Неверная запись для типа tsvector. Получено: «\'a»' });
    expect(refused('42601', 'no operand in tsquery: "a &"')).toEqual({ code: 'BAD_REQUEST', message: 'Неверная запись для типа tsquery. Получено: «a &»' });
  });

  it('leaves any other syntax error internal — that is the editor\'s SQL, not the value', () => {
    expect(refused('42601', 'syntax error at or near "FROM"')).toBeNull();
    expect(refused('42883', 'operator does not exist: uuid[] @> text[]')).toBeNull();
  });
});

describe('what is not about the value', () => {
  it('reports a missing database as not found and everything else as internal', () => {
    expect(refused('3D000', 'database "x" does not exist')).toEqual({ code: 'NOT_FOUND', message: 'database "x" does not exist' });
    expect(refused('53300', 'remaining connection slots are reserved')).toBeNull();
    expect(refused('ECONNREFUSED', 'connect ECONNREFUSED')).toBeNull();
    expect(explainPostgresError(new Error('plain'))).toBeNull();
    expect(explainPostgresError(null)).toBeNull();
    expect(explainPostgresError('text')).toBeNull();
  });
});
