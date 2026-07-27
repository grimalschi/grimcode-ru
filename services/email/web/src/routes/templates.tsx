import { Link } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск"
            className="w-56"
          />
          <NewTemplate onCreated={list.reload} />
        </div>
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

function NewTemplate({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [name, setName] = React.useState('');
  const [variables, setVariables] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createTemplate({
        key: key.trim(),
        name: name.trim(),
        description: null,
        variables: variables
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      });
      toast.success('Шаблон создан');
      setOpen(false);
      setKey('');
      setName('');
      setVariables('');
      onCreated();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Новый шаблон</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый шаблон</DialogTitle>
          <DialogDescription>
            По ключу на шаблон ссылается код, поэтому потом он не меняется.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key">Ключ</Label>
            <Input
              id="key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="order-shipped"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Название</Label>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Order shipped"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="variables">Переменные</Label>
            <Input
              id="variables"
              value={variables}
              onChange={(event) => setVariables(event.target.value)}
              placeholder="email, trackingUrl"
            />
            <p className="text-muted-foreground text-xs">
              Через запятую. Публикация отклонит документ, который использует что-то не из этого списка.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || key.trim() === '' || name.trim() === ''}>
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
