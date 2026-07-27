import type { sessionSummarySchema, UserProfile } from '@template/contracts';
import type { z } from 'zod';
import * as React from 'react';
import { toast } from 'sonner';

import { auth, messageOf, users } from '@/api';
import { Page } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAsync } from '@/hooks/use-async';
import { useSession } from '@/session';

type SessionRow = z.infer<typeof sessionSummarySchema>;

/**
 * One settings screen with sections, not three top-level areas.
 *
 * "Profile", "Settings" and "Account" as separate destinations only make a person guess which of
 * the three holds the thing they came for. The sections below are split by who owns the data:
 * Users owns the profile and preferences, Auth owns the account, its security and its sessions.
 */
export function SettingsScreen() {
  return (
    <Page title="Настройки">
      <Tabs defaultValue="profile" className="max-w-2xl">
        <TabsList>
          <TabsTrigger value="profile">Профиль</TabsTrigger>
          <TabsTrigger value="account">Аккаунт</TabsTrigger>
          <TabsTrigger value="security">Безопасность</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          <ProfileSection />
        </TabsContent>
        <TabsContent value="account" className="space-y-6">
          <AccountSection />
        </TabsContent>
        <TabsContent value="security" className="space-y-6">
          <PasswordSection />
          <SessionsSection />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function ProfileSection() {
  const state = useAsync<{ profile: UserProfile }>(() => users.getOwnProfile({}), []);
  const [displayName, setDisplayName] = React.useState('');
  const [prefilled, setPrefilled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (prefilled || !state.data) return;
    setDisplayName(state.data.profile.displayName ?? '');
    setPrefilled(true);
  }, [prefilled, state.data]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await users.updateOwnProfile({
        displayName: displayName.trim() === '' ? null : displayName.trim(),
      });
      toast.success('Сохранено');
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <Skeleton className="h-48 w-full" />;

  // Without this, a failed load left an empty field that looks like an empty name — and saving it
  // would have written that emptiness back over the real one.
  if (state.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Профиль</CardTitle>
          <CardDescription>{messageOf(state.error)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={state.reload}>
            Попробовать снова
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Профиль</CardTitle>
        <CardDescription>Как вас видно внутри продукта.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">Отображаемое имя</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Сохранить
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AccountSection() {
  const { identity, refresh } = useSession();
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const requestChange = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.requestEmailChange({ email });
      // The address only changes once the link in the new mailbox is opened; saying so avoids the
      // impression that it already did.
      toast.success('Подтвердите изменение по ссылке, отправленной на новый адрес');
      setEmail('');
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      await auth.resendOwnVerification({});
      toast.success('Новая ссылка подтверждения отправлена');
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Аккаунт</CardTitle>
        <CardDescription>Адрес, с которым вы входите.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2 text-sm">
          <p className="font-medium">{identity?.email}</p>
          {identity?.emailVerifiedAt === null ? (
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">Ещё не подтверждён.</span>
              <Button variant="outline" size="sm" onClick={() => void resend()}>
                Отправить новую ссылку
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">Подтверждён.</p>
          )}
        </div>

        <form onSubmit={requestChange} className="space-y-2">
          <Label htmlFor="newEmail">Сменить адрес</Label>
          <div className="flex gap-2">
            <Input
              id="newEmail"
              type="email"
              value={email}
              placeholder="new@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" disabled={busy || email.trim() === ''}>
              Отправить
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Новый адрес нужно подтвердить, а старому мы сообщим об изменении.
          </p>
        </form>

        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          Обновить
        </Button>
      </CardContent>
    </Card>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.changePassword({ currentPassword, password: newPassword });
      toast.success('Пароль изменён. Все остальные сессии завершены.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Пароль</CardTitle>
        <CardDescription>Смена пароля завершает все остальные сессии.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Текущий пароль</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">Новый пароль</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Изменить пароль
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsSection() {
  const state = useAsync<{ sessions: SessionRow[] }>(() => auth.listOwnSessions({}), []);
  const [busy, setBusy] = React.useState(false);

  // Auth revokes every session of the caller, this browser included — that is what makes it a
  // useful answer to "someone else may have my session".
  const revokeAll = async () => {
    setBusy(true);
    try {
      await auth.revokeOwnSessions({});
      window.location.assign('/app/login');
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Где вы вошли</CardTitle>
        <CardDescription>
          Каждый браузер, в котором сейчас есть действующая сессия. Сверху — новые.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : state.error ? (
          // An empty list would read as "signed in nowhere", which is the opposite of the truth.
          <p className="text-muted-foreground text-sm">{messageOf(state.error)}</p>
        ) : (
          /*
            Scrolls rather than growing: someone who signs in from a phone, a laptop and a work
            machine builds this list up over months, and it would otherwise push the button that
            ends them all off the screen.
          */
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1 text-sm">
            {(state.data?.sessions ?? []).map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
              >
                <span className="min-w-0 flex-1">
                  <span className="block">
                    Начата {new Date(session.createdAt).toLocaleString()}
                    {session.current ? ' — этот браузер' : ''}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {session.userAgent ?? 'Неизвестный браузер'}
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
                  Активна {new Date(session.lastSeenAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button variant="outline" onClick={() => void revokeAll()} disabled={busy}>
          Выйти везде
        </Button>
        <p className="text-muted-foreground text-xs">
          Завершит сессии во всех браузерах, включая этот.
        </p>
      </CardContent>
    </Card>
  );
}
