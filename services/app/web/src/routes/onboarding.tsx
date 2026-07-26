import { useNavigate } from '@tanstack/react-router';
import type { UserProfile } from '@template/contracts';
import * as React from 'react';
import { toast } from 'sonner';

import { messageOf, users } from '@/api';
import { Page } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/hooks/use-async';

const LOCALES = ['en', 'ru'];

/**
 * Onboarding.
 *
 * It stays a separate flow rather than another settings tab because it has its own completion
 * state: Users records when it was finished, and that fact is what the rest of the product reads.
 */
export function OnboardingScreen() {
  const navigate = useNavigate();
  const current = useAsync<{ profile: UserProfile }>(() => users.getOwnProfile({}), []);

  const [displayName, setDisplayName] = React.useState('');
  const [locale, setLocale] = React.useState('en');
  const [busy, setBusy] = React.useState(false);
  const [prefilled, setPrefilled] = React.useState(false);

  // Filled once from the server's answer, so typing is never overwritten by a later reload.
  React.useEffect(() => {
    if (prefilled || !current.data) return;
    setDisplayName(current.data.profile.displayName ?? '');
    setLocale(current.data.profile.preferences.locale);
    setPrefilled(true);
  }, [current.data, prefilled]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await users.updateOwnPreferences({ locale });
      // Completion carries the two values it needs, so a half-filled profile cannot be marked done.
      await users.completeOnboarding({
        displayName: displayName.trim(),
        // The browser knows this better than a dropdown would.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      toast.success('All set');
      void navigate({ to: '/' });
    } catch (error) {
      toast.error(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Page title="Welcome" description="Two details, then you are in.">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>About you</CardTitle>
          <CardDescription>You can change any of this later in settings.</CardDescription>
        </CardHeader>
        <CardContent>
          {current.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">What should we call you?</Label>
                <Input
                  id="displayName"
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Your name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="locale">Language</Label>
                <Select value={locale} onValueChange={setLocale}>
                  <SelectTrigger id="locale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button type="submit" disabled={busy || displayName.trim() === ''}>
                Finish
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
