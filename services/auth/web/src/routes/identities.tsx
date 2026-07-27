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
      <AdminPage title="Пользователи">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Пользователи"
      description="Адреса для входа, их подтверждение и сессии."
      actions={
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по адресу"
          className="w-64"
        />
      }
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={search === '' ? 'Ещё никто не регистрировался.' : 'Ничего не найдено.'}
        onRowClick={setSelected}
        columns={[
          {
            key: 'email',
            header: 'Адрес',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.email}</span>
                <span className="text-muted-foreground text-xs">
                  С {new Date(row.createdAt).toLocaleDateString()}
                </span>
              </div>
            ),
          },
          {
            key: 'state',
            header: 'Состояние',
            cell: (row) => (
              <div className="flex flex-wrap gap-1">
                {row.blockedAt ? (
                  <Badge variant="destructive">Заблокирован</Badge>
                ) : (
                  <Badge variant="outline">Активен</Badge>
                )}
                {row.emailVerifiedAt ? null : <Badge variant="secondary">Не подтверждён</Badge>}
              </div>
            ),
          },
          {
            key: 'sessions',
            header: 'Сессии',
            cell: (row) => row.activeSessionCount,
          },
          {
            key: 'lastLogin',
            header: 'Последний вход',
            className: 'whitespace-nowrap',
            cell: (row) =>
              row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : 'Никогда',
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
            <DialogTitle>Пользователь</DialogTitle>
            <DialogDescription>Загружаем.</DialogDescription>
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
            Действия здесь идут теми же путями, которыми прошёл бы сам человек.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Подтверждён</dt>
          <dd>
            {identity.emailVerifiedAt
              ? new Date(identity.emailVerifiedAt).toLocaleString()
              : 'Ещё нет'}
          </dd>
          <dt className="text-muted-foreground">Заблокирован</dt>
          <dd>{identity.blockedAt ? new Date(identity.blockedAt).toLocaleString() : 'Нет'}</dd>
          <dt className="text-muted-foreground">Сессии</dt>
          <dd>{identity.activeSessionCount}</dd>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => api.sendRecovery({ id: identity.id }), 'Ссылка восстановления отправлена')
            }
          >
            Отправить ссылку восстановления
          </Button>

          {identity.emailVerifiedAt ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.resendVerification({ id: identity.id }),
                  'Ссылка подтверждения отправлена',
                )
              }
            >
              Отправить подтверждение снова
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={busy || identity.activeSessionCount === 0}
            onClick={() =>
              void run(() => api.revokeSessions({ id: identity.id }), 'Все сессии завершены')
            }
          >
            Завершить все сессии
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
                identity.blockedAt ? 'Разблокирован' : 'Заблокирован',
              )
            }
          >
            {identity.blockedAt ? 'Разблокировать' : 'Заблокировать'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
