import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { Column } from './model';

/**
 * The visibility panel: every column of the table with a box, ticked when it is shown.
 *
 * `shown` is the view's list of visible columns, empty meaning all of them — the shape the page URL
 * has always carried. The last visible column cannot be hidden: a table with no columns says
 * nothing. The column header's "Скрыть колонку" writes the same list and opens this panel, so the
 * person sees what they just did (the owner, 9 October 2026).
 */
export function Visibility({ columns, shown, onChange }: {
  columns: Column[];
  shown: string[];
  onChange: (shown: string[]) => void;
}) {
  const visible = (name: string) => shown.length === 0 || shown.includes(name);
  const visibleCount = columns.filter((column) => visible(column.name)).length;
  const toggle = (name: string, on: boolean) => {
    const next = columns.filter((column) => (column.name === name ? on : visible(column.name))).map((column) => column.name);
    onChange(next.length === columns.length ? [] : next);
  };

  return (
    <section aria-label="Видимость колонок" className="space-y-3 p-4">
      {/* A wide table has dozens of columns: the list scrolls inside the panel instead of running off the screen. */}
      <ul className="grid max-h-[60vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        {columns.map((column) => {
          const on = visible(column.name);
          const last = on && visibleCount === 1;
          return <li key={column.name}>
            <label className={`flex items-center gap-2 text-sm ${last ? 'text-muted-foreground' : ''}`} title={last ? 'Последняя видимая колонка остаётся' : undefined}>
              <Checkbox checked={on} disabled={last} aria-label={`Показывать ${column.name}`} onCheckedChange={(checked) => toggle(column.name, checked === true)} />
              <span className="font-mono">{column.name}</span>
            </label>
          </li>;
        })}
      </ul>
      {shown.length > 0 && <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => onChange([])}>Показать все</Button>
      </div>}
    </section>
  );
}
