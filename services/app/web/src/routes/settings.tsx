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
    <Page title="Settings">
      <Tabs defaultValue="profile" className="max-w-2xl">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
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
      toast.success('Saved');
      state.reload();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>How you appear inside the product.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Save
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
      toast.success('Confirm the change from the link sent to the new address');
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
      toast.success('A new confirmation link is on its way');
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Your sign-in address.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2 text-sm">
          <p className="font-medium">{identity?.email}</p>
          {identity?.emailVerifiedAt === null ? (
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">Not confirmed yet.</span>
              <Button variant="outline" size="sm" onClick={() => void resend()}>
                Send a new link
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">Confirmed.</p>
          )}
        </div>

        <form onSubmit={requestChange} className="space-y-2">
          <Label htmlFor="newEmail">Change address</Label>
          <div className="flex gap-2">
            <Input
              id="newEmail"
              type="email"
              value={email}
              placeholder="new@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" disabled={busy || email.trim() === ''}>
              Send
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The new address has to be confirmed, and the old one is told about the change.
          </p>
        </form>

        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          Refresh
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
      toast.success('Password changed. Every other session was signed out.');
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
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out every other session.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current password</Label>
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
            <Label htmlFor="newPassword">New password</Label>
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
            Change password
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
        <CardTitle>Where you are signed in</CardTitle>
        <CardDescription>Each browser that currently holds a valid session.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="space-y-2 text-sm">
            {(state.data?.sessions ?? []).map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block">
                    Started {new Date(session.createdAt).toLocaleString()}
                    {session.current ? ' — this browser' : ''}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {session.userAgent ?? 'Unknown browser'}
                  </span>
                </span>
                <span className="text-muted-foreground whitespace-nowrap">
                  Seen {new Date(session.lastSeenAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button variant="outline" onClick={() => void revokeAll()} disabled={busy}>
          Sign out everywhere
        </Button>
        <p className="text-muted-foreground text-xs">
          This signs out every browser, including this one.
        </p>
      </CardContent>
    </Card>
  );
}
