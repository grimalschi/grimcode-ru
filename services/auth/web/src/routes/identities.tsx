import type { AdminIdentity } from '@template/contracts';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAsync, type Page } from '@/hooks/use-async';

type Identity = AdminIdentity;

const LIMIT = 25;

/**
 * The people who can sign in.
 *
 * This is identity only — an address, whether it is confirmed, whether it is blocked, and the
 * sessions it holds. Product data belongs to Users and admin rights to Admin; neither is shown or
 * editable here.
 */
export function IdentitiesPage() {
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<Identity | null>(null);

  // Typing filters the list a moment later rather than on every keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useAsync<Page<Identity>>(
    () => api.listIdentities({ query: search === '' ? undefined : search, limit: LIMIT, offset }),
    [search, offset],
  );

  if (list.error) {
    return (
      <AdminPage title="Identities">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Identities"
      description="Sign-in addresses, their confirmation state and their sessions."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by email"
          className="w-64"
        />
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={search === '' ? 'Nobody has registered yet.' : 'Nothing matches that search.'}
        onRowClick={setSelected}
        columns={[
          {
            key: 'email',
            header: 'Email',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.email}</span>
                <span className="text-muted-foreground text-xs">
                  Joined {new Date(row.createdAt).toLocaleDateString()}
                </span>
              </div>
            ),
          },
          {
            key: 'state',
            header: 'State',
            cell: (row) => (
              <div className="flex flex-wrap gap-1">
                {row.blockedAt ? (
                  <Badge variant="destructive">Blocked</Badge>
                ) : (
                  <Badge variant="outline">Active</Badge>
                )}
                {row.emailVerifiedAt ? null : <Badge variant="secondary">Unconfirmed</Badge>}
              </div>
            ),
          },
          {
            key: 'sessions',
            header: 'Sessions',
            cell: (row) => row.activeSessionCount,
          },
          {
            key: 'lastLogin',
            header: 'Last sign-in',
            className: 'whitespace-nowrap',
            cell: (row) =>
              row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : 'Never',
          },
        ]}
      />

      <Pagination
        total={list.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onOffsetChange={setOffset}
      />

      {selected ? (
        <IdentityDialog
          id={selected.id}
          onClose={() => setSelected(null)}
          onChanged={list.reload}
        />
      ) : null}
    </AdminPage>
  );
}

/**
 * What an administrator can do to one identity.
 *
 * Every action here is the ordinary flow a user would go through: a recovery link is the same
 * time-limited one-time link, and the token is never shown. There is no way to read or set a
 * password from this screen, because that would be a way to take over an account silently.
 *
 * The identity is read again on open and after every action, because the actions change it: a
 * session count still showing three after they were all revoked would be worse than showing
 * nothing.
 */
function IdentityDialog({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const state = useAsync<{ identity: Identity }>(() => api.getIdentity({ id }), [id]);
  const identity = state.data?.identity;
  const [busy, setBusy] = React.useState(false);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      state.reload();
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (!identity) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Identity</DialogTitle>
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
          <DialogTitle>{identity.email}</DialogTitle>
          <DialogDescription>
            Actions here go through the same flows a person would use themselves.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Confirmed</dt>
          <dd>
            {identity.emailVerifiedAt
              ? new Date(identity.emailVerifiedAt).toLocaleString()
              : 'Not yet'}
          </dd>
          <dt className="text-muted-foreground">Blocked</dt>
          <dd>{identity.blockedAt ? new Date(identity.blockedAt).toLocaleString() : 'No'}</dd>
          <dt className="text-muted-foreground">Sessions</dt>
          <dd>{identity.activeSessionCount}</dd>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => api.sendRecovery({ id: identity.id }), 'Recovery link sent')
            }
          >
            Send recovery link
          </Button>

          {identity.emailVerifiedAt ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.resendVerification({ id: identity.id }),
                  'Confirmation link sent',
                )
              }
            >
              Resend confirmation
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={busy || identity.activeSessionCount === 0}
            onClick={() =>
              void run(() => api.revokeSessions({ id: identity.id }), 'Every session signed out')
            }
          >
            Sign out everywhere
          </Button>
        </div>

        <DialogFooter className="sm:justify-between">
          {/* Blocking is owner-only, and the server refuses an owner blocking themselves. */}
          <Button
            variant={identity.blockedAt ? 'outline' : 'destructive'}
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.setBlocked({ id: identity.id, blocked: identity.blockedAt === null }),
                identity.blockedAt ? 'Unblocked' : 'Blocked',
              )
            }
          >
            {identity.blockedAt ? 'Unblock' : 'Block'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
