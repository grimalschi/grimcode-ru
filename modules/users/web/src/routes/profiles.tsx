import * as React from 'react';
import type { AdminUserProfile as Profile } from '@template/contracts/modules/users';
import { toast } from 'sonner';

import { api, messageOf } from '@/api';
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
import { useAsync } from '@/hooks/use-async';

const LIMIT = 25;

/**
 * Product profiles.
 *
 * This is who a person is inside the product — a display name. Passwords, sessions and admin
 * rights live in Auth and Admin, and are neither shown nor editable here.
 *
 * The sign-in address is not stored here either: Users asks Auth for it, in one call for the page,
 * together with whether the account is blocked. Blocking is the one thing the owner does from this
 * list (the owner's choice, 13 October 2026: this is where the people are); Auth performs it and
 * refuses it for the panel's owners.
 */
export function ProfilesPage() {
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<Profile | null>(null);
  const [blocking, setBlocking] = React.useState<Profile | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const viewer = useAsync(() => api.viewer.query({}), []);
  const list = useAsync(
    () =>
      api.listProfiles.query({ query: search === '' ? undefined : search, limit: LIMIT, offset }),
    [search, offset],
  );
  const owner = viewer.data?.role === 'owner';

  async function setBlocked(profile: Profile, blocked: boolean) {
    setBusy(profile.id);
    try {
      await api.setBlocked.mutate({ identityId: profile.identityId, blocked });
      toast.success(blocked ? 'Аккаунт заблокирован' : 'Аккаунт разблокирован');
      list.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(null);
      setBlocking(null);
    }
  }

  if (list.error) {
    return (
      <AdminPage title="Профили">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Профили"
      description="Кто эти люди внутри продукта. Данные для входа принадлежат Auth."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по имени"
          className="w-64"
        />
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={search === '' ? 'Профилей пока нет.' : 'Ничего не найдено.'}
        onRowClick={setSelected}
        columns={[
          {
            key: 'person',
            header: 'Человек',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.email ?? row.displayName ?? '—'}</span>
                <span className="text-muted-foreground text-xs">
                  {row.email && row.displayName ? row.displayName : null}
                  {/* Auth no longer has this identity, so the profile outlived the account. */}
                  {row.email === null ? 'В Auth нет аккаунта для этого профиля' : null}
                </span>
              </div>
            ),
          },
          {
            key: 'access',
            header: 'Вход',
            className: 'whitespace-nowrap',
            cell: (row) => <AccessState profile={row} />,
          },
          {
            key: 'created',
            header: 'Профиль создан',
            className: 'whitespace-nowrap',
            cell: (row) => new Date(row.createdAt).toLocaleDateString(),
          },
          ...(owner ? [{
            key: 'block',
            header: '',
            className: 'w-px whitespace-nowrap text-right',
            cell: (row: Profile) => (
              <BlockButton
                profile={row}
                self={row.identityId === viewer.data?.userId}
                busy={busy === row.id}
                onClick={() => (row.blockedAt ? void setBlocked(row, false) : setBlocking(row))}
              />
            ),
          }] : []),
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

      {blocking ? (
        <Dialog open onOpenChange={(open) => !open && busy === null && setBlocking(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Заблокировать {blocking.email ?? blocking.displayName ?? 'аккаунт'}?</DialogTitle>
              <DialogDescription>
                Вход будет запрещён, а открытые сессии завершатся. Разблокировать можно здесь же.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setBlocking(null)}>
                Отмена
              </Button>
              <Button variant="destructive" size="sm" disabled={busy !== null} onClick={() => void setBlocked(blocking, true)}>
                Заблокировать
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </AdminPage>
  );
}

/** Whether the account can sign in, as Auth sees it. */
function AccessState({ profile }: { profile: Profile }) {
  if (profile.email === null) return <span className="text-muted-foreground">—</span>;
  if (profile.blockedAt) {
    return <span className="text-destructive">Заблокирован с {new Date(profile.blockedAt).toLocaleDateString()}</span>;
  }
  return <span className="text-muted-foreground">Открыт</span>;
}

/**
 * Block or unblock, for the owner. Not offered for an account Auth cannot block — the panel's
 * owners (take the role away first) and the owner's own — nor for a profile without an account;
 * the reason stands in the button's title, so nothing has to be guessed.
 */
function BlockButton({ profile, self, busy, onClick }: {
  profile: Profile;
  self: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  if (profile.email === null) return null;
  const protectedOwner = profile.blockingProtectedAt !== null && !profile.blockedAt;
  const reason = self
    ? 'Нельзя заблокировать собственный аккаунт'
    : protectedOwner ? 'Владелец панели: сначала снимите роль в «Администраторах»' : undefined;
  return (
    <Button
      variant="outline"
      size="sm"
      // A red outline at rest, filled red under the pointer: a list of people is not a wall of red (the owner, 14 October).
      className={profile.blockedAt ? undefined : 'border-destructive/60 text-destructive hover:bg-destructive hover:text-white dark:border-destructive/60 dark:bg-transparent dark:hover:bg-destructive/60'}
      disabled={busy || reason !== undefined}
      title={reason}
      aria-label={`${profile.blockedAt ? 'Разблокировать' : 'Заблокировать'} ${profile.email}`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      {profile.blockedAt ? 'Разблокировать' : 'Заблокировать'}
    </Button>
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
  const state = useAsync(() => api.getProfile.query({ id }), [id]);
  const profile = state.data?.profile;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Focus the card itself, not its first button: a ring on «Закрыть» or the cross read as a border, and differed card to card. */}
      <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader>
          <DialogTitle>{profile?.email ?? profile?.displayName ?? 'Профиль'}</DialogTitle>
          <DialogDescription>
            Профиль редактирует сам человек. Здесь он только для чтения.
          </DialogDescription>
        </DialogHeader>

        {state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : state.loading || !profile ? (
          <Skeleton className="h-40 w-full" />
        ) : (
        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Почта</dt>
          <dd>{profile.email ?? 'В Auth нет аккаунта'}</dd>
          <dt className="text-muted-foreground">Вход</dt>
          <dd><AccessState profile={profile} /></dd>
          <dt className="text-muted-foreground">Отображаемое имя</dt>
          <dd>{profile.displayName ?? '—'}</dd>
          <dt className="text-muted-foreground">Учётная запись</dt>
          <dd>
            <code className="text-xs break-all">{profile.identityId}</code>
          </dd>
          <dt className="text-muted-foreground">Профиль</dt>
          <dd>
            <code className="text-xs break-all">{profile.id}</code>
          </dd>
          <dt className="text-muted-foreground">Профиль создан</dt>
          <dd>{new Date(profile.createdAt).toLocaleString()}</dd>
        </dl>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
