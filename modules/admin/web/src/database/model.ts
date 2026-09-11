import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AdminPanelRouter } from '../../../src/admin/router.js';

type Inputs = inferRouterInputs<AdminPanelRouter>['database'];
type Outputs = inferRouterOutputs<AdminPanelRouter>['database'];
export type TableInfo = Outputs['tables']['tables'][number];
export type Column = TableInfo['columns'][number];
export type Filter = NonNullable<Inputs['rows']['filters']>[number];
export type Order = NonNullable<Inputs['rows']['order']>[number];
export type Row = Record<string, unknown>;

export interface View {
  schema: string;
  table: string;
  filters: Filter[];
  combine: 'and' | 'or';
  order: Order[];
  columns: string[];
  size: number;
  page: number;
}

export const PAGE_SIZES = [20, 50, 100, 200, 500];
export const emptyView = (): View => ({ schema: '', table: '', filters: [], combine: 'and', order: [], columns: [], size: 20, page: 1 });

export function readView(): View {
  try {
    const value = JSON.parse(decodeURIComponent(window.location.hash.slice(1))) as Partial<View>;
    if (typeof value.schema !== 'string' || typeof value.table !== 'string') return emptyView();
    return {
      ...emptyView(), schema: value.schema, table: value.table,
      filters: Array.isArray(value.filters) ? value.filters.filter((entry) => entry && typeof entry.column === 'string' && typeof entry.condition === 'string') : [],
      combine: value.combine === 'or' ? 'or' : 'and',
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
  is: 'равно', 'is-not': 'не равно', contains: 'содержит', 'not-contains': 'не содержит',
  'starts-with': 'начинается с', 'not-starts-with': 'не начинается с', 'ends-with': 'заканчивается на',
  'not-ends-with': 'не заканчивается на', equals: 'равно', 'not-equals': 'не равно',
  'greater-than': 'больше', 'at-least': 'не меньше', 'less-than': 'меньше', 'at-most': 'не больше',
  between: 'между', 'one-of': 'одно из', 'not-one-of': 'ни одно из', 'is-true': 'да',
  'is-false': 'нет', 'is-empty': 'пусто', 'is-not-empty': 'не пусто',
};

export function filterShape(condition: string) {
  if (['is-empty', 'is-not-empty', 'is-true', 'is-false'].includes(condition)) return 'none';
  if (condition === 'between') return 'range';
  if (['one-of', 'not-one-of'].includes(condition)) return 'list';
  return 'one';
}

export function isFilterReady(filter: Filter): boolean {
  if (!filter.column) return false;
  const shape = filterShape(filter.condition);
  if (shape === 'none') return true;
  if (shape === 'range') return Array.isArray(filter.value) && filter.value.length === 2
    && filter.value.every((value) => value !== null && String(value ?? '') !== '');
  if (shape === 'list') return Array.isArray(filter.value) && filter.value.length > 0;
  return filter.value !== undefined && filter.value !== null && String(filter.value) !== '';
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

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
