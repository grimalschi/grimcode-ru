import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { auth, messageOf } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { returnPathOrHome } from '@/return-path';
import { useSession } from '@/session';

/**
 * The public entrance.
 *
 * Registration, sign-in, recovery, password reset and email confirmation are the only screens
 * reachable without a session. Everything else is behind the guard.
 */

function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer ? <CardFooter className="flex-col items-start gap-2">{footer}</CardFooter> : null}
      </Card>
    </div>
  );
}

export function LoginScreen() {
  const search = useSearch({ strict: false }) as { next?: string };
  const { refresh } = useSession();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.login({ email, password });
      await refresh();
      // A full navigation, so the protected part starts from a clean state with the new cookie.
      window.location.assign(returnPathOrHome(search.next));
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Вход"
      footer={
        <>
          <Link to="/register" className="text-sm underline underline-offset-4">
            Создать аккаунт
          </Link>
          <Link to="/reset-password" className="text-sm underline underline-offset-4">
            Забыли пароль?
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Почта</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Войти
        </Button>
      </form>
    </AuthCard>
  );
}

export function RegisterScreen() {
  const { refresh } = useSession();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.register({ email, password });
      await refresh();
      window.location.assign('/app/');
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Создание аккаунта"
      description="На этот адрес придёт ссылка для подтверждения."
      footer={
        <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
          У меня уже есть аккаунт
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Почта</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">Не короче 12 символов.</p>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Создать аккаунт
        </Button>
      </form>
    </AuthCard>
  );
}

export function RequestResetScreen() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.requestPasswordReset({ email });
    } finally {
      // The same answer either way: whether an address is registered is not something this screen
      // is willing to reveal.
      setSent(true);
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthCard
        title="Проверьте почту"
        description="Если у этого адреса есть аккаунт, ссылка для восстановления уже в пути. Она работает один раз и истекает."
        footer={
          <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
            К входу
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">Эту страницу можно закрыть.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Восстановление пароля"
      description="Пришлём одноразовую ссылку."
      footer={
        <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Почта</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Отправить ссылку
        </Button>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordScreen() {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const token = search.token ?? '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.resetPassword({ token, password });
      toast.success('Пароль изменён. Все остальные сессии завершены.');
      void navigate({ to: '/login', search: { next: undefined } });
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  if (token === '') {
    return (
      <AuthCard
        title="Ссылка неполная"
        description="Откройте ссылку из письма ровно так, как её прислали, или запросите новую."
        footer={
          <Link to="/reset-password" className="text-sm underline underline-offset-4">
            Запросить новую ссылку
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">Ничего не изменилось.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Новый пароль">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">Новый пароль</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Не короче 12 символов. Все остальные сессии будут завершены.
          </p>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Изменить пароль
        </Button>
      </form>
    </AuthCard>
  );
}

/**
 * The link sent to a new address when someone changes their email.
 *
 * Separate from confirming a first address: this one moves the account to a different address, and
 * the old one is told about it afterwards.
 */
export function ConfirmEmailChangeScreen() {
  const search = useSearch({ strict: false }) as { token?: string };
  const { refresh } = useSession();
  const [state, setState] = React.useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = React.useState('');

  const token = search.token ?? '';

  React.useEffect(() => {
    if (token === '') {
      setState('failed');
      setMessage('This link is incomplete. Open it from the email exactly as it was sent.');
      return;
    }

    auth
      .confirmEmailChange({ token })
      .then(() => refresh())
      .then(() => setState('done'))
      .catch((error: unknown) => {
        setState('failed');
        setMessage(messageOf(error));
      });
  }, [refresh, token]);

  if (state === 'working') {
    return (
      <AuthCard title="Подтверждаем изменение">
        <p className="text-muted-foreground text-sm">Секунду.</p>
      </AuthCard>
    );
  }

  if (state === 'failed') {
    return (
      <AuthCard
        title="Ссылка не сработала"
        description={message}
        footer={
          <Link to="/settings" className="text-sm underline underline-offset-4">
            Попробовать снова из настроек
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          Ссылка работает один раз и истекает. Адрес не изменился.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Адрес изменён"
      footer={
        <Link to="/" className="text-sm underline underline-offset-4">
          Продолжить
        </Link>
      }
    >
      <p className="text-muted-foreground text-sm">
        Дальше входите с новым адресом. Старому мы сообщили об изменении.
      </p>
    </AuthCard>
  );
}

export function VerifyEmailScreen() {
  const search = useSearch({ strict: false }) as { token?: string };
  const { refresh } = useSession();
  const [state, setState] = React.useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = React.useState('');

  const token = search.token ?? '';

  React.useEffect(() => {
    if (token === '') {
      setState('failed');
      setMessage('This link is incomplete. Open it from the email exactly as it was sent.');
      return;
    }

    auth
      .verifyEmail({ token })
      .then(() => refresh())
      .then(() => setState('done'))
      .catch((error: unknown) => {
        setState('failed');
        setMessage(messageOf(error));
      });
  }, [refresh, token]);

  if (state === 'working') {
    return <AuthCard title="Подтверждаем почту">
      <p className="text-muted-foreground text-sm">Секунду.</p>
    </AuthCard>;
  }

  if (state === 'failed') {
    return (
      <AuthCard
        title="Ссылка не сработала"
        description={message}
        footer={
          <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
            Перейти ко входу
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          Ссылка подтверждения работает один раз и истекает. Новую можно запросить в настройках.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Почта подтверждена"
      footer={
        <Link to="/" className="text-sm underline underline-offset-4">
          Продолжить
        </Link>
      }
    >
      <p className="text-muted-foreground text-sm">Спасибо — адрес подтверждён.</p>
    </AuthCard>
  );
}
