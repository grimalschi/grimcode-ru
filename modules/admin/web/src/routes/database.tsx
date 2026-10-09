import * as React from 'react';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, FilterIcon, Loader2Icon, PencilIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import { AdminPage, EmptyState, ErrorState } from '@/components/layout/admin-page';
import { Pagination } from '@/components/layout/data-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Filters } from '@/database/filters';
import { cellText, emptyView, isFilterReady, messageOf, PAGE_SIZES, readView, shortType, type Column, type Row, type TableInfo } from '@/database/model';
import { RowEditor } from '@/database/row-editor';
import { SchemaTables, type SchemaCatalogue } from '@/database/schema-tables';
import { useAsync } from '@/hooks/use-async';
import { useDebounced } from '@/hooks/use-debounced';

export function DatabasePage() {
  const [view, setView] = React.useState(readView);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [editor, setEditor] = React.useState<{ table: TableInfo; columns: Column[]; row: Row | null } | null>(null);
  const [deleting, setDeleting] = React.useState<{ table: TableInfo; row: Row } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [open, setOpen] = React.useState<string[]>(() => (view.schema ? [view.schema] : []));
  const schemas = useAsync(() => api.database.schemas.query({}), []);
  /*
   * Every schema's table list, loaded once and kept by schema name. A late answer can only land
   * under its own schema, so switching schemas while a request is in flight cannot mix lists.
   */
  const [catalogues, setCatalogues] = React.useState<Record<string, SchemaCatalogue>>({});
  const loadCatalogue = React.useCallback(async (schema: string) => {
    try {
      const { tables } = await api.database.tables.query({ schema });
      setCatalogues((previous) => ({ ...previous, [schema]: { tables } }));
    } catch (error) {
      setCatalogues((previous) => ({ ...previous, [schema]: { error } }));
    }
  }, []);
  const tables = catalogues[view.schema]?.tables ?? [];
  const selected = tables.find((table) => table.name === view.table);
  /*
   * Typing into a filter changes the view on every keystroke. The request waits until the typing
   * pauses; the rest of the view — table, page, sorting — is asked for at once. While any condition
   * is still unfilled nothing is asked at all and the table keeps its last page: in a chain, leaving
   * one condition out would change what its neighbours' И and ИЛИ mean. The settled filters are
   * remembered with their table, so a table opened mid-pause is never asked with the last table's
   * conditions.
   */
  const ready = view.filters.every(isFilterReady);
  const wanted = JSON.stringify({ schema: view.schema, table: view.table, filters: view.filters, caseSensitive: view.caseSensitive });
  const [held, setHeld] = React.useState(() => (ready ? wanted : JSON.stringify({ schema: view.schema, table: view.table, filters: [], caseSensitive: view.caseSensitive })));
  React.useEffect(() => { if (ready) setHeld(wanted); }, [ready, wanted]);
  const settled = JSON.parse(useDebounced(held, 300)) as { schema: string; table: string; filters: typeof view.filters; caseSensitive: boolean };
  const query = {
    schema: view.schema, table: view.table, caseSensitive: settled.caseSensitive,
    filters: settled.schema === view.schema && settled.table === view.table ? settled.filters : [],
    order: view.order, limit: view.size, offset: (view.page - 1) * view.size,
  };
  const queryKey = JSON.stringify(query);
  const listing = useAsync(async () => ({ key: queryKey, schema: query.schema, table: query.table, page: query.table
    ? await api.database.rows.query(query) : null }), [queryKey]);
  /*
   * While a new page is on its way, the previous one of the same table stays on screen: replacing
   * rows with a placeholder on every change made the table jump under the cursor. Another table's
   * page is never kept — its columns are not these.
   */
  const current = listing.data?.key === queryKey ? listing.data.page : null;
  const previous = listing.data && listing.data.schema === view.schema && listing.data.table === view.table ? listing.data.page : null;
  const page = current ?? previous;
  const columns = page?.columns ?? selected?.columns ?? [];
  const readOnlyReason = page ? page.readOnlyReason : selected?.readOnlyReason ?? null;
  const deleteReadOnlyReason = readOnlyReason ?? (page ? page.deleteReadOnlyReason : selected?.deleteReadOnlyReason ?? null);
  const notice = page ? page.notice : selected?.notice ?? null;
  const currentTable = selected ? { ...selected, primaryKey: page?.primaryKey ?? selected.primaryKey, readOnlyReason, deleteReadOnlyReason } : null;
  const blockedInsert = columns.some((column) => column.readOnlyReason && !column.generated && !column.hasDefault && !column.nullable);
  const shown = view.columns.length ? columns.filter((column) => view.columns.includes(column.name)) : columns;
  const loading = !!view.table && (listing.loading || !current);

  React.useEffect(() => {
    if (!schemas.data) return;
    if (!schemas.data.schemas.some(({ name }) => name === view.schema)) {
      setView({ ...emptyView(), schema: schemas.data.schemas[0]?.name ?? '' });
    }
  }, [schemas.data, view.schema]);
  // Lists are small and few: reading them all up front is what makes opening a section instant.
  React.useEffect(() => {
    for (const { name } of schemas.data?.schemas ?? []) void loadCatalogue(name);
  }, [schemas.data, loadCatalogue]);
  React.useEffect(() => {
    if (!page) return;
    const last = Math.max(1, Math.ceil(page.total / view.size));
    if (view.page > last) setView((previous) => ({ ...previous, page: last }));
  }, [page, view.page, view.size]);
  React.useEffect(() => { setCounts({}); }, [catalogues]);
  React.useEffect(() => {
    if (view.schema) setOpen((previous) => (previous.includes(view.schema) ? previous : [...previous, view.schema]));
  }, [view.schema]);
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
      await api.database.update.mutate({ ...target, original: editor.row, values });
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
      await api.database.delete.mutate({ schema: deleting.table.schema, table: deleting.table.name, original: deleting.row });
      counted(deleting.table, -1);
      setDeleting(null);
      toast.success('Строка удалена');
      listing.reload();
    } catch (error) { toast.error(messageOf(error)); }
    finally { setBusy(false); }
  }

  return <AdminPage title="База данных" className="h-full min-h-0 max-w-none">
    {schemas.error ? <ErrorState error={schemas.error} retry={schemas.reload} /> : <div className="grid min-h-0 flex-1 gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-y-auto">
        {/*
          Any number of schemas open at once; opening and closing them is browsing and changes
          nothing in the view. The schema of the shown table is always open, so a restored address
          lands on a visible table. Each open section loads its own tables (see SchemaTables).
        */}
        <Accordion type="multiple" value={open} onValueChange={setOpen} aria-label="Схемы">
          {schemas.data?.schemas.map(({ name }) => <AccordionItem key={name} value={name}>
            <AccordionTrigger aria-label={`Схема ${name}`}><span className="truncate font-mono">{name}</span></AccordionTrigger>
            <AccordionContent>
              <SchemaTables schema={name} catalogue={catalogues[name]} selected={view.schema === name ? view.table : null} counts={counts} onOpen={openTable} onRetry={() => void loadCatalogue(name)} />
            </AccordionContent>
          </AccordionItem>)}
        </Accordion>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col gap-4">
        {!view.table ? <EmptyState title="Выберите таблицу" /> : <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-medium" data-testid="database-table-title">{view.schema}.{view.table}</h2>
            <Button variant="outline" size="sm" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}><FilterIcon />Фильтры{view.filters.length ? ` (${view.filters.length})` : ''}</Button>
            {view.columns.length > 0 && <Button variant="ghost" size="sm" onClick={() => setView({ ...view, columns: [] })}>Показать все колонки</Button>}
            <Button className="ml-auto" size="sm" disabled={!page || loading || !currentTable || !!readOnlyReason || blockedInsert} onClick={() => currentTable && setEditor({ table: currentTable, columns, row: null })}>Добавить строку</Button>
          </div>
          {filtersOpen && <Filters columns={columns} filters={view.filters} caseSensitive={view.caseSensitive} onChange={(filters, caseSensitive) => setView({ ...view, filters, caseSensitive, page: 1 })} />}
          {notice && <p role="note" data-testid="database-notice" className="rounded-md border px-3 py-2 text-sm">{notice}</p>}
          {readOnlyReason && <p role="status" className="text-sm text-muted-foreground">Только чтение: {readOnlyReason}</p>}
          {!readOnlyReason && blockedInsert && <p className="text-xs text-muted-foreground">Добавление недоступно: обязательная колонка имеет неподдержанный тип.</p>}
          {!readOnlyReason && deleteReadOnlyReason && <p className="text-xs text-muted-foreground">Удаление недоступно: {deleteReadOnlyReason}</p>}
          {listing.error ? <ErrorState error={listing.error} retry={listing.reload} /> : <TooltipProvider delayDuration={250}>
            {/*
              The scroll position is the table's own: filtering, sorting and paging redraw the rows in
              place and leave it where the person put it, so a column in the middle of a wide table
              stays in view while conditions are typed. Another table gets a fresh container (the key)
              and so starts at the top left — its columns are not these. Resetting the old container
              in an effect did not take: the browser had already clamped the position to the new width.
            */}
            <div key={`${view.schema}.${view.table}`} className="min-h-0 flex-1 overflow-auto rounded-lg border">
              <Table data-testid="database-table" aria-busy={loading} className={loading && page ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
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
                  {page ? <TableHead className="w-20"><span className="sr-only">Действия</span></TableHead> : null}
                </TableRow></TableHeader>
                <TableBody>
                  {loading && !page ? Array.from({ length: 5 }, (_, row) => <TableRow key={row}>{shown.map((column) => <TableCell key={column.name}><Skeleton className="h-4 w-28" /></TableCell>)}</TableRow>)
                    : page?.rows.map((row, index) => <TableRow key={page.primaryKey.length ? JSON.stringify(page.primaryKey.map((column) => row[column])) : index}>
                      {shown.map((column) => <TableCell key={column.name}><ValueCell column={column.name} value={row[column.name]} /></TableCell>)}
                      {currentTable ? <TableCell><div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="size-7" aria-label="Открыть строку" title="Открыть строку" onClick={() => setEditor({ table: currentTable, columns, row })}><PencilIcon className="size-4" /></Button>
                        <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label="Удалить строку" title={deleteReadOnlyReason ?? 'Удалить строку'} disabled={!!deleteReadOnlyReason} onClick={() => setDeleting({ table: currentTable, row })}><Trash2Icon className="size-4" /></Button>
                      </div></TableCell> : null}
                    </TableRow>)}
                  {!loading && page?.rows.length === 0 && <TableRow><TableCell colSpan={shown.length + 1} className="h-24 text-center text-muted-foreground">Строк нет</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select value={String(view.size)} onValueChange={(value) => setView({ ...view, size: Number(value), page: 1 })}>
              <SelectTrigger aria-label="Строк на странице" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} строк</SelectItem>)}</SelectContent>
            </Select>
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="database-total">
              {loading && page && <Loader2Icon className="size-3.5 animate-spin" aria-label="Загрузка" />}Всего: {page?.total ?? 0}
            </span>
            <Pagination total={page?.total ?? 0} limit={view.size} offset={(view.page - 1) * view.size} onOffsetChange={(offset) => setView({ ...view, page: offset / view.size + 1 })} />
          </div>
        </>}
      </section>
    </div>}
    {editor && <RowEditor schema={editor.table.schema} table={editor.table.name} columns={editor.columns} primaryKey={editor.table.primaryKey} readOnlyReason={editor.table.readOnlyReason} notice={notice} row={editor.row} onClose={() => setEditor(null)} onSave={save} />}
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}>
      <DialogContent><DialogHeader><DialogTitle>Удалить строку?</DialogTitle><DialogDescription>Это нельзя отменить.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Отмена</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Удалить</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </AdminPage>;
}

function ValueCell({ column, value }: { column: string; value: string | null | undefined }) {
  const text = cellText(value);
  if (value === null) return <span data-testid="database-cell" data-column={column} className="text-muted-foreground">SQL NULL</span>;
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Браузер не поддерживает безопасное копирование.');
      await navigator.clipboard.writeText(text);
      toast.success('Значение скопировано');
    } catch (error) { toast.error(messageOf(error)); }
  }
  return <Tooltip><TooltipTrigger asChild><button type="button" data-testid="database-cell" data-column={column} className="block max-w-64 truncate text-left hover:underline" title="Нажмите, чтобы скопировать" onClick={() => void copy()}>{text.slice(0, 600) || '""'}</button></TooltipTrigger>
    {text && <TooltipContent className="max-w-lg max-h-80 overflow-auto" data-testid="database-value-preview">
      <p className="mb-1 flex items-center gap-2 font-medium"><CopyIcon className="size-3" />{column}</p>
      <pre className="whitespace-pre-wrap break-all font-mono text-xs">{text}</pre>
    </TooltipContent>}
  </Tooltip>;
}
