import * as React from 'react';

import { ErrorState } from '@/components/layout/admin-page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { rowCountLabel, type TableInfo } from '@/database/model';

/** What the page knows about one schema's tables: nothing yet, the list, or why it could not be read. */
export type SchemaCatalogue = { tables: TableInfo[]; error?: undefined } | { tables?: undefined; error: unknown };

/**
 * The tables of one schema. The page loads every schema's list once and keeps it, so opening a
 * section shows the list at once; the placeholder is shown only when an answer is really late,
 * otherwise a section would flash grey and change height on every opening.
 */
export function SchemaTables({ schema, catalogue, selected, counts, onOpen, onRetry }: {
  schema: string;
  catalogue: SchemaCatalogue | undefined;
  /** The table shown on the right, if it is in this schema. */
  selected: string | null;
  /** Rows added or removed on this page since the catalogue was read, by `schema.table`. */
  counts: Record<string, number>;
  onOpen: (table: TableInfo) => void;
  onRetry: () => void;
}) {
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    if (catalogue) return;
    const timer = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(timer);
  }, [catalogue]);

  if (!catalogue) return late ? <Skeleton className="h-24 w-full" /> : <div className="h-10" aria-hidden="true" />;
  if (catalogue.tables === undefined) return <ErrorState error={catalogue.error} retry={onRetry} />;
  const tables = catalogue.tables;
  return <nav aria-label={`Таблицы ${schema}`} className="flex flex-col gap-1">
    {tables.map((table) => {
      const count = table.rows.kind === 'exact' ? { ...table.rows, count: Math.max(0, table.rows.count + (counts[`${table.schema}.${table.name}`] ?? 0)) } : table.rows;
      const current = selected === table.name;
      return <Button key={table.name} variant={current ? 'secondary' : 'ghost'} className="w-full shrink-0 justify-between gap-2 pl-5 pr-2" aria-label={`Открыть таблицу ${table.schema}.${table.name}`} aria-current={current ? 'page' : undefined} onClick={() => onOpen(table)}>
        <span className="truncate">{table.name}</span><span className="text-xs tabular-nums text-muted-foreground">{rowCountLabel(count)}</span>
      </Button>;
    })}
    {!tables.length && <p className="px-5 text-sm text-muted-foreground">Таблиц нет</p>}
  </nav>;
}
