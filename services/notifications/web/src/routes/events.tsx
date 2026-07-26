import {
  NOTIFICATION_EVENT_TYPES,
  type storedNotificationEventSchema,
} from '@template/contracts';
import * as React from 'react';
import type { z } from 'zod';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAsync, type Page } from '@/hooks/use-async';

type Event = z.infer<typeof storedNotificationEventSchema>;

const LIMIT = 50;
const ANY = 'any';

const STATUSES = ['accepted', 'routed', 'failed'] as const;

/** A dot rather than a filled badge: inside a clickable row a badge reads as a button. */
const STATUS_DOT: Record<Event['status'], string> = {
  accepted: 'bg-muted-foreground',
  routed: 'bg-emerald-500',
  failed: 'bg-destructive',
};

/**
 * Everything the product asked to notify someone about.
 *
 * The list is read-only on purpose: an event is a record of something that happened, and being
 * able to edit it would make the record worthless. What can be seen is which events arrived,
 * whether each reached Email, and why one did not.
 */
export function EventsPage() {
  const [type, setType] = React.useState<string>(ANY);
  const [status, setStatus] = React.useState<string>(ANY);
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<Event | null>(null);

  const list = useAsync<Page<Event>>(
    () =>
      api.listEvents({
        type: type === ANY ? undefined : (type as Event['type']),
        status: status === ANY ? undefined : (status as Event['status']),
        limit: LIMIT,
        offset,
      }),
    [type, status, offset],
  );

  const changeFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setOffset(0);
  };

  if (list.error) {
    return (
      <AdminPage title="Events">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Events"
      description="What the product asked to notify people about, and whether it reached Email."
      actions={
        <div className="flex gap-2">
          <Select value={type} onValueChange={changeFilter(setType)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Any event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any event</SelectItem>
              {NOTIFICATION_EVENT_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={changeFilter(setStatus)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
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
        empty="No events yet."
        onRowClick={setSelected}
        columns={[
          {
            key: 'createdAt',
            header: 'When',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleString(),
          },
          { key: 'type', header: 'Event', cell: (row) => <Badge variant="outline">{row.type}</Badge> },
          { key: 'recipient', header: 'To', cell: (row) => row.recipientEmail },
          {
            key: 'status',
            header: 'Status',
            cell: (row) => (
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${STATUS_DOT[row.status]}`}
                />
                {row.status}
              </span>
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

      {selected ? <EventDialog id={selected.id} onClose={() => setSelected(null)} /> : null}
    </AdminPage>
  );
}

/**
 * One event, read again on open.
 *
 * A row in the list may have been fetched while the event was still `accepted`; by the time someone
 * opens it, it has usually been routed.
 */
function EventDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useAsync<{ event: Event }>(() => api.getEvent({ id }), [id]);
  const event = state.data?.event;

  if (!event) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Event</DialogTitle>
            <DialogDescription>Loading.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{event.type}</DialogTitle>
          <DialogDescription>
            A record of one event. Nothing here can be changed.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Recipient</dt>
          <dd>{event.recipientEmail}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{event.status}</dd>
          <dt className="text-muted-foreground">Accepted</dt>
          <dd>{new Date(event.createdAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Routed</dt>
          <dd>{event.routedAt ? new Date(event.routedAt).toLocaleString() : 'Not yet'}</dd>
          <dt className="text-muted-foreground">Delivery</dt>
          <dd>
            {/* The message itself lives in Email; this is only the link between the two. */}
            {event.deliveryId ? <code className="text-xs">{event.deliveryId}</code> : '—'}
          </dd>
          <dt className="text-muted-foreground">Idempotency key</dt>
          <dd className="truncate">
            <code className="text-xs">{event.dedupeKey}</code>
          </dd>
        </dl>

        {event.error ? (
          <p className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
            {event.error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
