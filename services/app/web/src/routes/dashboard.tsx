import { Link } from '@tanstack/react-router';
import type { UserProfile } from '@template/contracts';
import * as React from 'react';

import { messageOf, users } from '@/api';
import { Page } from '@/components/layout/page';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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


  return (
    <Page title={`Здравствуйте, ${profile.data?.profile.displayName ?? identity?.email ?? ''}`}>
      {identity && identity.emailVerifiedAt === null ? (
        <Alert>
          <AlertTitle>Почта ещё не подтверждена</AlertTitle>
          <AlertDescription>
            {/*
              One paragraph, not three loose children: the description is a grid, so a bare text
              node, a link and a full stop would each become a row of their own.
            */}
            <p>
              Откройте ссылку из письма или запросите новую в{' '}
              <Link to="/settings" className="underline underline-offset-4">
                настройках
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      ) : null}


      <Card>
        <CardHeader>
          <CardTitle>Ваш аккаунт</CardTitle>
          <CardDescription>
            Учётной записью владеет Auth, профилем ниже — Users. Они разделены намеренно.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {profile.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : profile.error ? (
            <p className="text-muted-foreground">{messageOf(profile.error)}</p>
          ) : (
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
              <dt className="text-muted-foreground">Почта</dt>
              <dd>{identity?.email}</dd>
              <dt className="text-muted-foreground">Отображаемое имя</dt>
              <dd>{profile.data?.profile.displayName ?? '—'}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
