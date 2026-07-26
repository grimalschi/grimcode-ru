import { Link } from '@tanstack/react-router';
import type { UserProfile } from '@template/contracts';
import * as React from 'react';

import { messageOf, users } from '@/api';
import { Page } from '@/components/layout/page';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/hooks/use-async';
import { useSession } from '@/session';



/**
 * What a signed-in user lands on.
 *
 * It shows the two things the template actually knows about a person — their identity from Auth and
 * their product profile from Users — and points at whatever is still unfinished.
 */
export function DashboardScreen() {
  const { identity } = useSession();
  const profile = useAsync<{ profile: UserProfile }>(() => users.getOwnProfile({}), []);

  const needsOnboarding =
    profile.data !== null && profile.data.profile.onboardingCompletedAt === null;

  return (
    <Page title={`Hello, ${profile.data?.profile.displayName ?? identity?.email ?? ''}`}>
      {identity && identity.emailVerifiedAt === null ? (
        <Alert>
          <AlertTitle>Your email is not confirmed yet</AlertTitle>
          <AlertDescription>
            Open the link we sent you, or ask for a new one from{' '}
            <Link to="/settings" className="underline underline-offset-4">
              settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      {needsOnboarding ? (
        <Card>
          <CardHeader>
            <CardTitle>Finish setting up</CardTitle>
            <CardDescription>A few details and you are done.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/onboarding">Continue</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>
            Identity is owned by Auth, the profile below by Users. They are separate on purpose.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {profile.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : profile.error ? (
            <p className="text-muted-foreground">{messageOf(profile.error)}</p>
          ) : (
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{identity?.email}</dd>
              <dt className="text-muted-foreground">Display name</dt>
              <dd>{profile.data?.profile.displayName ?? '—'}</dd>
              <dt className="text-muted-foreground">Language</dt>
              <dd>{profile.data?.profile.preferences.locale}</dd>
              <dt className="text-muted-foreground">Time zone</dt>
              <dd>{profile.data?.profile.timeZone ?? '—'}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
