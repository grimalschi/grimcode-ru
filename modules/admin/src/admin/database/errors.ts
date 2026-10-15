/**
 * What to tell a person when PostgreSQL refuses a value they typed.
 *
 * PostgreSQL explains its own type system: `invalid input syntax for type uuid: "1111"` says what
 * went wrong, not what would be right, and `date/time field value out of range: "07.10.2026"` says
 * the opposite of what happened — the format was wrong, not the range. The texts here say what the
 * column takes and repeat the offending value, which PostgreSQL already quotes in its message.
 *
 * Every text is matched against the English message. A server whose `lc_messages` is not English
 * (the setting is superuser-only, so the editor cannot fix it per session) falls through to the
 * original text — worse wording, same status.
 *
 * The messages and codes come from probes of every editable type on PostgreSQL 16, 8 October 2026;
 * `errors.test.ts` keeps the exact texts.
 */

export interface Explained {
  code: 'BAD_REQUEST' | 'NOT_FOUND';
  message: string;
}

interface DriverError {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
}

/**
 * The refusal a person should see for a failure the driver raised, or null when the failure is
 * not about their input: a lost connection, a missing privilege, a mistake in the editor's own SQL.
 */
export function explainPostgresError(error: unknown): Explained | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, detail } = error as DriverError;
  if (typeof code !== 'string' || typeof message !== 'string') return null;

  // `invalid_catalog_name`: the database in the connection string does not exist.
  if (code === '3D000') return { code: 'NOT_FOUND', message };

  if (code.startsWith('23')) return { code: 'BAD_REQUEST', message: constraint(code, message, detail) };
  if (code.startsWith('22')) return { code: 'BAD_REQUEST', message: input(message) };

  /*
   * Class 42 is "syntax error or access rule violation" — normally the editor's own fault, and so an
   * internal error. The one exception is a search value for `tsvector` or `tsquery`: PostgreSQL
   * parses those as a language, so a bad one is a syntax error of the value, not of the statement.
   */
  if (code === '42601') {
    const type = /\b(tsvector|tsquery)\b/.exec(message)?.[1];
    if (type) return { code: 'BAD_REQUEST', message: `Неверная запись для типа ${type}${received(message)}` };
  }

  return null;
}

/**
 * Constraint violations keep PostgreSQL's wording: it names the column or constraint, and a
 * general phrase would say less. For a duplicate key and a missing reference the value is only in
 * `detail` (`Key (email)=(a@x) already exists.`), so it is appended. A check or not-null `detail` is
 * the whole failing row, which says nothing a person did not already see.
 */
function constraint(code: string, message: string, detail: unknown): string {
  return (code === '23505' || code === '23503') && typeof detail === 'string' ? `${message} ${detail}` : message;
}

/** The value PostgreSQL quoted at the end of its message, ready to append. */
function received(message: string): string {
  const value = /: "(.*)"$/s.exec(message)?.[1];
  return value === undefined ? '' : `. Получено: «${value}»`;
}

/** What a column of this type takes, for the types people meet; the rest get the generic line. */
function expectation(type: string): string {
  if (/^(smallint|integer|bigint)$/.test(type)) return 'Ожидается целое число, например 42';
  if (/^(numeric|real|double precision)$/.test(type)) return 'Ожидается число, дробная часть через точку: 12.5';
  if (type === 'boolean') return 'Ожидается true или false';
  if (type === 'uuid') return 'Ожидается uuid вида 11111111-1111-1111-1111-111111111111';
  if (type === 'date') return 'Дата записывается как ГГГГ-ММ-ДД, например 2026-10-07';
  if (type.startsWith('timestamp')) return 'Дата и время записываются как ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-10-07 12:30';
  if (type.startsWith('time')) return 'Время записывается как ЧЧ:ММ, например 12:30';
  if (type === 'interval') return 'Интервал записывается как «1 day 02:30:00» или «90 minutes»';
  if (type === 'inet' || type === 'cidr') return 'Ожидается IP-адрес, например 10.0.0.5 или подсеть 10.0.0.0/8';
  return `Значение не подходит для типа ${type}`;
}

/** Class 22, "data exception": the value could not be read as the column's type. */
function input(message: string): string {
  const typed = /^invalid input syntax for type (.+?): "/s.exec(message);
  if (typed) return `${expectation(typed[1]!)}${received(message)}`;
  if (message === 'invalid input syntax for type json') return 'Ожидается JSON, например {"plan": "pro"}';

  const enumValue = /^invalid input value for enum (\S+): "(.*)"$/s.exec(message);
  if (enumValue) return `Значение «${enumValue[2]}» не входит в список допустимых для типа ${enumValue[1]}`;

  if (message.startsWith('malformed array literal')) return `Массив записывается в фигурных скобках: {a,b}${received(message)}`;
  if (message.startsWith('malformed range literal')) {
    return `Диапазон записывается как [18,30): квадратная скобка включает границу, круглая нет${received(message)}`;
  }
  if (message.startsWith('malformed multirange literal')) return `Мультидиапазон записывается как {[1,2),[5,7)}${received(message)}`;
  if (message.startsWith('date/time field value out of range')) {
    return `Неверная дата или время. Формат ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-10-07 12:30${received(message)}`;
  }

  const overflow = /^value "(.*)" is out of range for type (.+)$/s.exec(message);
  if (overflow) return `Число не помещается в тип ${overflow[2]}. Получено: «${overflow[1]}»`;
  if (message.startsWith('numeric field overflow')) return 'Число не помещается в колонку: слишком много знаков';

  const tooLong = /^value too long for type (.+)$/s.exec(message);
  if (tooLong) return `Значение длиннее, чем допускает колонка (${tooLong[1]})`;

  if (message.startsWith('range lower bound must be less than or equal')) return 'Начало диапазона больше конца';
  if (message.startsWith('invalid XML content')) return 'Ожидается корректный XML';
  if (message.startsWith('invalid hexadecimal digit')) return 'Двоичные данные записываются как \\x и шестнадцатеричные цифры';
  if (message.startsWith('invalid byte sequence for encoding "UTF8": 0x00')) return 'Текст содержит недопустимый символ (код 0)';
  if (/^".*" is not a valid binary digit$/s.test(message)) return `Ожидаются только 0 и 1. Получено: «${/^"(.*)" is not/s.exec(message)![1]}»`;
  if (message.startsWith('invalid cidr value')) return `Подсеть записывается с нулями после маски: 10.0.0.0/8${received(message)}`;

  return message;
}
