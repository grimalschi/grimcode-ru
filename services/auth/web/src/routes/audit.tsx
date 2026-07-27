import type { authAuditEntrySchema } from '@template/contracts';
import * as React from 'react';
import type { z } from 'zod';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { useAsync, type Page } from '@/hooks/use-async';

type AuditEntry = z.infer<typeof authAuditEntrySchema>;

const LIMIT = 50;

/**
 * Security events.
 *
 * Sign-ins, failures, password changes, recovery, confirmation and session revocation — what
 * happened, when, and whether a person or an administrator caused it.
 */
export function AuditPage() {
  const [offset, setOffset] = React.useState(0);
  const list = useAsync<Page<AuditEntry>>(() => api.listAudit({ limit: LIMIT, offset }), [offset]);

  if (list.error) {
    return (
      <AdminPage title="Журнал безопасности">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title="Журнал безопасности" description="Что происходило с аккаунтами и сессиями.">
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
            cell: (row) =>
              row.actorUserId ? (
                <span className="text-sm">Администратор</span>
              ) : (
                <span className="text-muted-foreground text-sm">Сам человек</span>
              ),
          },
          {
            key: 'details',
            header: 'Подробности',
            cell: (row) => (
              <code className="text-muted-foreground text-xs">{JSON.stringify(row.details)}</code>
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
