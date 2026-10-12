import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AdminPanelRouter } from '../../../src/admin/router.js';

type Inputs = inferRouterInputs<AdminPanelRouter>['database'];
type Outputs = inferRouterOutputs<AdminPanelRouter>['database'];
export type TableInfo = Outputs['tables']['tables'][number];
export type Column = TableInfo['columns'][number];
export type Reference = NonNullable<Column['references']>;
export type Filter = NonNullable<Inputs['rows']['filters']>[number];
export type Order = NonNullable<Inputs['rows']['order']>[number];
export type Row = Outputs['rows']['rows'][number];

export interface FieldDraft {
  mode: 'value' | 'null' | 'default';
  text: string;
  escaped: boolean;
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export interface TextSegment { text: string; control: boolean }

/**
 * Splits a cell value into plain runs and control characters, each control character spelled as the
 * row dialog spells it in its JSON string (`\r`, `\n`, `\t`, `\u0001`) — so the table shows that the
 * value holds a line break where the browser would otherwise draw nothing or a space.
 */
export function controlSegments(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code >= 32 && (code < 127 || code > 159)) { plain += character; continue; }
    if (plain) { segments.push({ text: plain, control: false }); plain = ''; }
    const spelled = code < 32 ? JSON.stringify(character).slice(1, -1) : `\\u${code.toString(16).padStart(4, '0')}`;
    segments.push({ text: spelled, control: true });
  }
  if (plain) segments.push({ text: plain, control: false });
  return segments;
}

/**
 * The way back: a filter value typed the way the cell spells control characters becomes the bytes
 * the cell stands for, so what the table shows is what a condition can be given. `\\` is one
 * backslash; a backslash before anything else is left alone, so `C:\data` still means itself and
 * only `\n`, `\r`, `\t`, `\b`, `\f` and `\uXXXX` are read as spelling.
 */
export function decodeControlSpelling(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[nrtbf\\])/g, (_, code: string) => {
    if (code === '\\') return '\\';
    if (code.startsWith('u')) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[code] ?? code;
  });
}

/**
 * The spelling of a text that holds control characters, as a filter box should receive it when the
 * text is pasted: what a cell copies (the bytes) becomes what the cell shows, with every backslash
 * doubled so that `decodeControlSpelling` gives the pasted bytes back exactly.
 */
export function spellControls(text: string): string {
  return controlSegments(text).map((segment) => segment.control ? segment.text : segment.text.replaceAll('\\', '\\\\')).join('');
}

/** Text columns are the ones the server offers "empty string" to; the spelling is read only for them. */
export const isTextColumn = (column: { conditions: readonly string[] } | undefined): boolean => column?.conditions.includes('empty-string') ?? false;

/** Conditions whose value is matched against the column's text, where the spelling means something. */
const SPELLED_CONDITIONS = new Set(['is', 'is-not', 'not-equals-or-empty', 'contains', 'not-contains', 'not-contains-or-empty', 'starts-with', 'not-starts-with', 'ends-with', 'not-ends-with', 'one-of', 'not-one-of']);

/** Filters as the server should see them: the spelling of control characters turned into the characters on text columns. */
export function decodeFilterValues(filters: Filter[], columns: readonly { name: string; conditions: readonly string[] }[]): Filter[] {
  return filters.map((filter) => {
    if (!SPELLED_CONDITIONS.has(filter.condition) || !isTextColumn(columns.find((column) => column.name === filter.column))) return filter;
    const value = Array.isArray(filter.value) ? filter.value.map((entry) => decodeControlSpelling(String(entry)))
      : typeof filter.value === 'string' ? decodeControlSpelling(filter.value) : filter.value;
    return { ...filter, value };
  });
}

export function fieldDraft(value: string | null | undefined): FieldDraft {
  const text = value ?? '';
  const escaped = hasControlCharacters(text);
  return { mode: value === undefined ? 'default' : value === null ? 'null' : 'value', text: escaped ? JSON.stringify(text) : text, escaped };
}

/** JSON wraps the PostgreSQL text as a string; the database value itself is never parsed. */
export function fieldValue(field: FieldDraft): string | null | undefined {
  if (field.mode === 'default') return undefined;
  if (field.mode === 'null') return null;
  if (!field.escaped) return field.text;
  let value: unknown;
  try { value = JSON.parse(field.text); }
  catch { throw new Error('Введите JSON-строку в двойных кавычках. Спецсимволы записываются как \\r, \\n, \\t.'); }
  if (typeof value !== 'string') throw new Error('Ожидается JSON-строка в двойных кавычках.');
  return value;
}

export interface View {
  schema: string;
  table: string;
  /** A chain: each filter after the first carries `join`, how it attaches to the one before. */
  filters: Filter[];
  /** Whether "contains" and its kin tell big letters from small. */
  caseSensitive: boolean;
  order: Order[];
  columns: string[];
  size: number;
  page: number;
}

export const PAGE_SIZES = [20, 50, 100, 200, 500];
export const emptyView = (): View => ({ schema: '', table: '', filters: [], caseSensitive: false, order: [], columns: [], size: 20, page: 1 });

/** The first condition joins nothing; every other one joins with И unless it says ИЛИ. */
export function chained(filters: Filter[]): Filter[] {
  return filters.map((filter, index) => {
    const { join, ...rest } = filter;
    return index === 0 ? rest : { ...rest, join: join === 'or' ? 'or' : 'and' };
  });
}

export function readView(): View {
  try {
    const value = JSON.parse(decodeURIComponent(window.location.hash.slice(1))) as Partial<View> & { combine?: unknown };
    if (typeof value.schema !== 'string' || typeof value.table !== 'string') return emptyView();
    const filters = Array.isArray(value.filters)
      ? value.filters.filter((entry) => entry && typeof entry.column === 'string' && typeof entry.condition === 'string') : [];
    return {
      ...emptyView(), schema: value.schema, table: value.table,
      // An address from before the chain carried one word for the whole panel; it becomes every join.
      filters: chained(value.combine === 'or' ? filters.map((entry) => ({ ...entry, join: 'or' as const })) : filters),
      caseSensitive: value.caseSensitive === true,
      order: Array.isArray(value.order) ? value.order.filter((entry) => entry && typeof entry.column === 'string' && ['asc', 'desc'].includes(entry.direction)) : [],
      columns: Array.isArray(value.columns) ? value.columns.filter((entry) => typeof entry === 'string') : [],
      size: PAGE_SIZES.includes(value.size ?? 0) ? value.size! : 20,
      page: Number.isInteger(value.page) && value.page! > 0 ? value.page! : 1,
    };
  } catch {
    return emptyView();
  }
}

export const CONDITION_LABELS: Record<string, string> = {
  is: 'равно', 'is-not': 'не равно', 'not-equals-or-empty': 'не равно или пусто',
  contains: 'содержит', 'not-contains': 'не содержит', 'not-contains-or-empty': 'не содержит или пусто',
  'starts-with': 'начинается с', 'not-starts-with': 'не начинается с', 'ends-with': 'заканчивается на',
  'not-ends-with': 'не заканчивается на', equals: 'равно', 'not-equals': 'не равно',
  'greater-than': 'больше', 'at-least': 'не меньше', 'less-than': 'меньше', 'at-most': 'не больше',
  between: 'от … до', 'not-between': 'вне от … до', 'one-of': 'одно из', 'not-one-of': 'ни одно из',
  'is-true': 'да', 'is-false': 'нет', 'is-empty': 'пусто', 'is-not-empty': 'не пусто',
  'empty-string': 'пустая строка', 'not-empty-string': 'не пустая строка',
  'length-over': 'длина больше', 'length-under': 'длина меньше',
  'array-has': 'содержит значение', 'array-lacks': 'не содержит значение', 'array-has-all': 'содержит все перечисленные',
  'count-over': 'элементов больше', 'count-under': 'элементов меньше',
  'has-key': 'есть ключ', 'lacks-key': 'нет ключа', 'key-equals': 'значение ключа равно', 'key-contains': 'значение ключа содержит',
  'range-has': 'содержит значение',
};

/**
 * Headings for the condition menu, in the order they appear. Eighteen conditions for a text column
 * read as a wall without them; the owner chose grouping over dropping any (8 October 2026).
 */
const CONDITION_GROUPS: [string, string[]][] = [
  ['Сравнение', ['is', 'is-not', 'equals', 'not-equals', 'not-equals-or-empty', 'one-of', 'not-one-of', 'is-true', 'is-false']],
  ['Порядок', ['greater-than', 'at-least', 'less-than', 'at-most', 'between', 'not-between']],
  ['По тексту', ['contains', 'not-contains', 'not-contains-or-empty', 'starts-with', 'not-starts-with', 'ends-with', 'not-ends-with']],
  ['Элементы', ['array-has', 'array-lacks', 'array-has-all', 'count-over', 'count-under', 'range-has']],
  ['Ключи', ['has-key', 'lacks-key', 'key-equals', 'key-contains']],
  ['Пустое', ['is-empty', 'is-not-empty', 'empty-string', 'not-empty-string']],
  ['Длина', ['length-over', 'length-under']],
];

/** A column's conditions under their headings, in menu order; a condition no group names comes last, unheaded. */
export function groupConditions(conditions: readonly string[]): { label: string; conditions: string[] }[] {
  const groups = CONDITION_GROUPS
    .map(([label, members]) => ({ label, conditions: members.filter((condition) => conditions.includes(condition)) }))
    .filter((group) => group.conditions.length > 0);
  const placed = new Set(groups.flatMap((group) => group.conditions));
  const rest = conditions.filter((condition) => !placed.has(condition));
  return rest.length ? [...groups, { label: '', conditions: rest }] : groups;
}

/** What a condition needs typed in: nothing, one value, a number, a start and end, a list, or a key and value. */
export function filterShape(condition: string): 'none' | 'one' | 'number' | 'range' | 'list' | 'pair' {
  if (['is-empty', 'is-not-empty', 'is-true', 'is-false', 'empty-string', 'not-empty-string'].includes(condition)) return 'none';
  if (['between', 'not-between'].includes(condition)) return 'range';
  if (['one-of', 'not-one-of', 'array-has-all'].includes(condition)) return 'list';
  if (['length-over', 'length-under', 'count-over', 'count-under'].includes(condition)) return 'number';
  if (['key-equals', 'key-contains'].includes(condition)) return 'pair';
  return 'one';
}

const filled = (value: unknown): boolean => value !== undefined && value !== null && String(value) !== '';

export function isFilterReady(filter: Filter): boolean {
  if (!filter.column) return false;
  const shape = filterShape(filter.condition);
  if (shape === 'none') return true;
  if (shape === 'range' || shape === 'pair') return Array.isArray(filter.value) && filter.value.length === 2 && filter.value.every(filled);
  if (shape === 'list') return Array.isArray(filter.value) && filter.value.length > 0;
  return filled(filter.value);
}

export const cellText = (value: string | null | undefined): string => value ?? '';

export function rowCountLabel(rows: TableInfo['rows']): string {
  return `${rows.kind === 'estimate' ? '~' : rows.kind === 'more' ? '>' : ''}${rows.count}`;
}

export function shortType(type: string): string {
  return ({ 'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
    'character varying': 'varchar', 'double precision': 'float8', boolean: 'bool', integer: 'int',
    smallint: 'int2', bigint: 'int8', character: 'char' } as Record<string, string>)[type] ?? type;
}

export function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
