import { Loader2Icon } from 'lucide-react';

/** Shown in place of a page only once its first answer is late; until then the page is simply not there yet. */
export function PageLoader({ late }: { late: boolean }) {
  if (!late) return null;
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      Загружаем…
    </div>
  );
}
