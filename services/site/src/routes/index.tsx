import { Link, createFileRoute } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Template' },
      { name: 'description', content: 'Site, application and admin, working together from day one.' },
    ],
  }),
  component: Home,
});

const PARTS = [
  {
    title: 'Site',
    body: 'These public pages, rendered on the server so they can be read and indexed without JavaScript.',
  },
  {
    title: 'Application',
    body: 'Everything behind sign-in: onboarding, one settings screen, and the account itself.',
  },
  {
    title: 'Admin',
    body: 'Roles, grants and each service’s own admin, composed into one panel.',
  },
];

function Home() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6">
      <section className="py-20">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          A product that already has its boring parts
        </h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg">
          Accounts, email, permissions and an admin panel are the work every product repeats. Here
          they are done, so the first day can go to the part that is actually yours.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <a href="/app/register">Create an account</a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/about">What is inside</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 pb-20 sm:grid-cols-3">
        {PARTS.map((part) => (
          <Card key={part.title}>
            <CardHeader>
              <CardTitle>{part.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">{part.body}</CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
