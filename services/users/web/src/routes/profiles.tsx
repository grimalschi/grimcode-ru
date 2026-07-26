import type { adminUserProfileSchema } from '@template/contracts';
import * as React from 'react';
import type { z } from 'zod';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync, type Page } from '@/hooks/use-async';

type Profile = z.infer<typeof adminUserProfileSchema>;

const LIMIT = 25;

/**
 * Product profiles.
 *
 * This is who a person is inside the product — a display name, and the language Email uses to pick
 * a template version. Passwords, sessions and admin rights live in Auth and Admin, and are neither
 * shown nor editable here.
 *
 * The sign-in address is not stored here either: Users asks Auth for it, in one call for the page.
 */
export function ProfilesPage() {
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<Profile | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useAsync<Page<Profile>>(
    () => api.listProfiles({ query: search === '' ? undefined : search, limit: LIMIT, offset }),
    [search, offset],
  );

  if (list.error) {
    return (
      <AdminPage title="Profiles">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Profiles"
      description="Who people are inside the product. Sign-in details belong to Auth."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name"
          className="w-64"
        />
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={search === '' ? 'No profiles yet.' : 'Nothing matches that search.'}
        onRowClick={setSelected}
        columns={[
          {
            key: 'person',
            header: 'Person',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.email ?? row.displayName ?? '—'}</span>
                <span className="text-muted-foreground text-xs">
                  {row.email && row.displayName ? row.displayName : null}
                  {/* Auth no longer has this identity, so the profile outlived the account. */}
                  {row.email === null ? 'No account in Auth for this profile' : null}
                </span>
              </div>
            ),
          },
          {
            key: 'identity',
            header: 'Identity',
            cell: (row) => (
              <code className="text-muted-foreground text-xs">{row.identityId}</code>
            ),
          },
          {
            key: 'created',
            header: 'Joined',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleDateString(),
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
        <ProfileDialog id={selected.id} onClose={() => setSelected(null)} />
      ) : null}
    </AdminPage>
  );
}

/**
 * One profile, read-only.
 *
 * A profile belongs to the person it describes; an administrator looking at a support question
 * needs to see it, not to edit it behind their back.
 *
 * It is read again when the dialog opens rather than shown from the row behind it: the list may
 * have been on screen for a while, and a support question is the worst moment to be looking at a
 * stale answer.
 */
function ProfileDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useAsync<{ profile: Profile }>(() => api.getProfile({ id }), [id]);
  const profile = state.data?.profile;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{profile?.email ?? profile?.displayName ?? 'Profile'}</DialogTitle>
          <DialogDescription>
            The profile is the person&apos;s to edit. This is a read-only view of it.
          </DialogDescription>
        </DialogHeader>

        {state.loading || !profile ? (
          <Skeleton className="h-40 w-full" />
        ) : (
        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Email</dt>
          <dd>{profile.email ?? 'No account in Auth'}</dd>
          <dt className="text-muted-foreground">Display name</dt>
          <dd>{profile.displayName ?? '—'}</dd>
          <dt className="text-muted-foreground">Identity</dt>
          <dd>
            <code className="text-xs break-all">{profile.identityId}</code>
          </dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd>
            <code className="text-xs break-all">{profile.id}</code>
          </dd>
          <dt className="text-muted-foreground">Language</dt>
          <dd>{profile.locale}</dd>
          <dt className="text-muted-foreground">Joined</dt>
          <dd>{new Date(profile.createdAt).toLocaleString()}</dd>
        </dl>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
