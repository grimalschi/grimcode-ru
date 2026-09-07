import type { Filter, Order } from './api';

/**
 * What the screen is showing, kept in the address bar.
 *
 * The reference this screen follows stores named views on its server. Ours has nowhere to store them:
 * it works over the modules' own databases and creates no table of its own, on purpose. So the view
 * lives in the URL — which is most of what named views were for anyway, since a link can be sent to
 * somebody or kept in a bookmark.
 */
export interface View {
  database: string;
  schema: string;
  table: string;
  filters: Filter[];
  combine: 'and' | 'or';
  order: Order[];
  /** Columns to show; empty means all of them, so a new column appears by itself. */
  columns: string[];
  size: number;
  page: number;
}

export const PAGE_SIZES = [20, 50, 100, 200, 500];

export function emptyView(): View {
  return {
    database: '',
    schema: '',
    table: '',
    filters: [],
    combine: 'and',
    order: [],
    columns: [],
    size: PAGE_SIZES[0] ?? 20,
    page: 1,
  };
}

/**
 * The hash is JSON, encoded so a filter value cannot break the URL.
 *
 * A hash that cannot be read is ignored rather than reported: it comes from a link somebody pasted,
 * and an empty view is a better answer than an error page.
 */
export function readHash(hash: string): View | null {
  if (hash.length <= 1) return null;

  try {
    const decoded = decodeURIComponent(escape(atob(hash.slice(1))));
    const parsed = JSON.parse(decoded) as Partial<View>;
    if (typeof parsed.database !== 'string' || typeof parsed.table !== 'string') return null;
    return { ...emptyView(), ...parsed };
  } catch {
    return null;
  }
}

export function writeHash(view: View): void {
  const json = JSON.stringify(view);
  const hash = `#${btoa(unescape(encodeURIComponent(json)))}`;
  if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
}
