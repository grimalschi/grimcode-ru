import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: 'About — Template' },
      { name: 'description', content: 'What this template contains and why.' },
    ],
  }),
  component: About,
});

function About() {
  return (
    <article className="prose-page mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">About</h1>
      <p className="text-muted-foreground mt-4">
        This page is a placeholder with a real structure: a product replaces the words and keeps the
        shape.
      </p>

      <h2 className="mt-10 text-xl font-medium">What this is</h2>
      <p className="text-muted-foreground mt-2">
        A set of small services that already work together — a public site, an application behind
        sign-in, and an admin panel with roles and grants.
      </p>

      <h2 className="mt-8 text-xl font-medium">How it is built</h2>
      <p className="text-muted-foreground mt-2">
        Each service owns its data and its interface. They talk over typed contracts and never
        import each other, so one can be replaced without touching the rest.
      </p>
    </article>
  );
}
