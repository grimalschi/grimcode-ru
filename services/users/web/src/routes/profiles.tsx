import type { z } from 'zod';
import type { adminUserProfileSchema } from '@template/contracts';
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

type Profile = z.infer<typeof adminUserProfileSchema>;

const LIMIT = 25;

/**
 * Product profiles.
 *
 * This is who a person is inside the product — their name, language, time zone and preferences —
 * and nothing about how they sign in. Passwords, sessions and admin rights live in Auth and Admin,
 * and are neither shown nor editable here.
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
      description="Product profiles. Sign-in details belong to Auth and are not shown here."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or email"
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
            key: 'name',
            header: 'Person',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.displayName ?? 'No name yet'}</span>
                <span className="text-muted-foreground text-xs">
                  {/* Auth owns the address; it is shown for recognition, not edited here. */}
                  {row.email ?? 'Identity removed'}
                </span>
              </div>
            ),
          },
          {
            key: 'onboarding',
            header: 'Onboarding',
            cell: (row) =>
              row.onboardingCompletedAt ? (
                <Badge variant="outline">
                  Finished {new Date(row.onboardingCompletedAt).toLocaleDateString()}
                </Badge>
              ) : (
                <Badge variant="secondary">Not finished</Badge>
              ),
          },
          {
            key: 'locale',
            header: 'Language',
            cell: (row) => row.preferences.locale,
          },
          {
            key: 'timeZone',
            header: 'Time zone',
            cell: (row) => row.timeZone ?? '—',
          },
        ]}
      />

      <Pagination
        total={list.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onOffsetChange={setOffset}
      />

      <ProfileDialog profile={selected} onClose={() => setSelected(null)} onChanged={list.reload} />
    </AdminPage>
  );
}

function ProfileDialog({
  profile,
  onClose,
  onChanged,
}: {
  profile: Profile | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  if (!profile) return null;

  const reset = async () => {
    setBusy(true);
    try {
      await api.resetOnboarding({ id: profile.id });
      toast.success('Onboarding will run again for this person');
      onChanged();
      onClose();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{profile.displayName ?? profile.email ?? 'Profile'}</DialogTitle>
          <DialogDescription>
            An administrator can restart onboarding; the profile itself is the person's to edit.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Email</dt>
          <dd>{profile.email ?? '—'}</dd>
          <dt className="text-muted-foreground">Language</dt>
          <dd>{profile.preferences.locale}</dd>
          <dt className="text-muted-foreground">Theme</dt>
          <dd>{profile.preferences.theme}</dd>
          <dt className="text-muted-foreground">Product emails</dt>
          <dd>{profile.preferences.productEmails ? 'Yes' : 'No'}</dd>
          <dt className="text-muted-foreground">Time zone</dt>
          <dd>{profile.timeZone ?? '—'}</dd>
          <dt className="text-muted-foreground">Joined</dt>
          <dd>{new Date(profile.createdAt).toLocaleString()}</dd>
        </dl>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || profile.onboardingCompletedAt === null}
            onClick={() => void reset()}
          >
            Restart onboarding
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
