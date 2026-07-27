import * as React from 'react';

import { api, messageOf } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAsync, type Page } from '@/hooks/use-async';

interface DeliveryRow {
  id: string;
  templateKey: string;
  locale: string;
  recipientEmail: string;
  subject: string;
  transport: 'log' | 'unisender';
  status: 'queued' | 'sent' | 'failed';
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface Delivery extends DeliveryRow {
  html: string;
  text: string;
}

const LIMIT = 50;
const ANY = 'any';
const STATUSES = ['queued', 'sent', 'failed'] as const;

/**
 * A status is something the row *is*, not something to press.
 *
 * A filled badge inside a clickable row reads as a button that does something of its own, so this
 * is a coloured dot next to plain text instead.
 */
const STATUS_DOT: Record<DeliveryRow['status'], string> = {
  sent: 'bg-emerald-500',
  queued: 'bg-muted-foreground',
  failed: 'bg-destructive',
};

/**
 * What was actually sent.
 *
 * Each row is an immutable snapshot taken before the message left the system, so the log can never
 * disagree with what the recipient received. The list itself carries no message bodies; one is
 * fetched only when a record is opened.
 */
export function DeliveriesPage() {
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<string>(ANY);
  const [offset, setOffset] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useAsync<Page<DeliveryRow>>(
    () =>
      api.listDeliveries({
        query: search === '' ? undefined : search,
        status: status === ANY ? undefined : (status as DeliveryRow['status']),
        limit: LIMIT,
        offset,
      }),
    [search, status, offset],
  );

  if (list.error) {
    return (
      <AdminPage title="Отправки">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Отправки"
      description="Каждое письмо, покинувшее систему, ровно в том виде, в каком его отправили."
      actions={
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по получателю или теме"
            className="w-64"
          />
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Любой статус</SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="Пока ничего не отправлено."
        onRowClick={(row) => setOpenId(row.id)}
        columns={[
          {
            key: 'createdAt',
            header: 'Когда',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleString(),
          },
          {
            key: 'recipient',
            header: 'Кому',
            cell: (row) => (
              <div className="flex flex-col">
                <span>{row.recipientEmail}</span>
                <span className="text-muted-foreground text-xs">{row.subject}</span>
              </div>
            ),
          },
          {
            key: 'template',
            header: 'Шаблон',
            cell: (row) => (
              <code className="text-xs">
                {row.templateKey} · {row.locale}
              </code>
            ),
          },
          {
            key: 'status',
            header: 'Статус',
            cell: (row) => (
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${STATUS_DOT[row.status]}`}
                  />
                  {row.status}
                </span>
                <span className="text-muted-foreground text-xs">{row.transport}</span>
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

      {openId ? <DeliveryDialog id={openId} onClose={() => setOpenId(null)} /> : null}
    </AdminPage>
  );
}

function DeliveryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useAsync<{ delivery: Delivery }>(() => api.getDelivery({ id }), [id]);
  const delivery = state.data?.delivery;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(48rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>{delivery?.subject ?? 'Письмо'}</DialogTitle>
          <DialogDescription>
            {delivery
              ? `Кому ${delivery.recipientEmail} · ${delivery.transport} · ${delivery.status}`
              : 'Загружаем'}
          </DialogDescription>
        </DialogHeader>

        {state.error ? <p className="text-sm">{messageOf(state.error)}</p> : null}

        {delivery ? (
          <Tabs defaultValue="preview" className="min-w-0">
            <TabsList>
              <TabsTrigger value="preview">Предпросмотр</TabsTrigger>
              <TabsTrigger value="html">HTML</TabsTrigger>
              <TabsTrigger value="text">Текст</TabsTrigger>
            </TabsList>

            <TabsContent value="preview">
              {/*
                The stored message is rendered in a sandboxed frame with no scripts and no access
                to this origin, so opening a record can never let its content act on the admin.
              */}
              <iframe
                title="Предпросмотр письма"
                sandbox=""
                srcDoc={delivery.html}
                className="h-96 w-full rounded-lg border bg-white"
              />
            </TabsContent>

            <TabsContent value="html">
              <pre className="bg-muted max-h-96 w-full overflow-auto rounded-lg p-3 text-xs">
                {delivery.html}
              </pre>
            </TabsContent>

            <TabsContent value="text">
              <pre className="bg-muted max-h-96 w-full overflow-auto rounded-lg p-3 text-xs break-words whitespace-pre-wrap">
                {delivery.text}
              </pre>
            </TabsContent>
          </Tabs>
        ) : null}

        {delivery?.error ? (
          <p className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
            {delivery.error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
