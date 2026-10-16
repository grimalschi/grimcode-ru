import * as React from 'react';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { useAsync } from '@/hooks/use-async';

const LIMIT = 50;

const ROLES: Record<string, string> = { owner: 'Владелец', admin: 'Администратор' };

/**
 * What administrators did with templates.
 *
 * Creation, drafts, saves that changed something, publication and test sends — who and when. The
 * letters people receive are in «Отправки»; this is the history of the templates themselves.
 */
export function AuditPage() {
  const [offset, setOffset] = React.useState(0);
  const list = useAsync(
    () => api.listAudit.query({ limit: LIMIT, offset }),
    [offset],
  );

  if (list.error) {
    return (
      <AdminPage title="Журнал">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title="Журнал" description="Кто и когда менял шаблоны и отправлял тестовые письма.">
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="Пока ничего не записано."
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
            cell: (row) => (
              <span className="text-sm">
                {row.actorEmail ?? (row.actorRole ? ROLES[row.actorRole] ?? row.actorRole : '—')}
              </span>
            ),
          },
          {
            key: 'details',
            header: 'Подробности',
            cell: (row) =>
              Object.keys(row.details).length > 0 ? (
                <code className="text-muted-foreground text-xs">{JSON.stringify(row.details)}</code>
              ) : null,
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
