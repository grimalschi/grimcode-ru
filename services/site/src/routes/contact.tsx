import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/contact')({
  head: () => ({
    meta: [
      { title: 'Contact — Template' },
      { name: 'description', content: 'How to reach the people behind this product.' },
    ],
  }),
  component: Contact,
});

function Contact() {
  return (
    <article className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Contact</h1>
      <p className="text-muted-foreground mt-4">
        Replace the details below with the real ones before launch.
      </p>

      <dl className="mt-8 grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
        <dt className="text-muted-foreground">Email</dt>
        <dd>hello@example.com</dd>
        <dt className="text-muted-foreground">Company</dt>
        <dd>Company name, registration number</dd>
        <dt className="text-muted-foreground">Address</dt>
        <dd>Street, city, country</dd>
      </dl>
    </article>
  );
}
