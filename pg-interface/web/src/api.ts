/**
 * The one place this screen talks to its server.
 *
 * Addresses are relative to the page: the package can be mounted anywhere, so the screen asks
 * `api/…` next to itself rather than a path it was told at build time.
 */

/** The header the server insists on. See the package README: it is what makes a cross-site POST fail. */
const REQUEST_HEADER = 'x-pg-interface';

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  /** True when the database fills this column in by itself: a new row may leave it out. */
  hasDefault?: boolean;
  /** True when only the database decides the value — an identity column, or a computed one. */
  generated?: boolean;
  conditions?: readonly string[];
  /**
   * True when this interface added the column itself.
   *
   * Only such a column may be renamed or dropped: the rest belong to a module's migrations, and its
   * code reads them by name. The server decides this from its journal and refuses either way; the flag
   * exists so the screen does not offer what would be refused.
   */
  own?: boolean;
}

/** The types a new column may be given, as the server's closed list. */
export const COLUMN_TYPES = [
  'text',
  'integer',
  'bigint',
  'numeric',
  'boolean',
  'timestamptz',
  'date',
  'uuid',
  'jsonb',
] as const;

export interface RowCount {
  count: number;
  /** The count itself, the planner's estimate for a table too large to count, or a floor. */
  kind: 'exact' | 'estimate' | 'more';
}

export interface TableInfo {
  schema: string;
  name: string;
  primaryKey: string[];
  rows: RowCount;
  columns: Column[];
  /** False for the tables whose shape belongs to the project: no column may be added to them. */
  reshapable?: boolean;
  /** False for the tables that record what has been applied: no row may be added to them by hand. */
  insertable?: boolean;
  /**
   * The column that records the order rows arrived in — a counter or a creation time — if the table has
   * one. The table opens sorted by it: sorting by a uuid key is stable but reads as no order at all.
   */
  naturalOrder?: string | null;
}

export interface Filter {
  column: string;
  condition: string;
  value?: unknown;
}

export interface Order {
  column: string;
  direction: 'asc' | 'desc';
}

export interface RowsQuery {
  schema: string;
  table: string;
  filters?: Filter[];
  combine?: 'and' | 'or';
  order?: Order[];
  limit?: number;
  offset?: number;
}

export interface RowsPage {
  columns: Column[];
  primaryKey: string[];
  rows: Record<string, unknown>[];
  total: number;
  /** Whether the shape of this table can be changed here — see the column menu. */
  reshapable?: boolean;
}

/** The refusal the server sent, kept as it is: its wording is what tells a person what to fix. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's own name for the refusal, for the few the screen answers with more than a message. */
    readonly code = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function base(): string {
  const path = window.location.pathname;
  return path.endsWith('/') ? path : `${path}/`;
}

async function send<Result>(path: string, body?: unknown): Promise<Result> {
  const response = await fetch(`${base()}api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      [REQUEST_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(parsed.message ?? `Request failed (${response.status})`),
      typeof parsed.error === 'string' ? parsed.error : '',
    );
  }

  return parsed as Result;
}

export function listDatabases(): Promise<{ databases: { name: string }[] }> {
  return send('databases');
}

export function listTables(database: string): Promise<{ tables: TableInfo[] }> {
  return send(`databases/${encodeURIComponent(database)}/tables`);
}

export function readRows(database: string, query: RowsQuery): Promise<RowsPage> {
  return send(`databases/${encodeURIComponent(database)}/rows`, query);
}

export function updateRow(
  database: string,
  input: { schema: string; table: string; key: Record<string, unknown>; values: Record<string, unknown> },
): Promise<{ updated: number }> {
  return send(`databases/${encodeURIComponent(database)}/rows/update`, input);
}

export function insertRow(
  database: string,
  input: { schema: string; table: string; values: Record<string, unknown> },
): Promise<{ inserted: Record<string, unknown> | null }> {
  return send(`databases/${encodeURIComponent(database)}/rows/insert`, input);
}

export function deleteRow(
  database: string,
  input: { schema: string; table: string; key: Record<string, unknown> },
): Promise<{ deleted: number }> {
  return send(`databases/${encodeURIComponent(database)}/rows/delete`, input);
}

export function addColumn(
  database: string,
  input: {
    schema: string;
    table: string;
    column: string;
    type: string;
    /** `NOT NULL`, which the server allows only together with a default. */
    required?: boolean;
    /** A default of one's own. Omitted means the type's own for a required column, none otherwise. */
    default?: string;
  },
): Promise<{ added: string; version: number }> {
  return send(`databases/${encodeURIComponent(database)}/columns`, input);
}

export function renameColumn(
  database: string,
  input: { schema: string; table: string; column: string; to: string },
): Promise<{ renamed: string; version: number }> {
  return send(`databases/${encodeURIComponent(database)}/columns/rename`, input);
}

export function dropColumn(
  database: string,
  input: { schema: string; table: string; column: string },
): Promise<{ dropped: string; version: number }> {
  return send(`databases/${encodeURIComponent(database)}/columns/drop`, input);
}
