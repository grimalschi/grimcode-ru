import * as React from 'react';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAsync } from '@/hooks/use-async';

const LIMIT = 50;

const ROLES: Record<string, string> = { owner: 'Владелец', admin: 'Администратор' };

type Entry = Awaited<ReturnType<typeof api.listAudit.query>>['items'][number];

/**
 * The details the module records, named for a person and always in this order — the database keeps
 * its own key order. Anything else follows under its own name.
 */
const DETAIL_LABELS: Record<string, string> = {
  key: 'Шаблон',
  templateKey: 'Шаблон',
  version: 'Версия',
  to: 'Кому',
  deliveryId: 'Письмо в «Отправках»',
};
const DETAIL_ORDER = Object.keys(DETAIL_LABELS);
const rank = (key: string) => (DETAIL_ORDER.includes(key) ? DETAIL_ORDER.indexOf(key) : DETAIL_ORDER.length);

const who = (entry: Entry) => entry.actorEmail ?? (entry.actorRole ? ROLES[entry.actorRole] ?? entry.actorRole : '—');

/**
 * What administrators did with templates.
 *
 * Creation, drafts, saves that changed something, publication and test sends — who and when. The
 * letters people receive are in «Отправки»; this is the history of the templates themselves.
 */
export function AuditPage() {
  const [offset, setOffset] = React.useState(0);
  const [opened, setOpened] = React.useState<Entry | null>(null);
  const list = useAsync(
    () => api.listAudit.query({ limit: LIMIT, offset }),
    [offset],
  );

  if (list.error) {
    return (
      <AdminPage title="История шаблонов">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title="История шаблонов" description="Кто и когда менял шаблоны и отправлял тестовые письма.">
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="Пока ничего не записано."
        // The whole row opens the entry, as in the other lists of the panel; the window shows the details by name.
        onRowClick={setOpened}
        columns={[
          {
            key: 'createdAt',
            header: 'Когда',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleString(),
          },
          {
            key: 'action',
            header: 'Событие',
            cell: (row) => <Badge variant="outline">{row.action}</Badge>,
          },
          {
            key: 'who',
            header: 'Кто',
            // Entries written before the address was recorded name only the role.
            cell: (row) => <span className="text-sm">{who(row)}</span>,
          },
        ]}
      />

      <Pagination
        total={list.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onOffsetChange={setOffset}
      />

      {opened ? <EntryDetails entry={opened} onClose={() => setOpened(null)} /> : null}
    </AdminPage>
  );
}

function EntryDetails({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      {/* Focus the card itself, not its first button, as on the other cards of the panel. */}
      <DialogContent aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader>
          <DialogTitle>{entry.action}</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Когда</dt>
          <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Кто</dt>
          <dd className="break-words">{who(entry)}</dd>
          {Object.entries(entry.details).sort(([a], [b]) => rank(a) - rank(b)).map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="text-muted-foreground">{DETAIL_LABELS[key] ?? key}</dt>
              <dd className="break-all">{typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
