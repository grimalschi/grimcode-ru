import { Link } from '@tanstack/react-router';

export function NotFound() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-24">
      <h1 className="text-3xl font-semibold">Такой страницы нет</h1>
      <p className="text-muted-foreground mt-2">
        Возможно, в адресе опечатка или страницу удалили.
      </p>
      <Link to="/" className="mt-6 inline-block underline underline-offset-4">
        На главную
      </Link>
    </div>
  );
}
