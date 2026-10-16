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

/**
 * One settings screen with sections, not three top-level areas.
 *
 * "Profile", "Settings" and "Account" as separate destinations only make a person guess which of
 * the three holds the thing they came for. The sections below are split by who owns the data:
 * Users owns the profile, Auth owns the account, its security and its sessions.
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
  const state = useAsync(() => users.getOwnProfile.query({}), []);
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
      await users.updateOwnProfile.mutate({
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
  const { identity } = useSession();
  // The form to change the address stays folded: an address changes once in years, and two open
  // fields under it made the card read as a form to fill in.
  const [changing, setChanging] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const verified = identity?.emailVerifiedAt !== null;

  const close = () => {
    setChanging(false);
    setEmail('');
    setPassword('');
  };

  const requestChange = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.requestEmailChange.mutate({ currentPassword: password, email });
      // The address only changes once the link in the new mailbox is opened; saying so avoids the
      // impression that it already did.
      toast.success('Подтвердите изменение по ссылке, отправленной на новый адрес');
      close();
    } catch (error) {
      toast.error(messageOf(error));
      // The password never stays in the form; the new address does, so a mistyped password costs one field.
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      await auth.resendOwnVerification.mutate({});
      toast.success('Новая ссылка подтверждения отправлена');
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Аккаунт</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="text-muted-foreground">Адрес, с которым вы входите.</p>
          {/* Held at the button's height, so the line does not jump when the button gives way to the form. */}
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-medium">{identity?.email}</span>
            <span
              className={
                verified
                  ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              }
            >
              {verified ? 'Подтверждён' : 'Не подтверждён'}
            </span>
            {changing ? null : (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setChanging(true)}>
                Сменить адрес
              </Button>
            )}
          </div>
          {/* The status follows on its own when the person comes back from the letter: SessionProvider re-reads it. */}
          {verified ? null : (
            <p className="text-muted-foreground pt-2">
              Ссылка для подтверждения — в письме. Не пришло?{' '}
              <button
                type="button"
                className="text-foreground underline decoration-muted-foreground/50 underline-offset-4 transition-colors hover:decoration-foreground"
                onClick={() => void resend()}
              >
                Отправить ещё раз
              </button>
            </p>
          )}
        </div>

        {changing ? (
          <form onSubmit={requestChange} className="space-y-3 border-t pt-4">
            {/*
              An address and a password read as a sign-in form to a password manager, which would then
              offer to save this password under the new, unconfirmed address. The current address,
              marked as the username, tells it which account the password belongs to.
            */}
            <input type="text" name="username" autoComplete="username" value={identity?.email ?? ''} readOnly hidden />
            <div className="space-y-2">
              <Label htmlFor="newEmail">Новый адрес</Label>
              <Input
                id="newEmail"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                placeholder="new@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emailChangePassword">Подтвердите пароль</Label>
              <Input
                id="emailChangePassword"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Новый адрес нужно подтвердить, а старому мы сообщим об изменении.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
                Отправить
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                Отмена
              </Button>
            </div>
          </form>
        ) : null}
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
      await auth.changePassword.mutate({ currentPassword, password: newPassword });
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
  const state = useAsync(() => auth.listOwnSessions.query({}), []);
  const [busy, setBusy] = React.useState(false);
  const others = (state.data?.sessions ?? []).filter((session) => !session.current).length;

  // One sign-in ended from its row: an unfamiliar device goes, every other stays.
  const revokeOne = async (id: string) => {
    setBusy(true);
    try {
      await auth.revokeOwnSession.mutate({ id });
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  // Every sign-in but this browser's — someone else's session ends, the person asking stays in.
  // This browser itself is ended by "Выйти".
  const revokeOthers = async () => {
    setBusy(true);
    try {
      await auth.revokeOtherSessions.mutate({});
      toast.success('Остальные сессии завершены');
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
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
                data-testid="own-session"
                data-session-id={session.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
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
                {session.current ? null : (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void revokeOne(session.id)}>
                    Завершить
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button variant="outline" onClick={() => void revokeOthers()} disabled={busy || others === 0}>
          Завершить все остальные
        </Button>
        <p className="text-muted-foreground text-xs">
          Этот браузер останется в системе. Чтобы выйти и из него — «Выйти» вверху.
        </p>
      </CardContent>
    </Card>
  );
}
