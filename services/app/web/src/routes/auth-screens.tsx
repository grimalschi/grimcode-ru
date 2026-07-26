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
      title="Sign in"
      footer={
        <>
          <Link to="/register" className="text-sm underline underline-offset-4">
            Create an account
          </Link>
          <Link to="/reset-password" className="text-sm underline underline-offset-4">
            Forgot your password?
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
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
          <Label htmlFor="password">Password</Label>
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
          Sign in
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
      window.location.assign('/app/onboarding');
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Create an account"
      description="A confirmation link is sent to this address."
      footer={
        <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
          I already have an account
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
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
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">At least 12 characters.</p>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Create account
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
        title="Check your email"
        description="If that address has an account, a recovery link is on its way. The link works once and expires."
        footer={
          <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">You can close this page.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We will send a one-time link."
      footer={
        <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
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
          Send the link
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
      toast.success('Your password has been changed. All other sessions were signed out.');
      void navigate({ to: '/login', search: { next: undefined } });
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  if (token === '') {
    return (
      <AuthCard
        title="This link is incomplete"
        description="Open the link from the email exactly as it was sent, or request a new one."
        footer={
          <Link to="/reset-password" className="text-sm underline underline-offset-4">
            Request a new link
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">Nothing has been changed.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
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
            At least 12 characters. Every other session will be signed out.
          </p>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          Change password
        </Button>
      </form>
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
    return <AuthCard title="Confirming your email">
      <p className="text-muted-foreground text-sm">One moment.</p>
    </AuthCard>;
  }

  if (state === 'failed') {
    return (
      <AuthCard
        title="This link did not work"
        description={message}
        footer={
          <Link to="/login" search={{ next: undefined }} className="text-sm underline underline-offset-4">
            Go to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          A confirmation link works once and expires. You can ask for a new one from your settings.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Email confirmed"
      footer={
        <Link to="/" className="text-sm underline underline-offset-4">
          Continue
        </Link>
      }
    >
      <p className="text-muted-foreground text-sm">Thank you — your address is confirmed.</p>
    </AuthCard>
  );
}
