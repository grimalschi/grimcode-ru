import { Link } from '@tanstack/react-router';
import * as React from 'react';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useAsync, type Page } from '@/hooks/use-async';

interface Template {
  id: string;
  key: string;
  name: string;
  description: string | null;
  variables: string[];
  updatedAt: string;
}

const LIMIT = 25;

/**
 * The messages the product can send.
 *
 * A template has a stable key the code refers to, a human name, and the list of variables its
 * document may use. Content itself lives in versions, one series per language.
 *
 * There is no way to create one from here on purpose. A template only means something once code
 * sends it, and its key and variables are that code's side of the agreement — inventing them in a
 * form would produce a template nothing ever delivers. They are added to the seed instead, and
 * appear on the next start. What this screen is for is the wording.
 */
export function TemplatesPage() {
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useAsync<Page<Template>>(
    () => api.listTemplates({ query: search === '' ? undefined : search, limit: LIMIT, offset }),
    [search, offset],
  );

  if (list.error) {
    return (
      <AdminPage title="Шаблоны">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Шаблоны"
      description="Все письма, которые может отправить продукт. Содержимое живёт в версиях, по одной на язык."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск"
          className="w-56"
        />
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="Шаблонов пока нет."
        columns={[
          {
            key: 'name',
            header: 'Шаблон',
            cell: (row) => (
              <Link
                to="/templates/$templateId"
                params={{ templateId: row.id }}
                className="flex flex-col"
              >
                <span className="font-medium underline-offset-4 hover:underline">{row.name}</span>
                <code className="text-muted-foreground text-xs">{row.key}</code>
              </Link>
            ),
          },
          {
            key: 'description',
            header: 'Когда отправляется',
            cell: (row) => (
              <span className="text-muted-foreground text-sm">{row.description ?? '—'}</span>
            ),
          },
          {
            key: 'variables',
            header: 'Переменные',
            cell: (row) =>
              row.variables.length === 0 ? (
                <span className="text-muted-foreground text-sm">Нет</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {row.variables.map((variable) => (
                    <Badge key={variable} variant="outline">
                      {variable}
                    </Badge>
                  ))}
                </div>
              ),
          },
        ]}
      />

      <Pagination
        total={list.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onOffsetChange={setOffset}
      />
    </AdminPage>
  );
}

