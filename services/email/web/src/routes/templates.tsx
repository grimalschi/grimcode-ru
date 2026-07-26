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
      <AdminPage title="Templates">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Templates"
      description="Every message the product can send. Content lives in versions, one per language."
      actions={
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
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
        empty="No templates yet."
        columns={[
          {
            key: 'name',
            header: 'Template',
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
            header: 'Sent when',
            cell: (row) => (
              <span className="text-muted-foreground text-sm">{row.description ?? '—'}</span>
            ),
          },
          {
            key: 'variables',
            header: 'Variables',
            cell: (row) =>
              row.variables.length === 0 ? (
                <span className="text-muted-foreground text-sm">None</span>
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
      toast.success('Template created');
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
        <Button>New template</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            The key is what the code refers to, so it does not change afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key">Key</Label>
            <Input
              id="key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="order-shipped"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Order shipped"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="variables">Variables</Label>
            <Input
              id="variables"
              value={variables}
              onChange={(event) => setVariables(event.target.value)}
              placeholder="email, trackingUrl"
            />
            <p className="text-muted-foreground text-xs">
              Comma separated. Publishing refuses a document that uses anything not listed here.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || key.trim() === '' || name.trim() === ''}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
