import * as React from 'react';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, FilterIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import { AdminPage, EmptyState, ErrorState } from '@/components/layout/admin-page';
import { Pagination } from '@/components/layout/data-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Filters } from '@/database/filters';
import { cellText, emptyView, isFilterReady, messageOf, PAGE_SIZES, readView, rowCountLabel, shortType, type Column, type Row, type TableInfo } from '@/database/model';
import { RowEditor } from '@/database/row-editor';
import { useAsync } from '@/hooks/use-async';

export function DatabasePage() {
  const [view, setView] = React.useState(readView);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [editor, setEditor] = React.useState<{ table: TableInfo; columns: Column[]; row: Row | null } | null>(null);
  const [deleting, setDeleting] = React.useState<{ table: TableInfo; row: Row } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const schemas = useAsync(() => api.database.schemas.query({}), []);
  const catalogue = useAsync(async () => ({ schema: view.schema, ...(view.schema
    ? await api.database.tables.query({ schema: view.schema }) : { tables: [] as TableInfo[] }) }), [view.schema]);
  const tables = catalogue.data?.schema === view.schema ? catalogue.data.tables : [];
  const selected = tables.find((table) => table.name === view.table);
  const query = {
    schema: view.schema, table: view.table, filters: view.filters.filter(isFilterReady), combine: view.combine,
    order: view.order, limit: view.size, offset: (view.page - 1) * view.size,
  };
  const queryKey = JSON.stringify(query);
  const listing = useAsync(async () => ({ key: queryKey, page: query.table
    ? await api.database.rows.query(query) : null }), [queryKey]);
  const page = listing.data?.key === queryKey ? listing.data.page : null;
  const columns = page?.columns ?? selected?.columns ?? [];
  const shown = view.columns.length ? columns.filter((column) => view.columns.includes(column.name)) : columns;
  const loading = !!view.table && (listing.loading || listing.data?.key !== queryKey);

  React.useEffect(() => {
    if (!schemas.data) return;
    if (!schemas.data.schemas.some(({ name }) => name === view.schema)) {
      setView({ ...emptyView(), schema: schemas.data.schemas[0]?.name ?? '' });
    }
  }, [schemas.data, view.schema]);
  React.useEffect(() => {
    if (!page) return;
    const last = Math.max(1, Math.ceil(page.total / view.size));
    if (view.page > last) setView((previous) => ({ ...previous, page: last }));
  }, [page, view.page, view.size]);
  React.useEffect(() => { setCounts({}); }, [catalogue.data]);
  React.useEffect(() => { setFiltersOpen(false); setEditor(null); setDeleting(null); }, [view.schema, view.table]);
  React.useEffect(() => {
    const hash = `#${encodeURIComponent(JSON.stringify(view))}`;
    if (view.schema && window.location.hash !== hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [view]);
  React.useEffect(() => {
    const restore = () => setView(readView());
    window.addEventListener('hashchange', restore);
    return () => window.removeEventListener('hashchange', restore);
  }, []);

  function openTable(table: TableInfo) {
    setView({ ...emptyView(), schema: table.schema, table: table.name, size: view.size,
      order: table.naturalOrder ? [{ column: table.naturalOrder, direction: 'asc' }] : [] });
  }
  function sort(column: string) {
    const current = view.order.find((order) => order.column === column)?.direction;
    setView({ ...view, page: 1, order: current === 'desc' ? [] : [{ column, direction: current === 'asc' ? 'desc' : 'asc' }] });
  }
  function counted(table: TableInfo, delta: number) {
    const key = `${table.schema}.${table.name}`;
    setCounts((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + delta }));
  }
  async function save(values: Row) {
    if (!editor) return;
    const target = { schema: editor.table.schema, table: editor.table.name };
    if (editor.row) {
      await api.database.update.mutate({ ...target, key: keyOf(editor.table, editor.row), values });
      toast.success('Строка сохранена');
    } else {
      await api.database.insert.mutate({ ...target, values });
      counted(editor.table, 1);
      toast.success('Строка добавлена');
    }
    setEditor(null);
    listing.reload();
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.database.delete.mutate({ schema: deleting.table.schema, table: deleting.table.name, key: keyOf(deleting.table, deleting.row) });
      counted(deleting.table, -1);
      setDeleting(null);
      toast.success('Строка удалена');
      listing.reload();
    } catch (error) { toast.error(messageOf(error)); }
    finally { setBusy(false); }
  }

  return <AdminPage title="База данных" className="h-full min-h-0 max-w-none">
    {schemas.error ? <ErrorState error={schemas.error} retry={schemas.reload} /> : <div className="grid min-h-0 flex-1 gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-3">
        <Select value={view.schema || undefined} onValueChange={(schema) => setView({ ...emptyView(), schema })}>
          <SelectTrigger aria-label="Схема" className="w-full"><SelectValue placeholder="Схема" /></SelectTrigger>
          <SelectContent>{schemas.data?.schemas.map(({ name }) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
        </Select>
        {catalogue.error ? <ErrorState error={catalogue.error} retry={catalogue.reload} /> : <nav aria-label="Таблицы" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {catalogue.loading ? <Skeleton className="h-32 w-full" /> : tables.map((table) => {
            const count = table.rows.kind === 'exact' ? { ...table.rows, count: Math.max(0, table.rows.count + (counts[`${table.schema}.${table.name}`] ?? 0)) } : table.rows;
            return <Button key={table.name} variant={view.table === table.name ? 'secondary' : 'ghost'} className="w-full shrink-0 justify-between gap-2 px-2" aria-label={`Открыть таблицу ${table.schema}.${table.name}`} aria-current={view.table === table.name ? 'page' : undefined} onClick={() => openTable(table)}>
              <span className="truncate">{table.name}</span><span className="text-xs tabular-nums text-muted-foreground">{rowCountLabel(count)}</span>
            </Button>;
          })}
          {!catalogue.loading && !tables.length && <p className="text-sm text-muted-foreground">Таблиц нет</p>}
        </nav>}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col gap-4">
        {!view.table ? <EmptyState title="Выберите таблицу" /> : <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-medium" data-testid="database-table-title">{view.schema}.{view.table}</h2>
            <Button variant="outline" size="sm" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}><FilterIcon />Фильтры{query.filters.length ? ` (${query.filters.length})` : ''}</Button>
            {view.columns.length > 0 && <Button variant="ghost" size="sm" onClick={() => setView({ ...view, columns: [] })}>Показать все колонки</Button>}
            <Button className="ml-auto" size="sm" disabled={!page || loading || !selected} onClick={() => selected && setEditor({ table: selected, columns, row: null })}>Добавить строку</Button>
          </div>
          {filtersOpen && <Filters columns={columns} filters={view.filters} combine={view.combine} onChange={(filters, combine) => setView({ ...view, filters, combine, page: 1 })} />}
          {page && !page.primaryKey.length && <p className="text-xs text-muted-foreground">У таблицы нет первичного ключа — строки можно читать и добавлять, но не менять.</p>}
          {listing.error ? <ErrorState error={listing.error} retry={listing.reload} /> : <TooltipProvider delayDuration={250}>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
              <Table data-testid="database-table">
                <TableHeader><TableRow>
                  {shown.map((column) => {
                    const direction = view.order.find((order) => order.column === column.name)?.direction;
                    return <TableHead key={column.name} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'} className="min-w-40">
                      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={`Колонка ${column.name}`} className="inline-flex items-center gap-1.5 whitespace-nowrap py-2 font-medium">
                        {column.name}{direction === 'asc' ? <ArrowUpIcon className="size-3" /> : direction === 'desc' ? <ArrowDownIcon className="size-3" /> : null}
                        <span className="text-xs font-normal text-muted-foreground" title={column.type}>{shortType(column.type)}</span>
                      </button></DropdownMenuTrigger><DropdownMenuContent align="start">
                        <DropdownMenuItem onSelect={() => sort(column.name)}>{direction === 'asc' ? 'Сортировать по убыванию' : direction === 'desc' ? 'Убрать сортировку' : 'Сортировать по возрастанию'}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => {
                          setView({ ...view, page: 1, filters: [...view.filters, { column: column.name, condition: column.conditions[0] ?? 'is', value: '' }] }); setFiltersOpen(true);
                        }}>Фильтровать</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={shown.length < 2} onSelect={() => setView({ ...view, columns: shown.filter((entry) => entry.name !== column.name).map((entry) => entry.name) })}>Скрыть колонку</DropdownMenuItem>
                      </DropdownMenuContent></DropdownMenu>
                    </TableHead>;
                  })}
                  {page?.primaryKey.length ? <TableHead className="w-20"><span className="sr-only">Действия</span></TableHead> : null}
                </TableRow></TableHeader>
                <TableBody>
                  {loading ? Array.from({ length: 5 }, (_, row) => <TableRow key={row}>{shown.map((column) => <TableCell key={column.name}><Skeleton className="h-4 w-28" /></TableCell>)}</TableRow>)
                    : page?.rows.map((row, index) => <TableRow key={page.primaryKey.length ? JSON.stringify(page.primaryKey.map((column) => row[column])) : index}>
                      {shown.map((column) => <TableCell key={column.name}><ValueCell column={column.name} value={row[column.name]} /></TableCell>)}
                      {page.primaryKey.length && selected ? <TableCell><div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="size-7" aria-label="Открыть строку" title="Открыть строку" onClick={() => setEditor({ table: selected, columns, row })}><PencilIcon className="size-4" /></Button>
                        <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label="Удалить строку" title="Удалить строку" onClick={() => setDeleting({ table: selected, row })}><Trash2Icon className="size-4" /></Button>
                      </div></TableCell> : null}
                    </TableRow>)}
                  {!loading && page?.rows.length === 0 && <TableRow><TableCell colSpan={shown.length + (page.primaryKey.length ? 1 : 0)} className="h-24 text-center text-muted-foreground">Строк нет</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select value={String(view.size)} onValueChange={(value) => setView({ ...view, size: Number(value), page: 1 })}>
              <SelectTrigger aria-label="Строк на странице" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} строк</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground" data-testid="database-total">Всего: {page?.total ?? 0}</span>
            <Pagination total={page?.total ?? 0} limit={view.size} offset={(view.page - 1) * view.size} onOffsetChange={(offset) => setView({ ...view, page: offset / view.size + 1 })} />
          </div>
        </>}
      </section>
    </div>}
    {editor && <RowEditor schema={editor.table.schema} table={editor.table.name} columns={editor.columns} primaryKey={editor.table.primaryKey} row={editor.row} onClose={() => setEditor(null)} onSave={save} />}
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}>
      <DialogContent><DialogHeader><DialogTitle>Удалить строку?</DialogTitle><DialogDescription>Это нельзя отменить.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Отмена</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Удалить</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </AdminPage>;
}

function keyOf(table: TableInfo, row: Row): Row {
  return Object.fromEntries(table.primaryKey.map((column) => [column, row[column]]));
}

function ValueCell({ column, value }: { column: string; value: unknown }) {
  const text = cellText(value);
  if (value === null) return <span className="text-muted-foreground">null</span>;
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        try { if (!document.execCommand('copy')) throw new Error('Не удалось скопировать'); }
        finally { field.remove(); }
      }
      toast.success('Значение скопировано');
    } catch (error) { toast.error(messageOf(error)); }
  }
  return <Tooltip><TooltipTrigger asChild><button type="button" data-testid="database-cell" data-column={column} className="block max-w-64 truncate text-left hover:underline" title="Нажмите, чтобы скопировать" onClick={() => void copy()}>{text.slice(0, 600) || '\u00a0'}</button></TooltipTrigger>
    {text && <TooltipContent className="max-w-lg max-h-80 overflow-auto" data-testid="database-value-preview">
      <p className="mb-1 flex items-center gap-2 font-medium"><CopyIcon className="size-3" />{column}</p>
      <pre className="whitespace-pre-wrap break-all font-mono text-xs">{typeof value === 'object' ? JSON.stringify(value, null, 2) : text}</pre>
    </TooltipContent>}
  </Tooltip>;
}
