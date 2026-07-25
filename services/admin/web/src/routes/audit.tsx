import * as React from 'react';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { useAsync, type Page } from '@/hooks/use-async';

interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

const LIMIT = 50;

/**
 * Who changed administrator access, and when.
 *
 * Every grant change is recorded, including the automatic creation of the first owner, so the
 * question "who gave them access" always has an answer.
 */
export function AuditPage() {
  const [offset, setOffset] = React.useState(0);
  const list = useAsync<Page<AuditEntry>>(() => api.listAudit({ limit: LIMIT, offset }), [offset]);

  if (list.error) {
    return (
      <AdminPage title="Audit">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage title="Audit" description="Changes to administrator access.">
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="Nothing has been recorded yet."
        columns={[
          {
            key: 'createdAt',
            header: 'When',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleString(),
          },
          {
            key: 'action',
            header: 'Action',
            cell: (row) => <Badge variant="outline">{row.action}</Badge>,
          },
          {
            key: 'actor',
            header: 'By',
            cell: (row) =>
              row.actorUserId ? (
                <code className="text-xs">{row.actorUserId}</code>
              ) : (
                // The first owner is created by the system, from the registration order in Auth.
                <span className="text-muted-foreground text-sm">System</span>
              ),
          },
          {
            key: 'details',
            header: 'Details',
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
