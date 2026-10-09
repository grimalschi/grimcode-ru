import {
  ArrowDown10Icon, ArrowDownWideNarrowIcon, ArrowDownZAIcon, ArrowUp01Icon, ArrowUpAZIcon, ArrowUpNarrowWideIcon,
  GripVerticalIcon, InfoIcon, XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The direction button's icon says how the column compares: letters for text, digits for numbers
 * and dates, bars for everything else — so the arrow also tells what "ascending" means here.
 */
function directionIcon(type: string, desc: boolean) {
  const className = 'size-4';
  if (/char|text|name|uuid/i.test(type)) return desc ? <ArrowDownZAIcon className={className} /> : <ArrowUpAZIcon className={className} />;
  if (/int|numeric|decimal|real|double|money|date|time/i.test(type)) return desc ? <ArrowDown10Icon className={className} /> : <ArrowUp01Icon className={className} />;
  return desc ? <ArrowDownWideNarrowIcon className={className} /> : <ArrowUpNarrowWideIcon className={className} />;
}

const LEVELS_HINT ='Первое условие главное; следующие применяются там, где у предыдущих значения равны. Порядок условий меняется перетаскиванием.';
import { useDragOrder } from './drag-order';
import type { Column, Order } from './model';

/**
 * The sorting panel: levels, one per row, in the order they apply.
 *
 * The first level decides; each next one breaks ties left by the one before. The server takes the
 * list as it is and appends the key as the last level itself, so equal rows never swap between
 * pages. A column already used by one level is not offered to another. This is the only place
 * sorting is set — the column header shows the arrow and the level number but has no sort menu
 * (the owner, 9 October 2026).
 */
export function Sorting({ columns, order, onChange }: {
  columns: Column[];
  order: Order[];
  onChange: (order: Order[]) => void;
}) {
  const drag = useDragOrder(order.length, (from, to) => {
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  }, 'database-sort');
  const used = new Set(order.map((level) => level.column));
  const free = columns.filter((column) => !used.has(column.name));
  const set = (index: number, patch: Partial<Order>) => onChange(order.map((level, at) => (at === index ? { ...level, ...patch } : level)));

  return (
    <TooltipProvider delayDuration={250}>
    <section aria-label="Сортировка таблицы" className="space-y-2 p-4">
      {order.length === 0 && <p className="text-sm text-muted-foreground">Строки идут в порядке появления. Добавьте условие, чтобы отсортировать.</p>}
      {/* Five conditions in view; the rest scroll inside the panel, the buttons below stay put. */}
      {order.length > 0 && <div className="max-h-56 space-y-2 overflow-y-auto py-1.5 pr-1">
      {order.map((level, index) => {
        const row = drag.row(index);
        const desc = level.direction === 'desc';
        return <div key={index} data-testid="database-sort-level" className={`relative flex flex-wrap items-center gap-2 ${row.dimmed ? 'opacity-40' : ''}`} onDragOver={row.onDragOver} onDrop={row.onDrop}>
          <button {...drag.handle(index, `Переместить условие ${index + 1}`)}><GripVerticalIcon className="size-4" /></button>
          <Select value={level.column} onValueChange={(column) => set(index, { column })}>
            <SelectTrigger aria-label={`Колонка условия ${index + 1}`} className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{columns.filter((column) => column.name === level.column || !used.has(column.name))
              .map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent>
          </Select>
          {/* One arrow, as in the table header: a click turns it; the owner found a labelled switch too bulky. */}
          <Button size="icon" variant="ghost" className="size-7" role="switch" aria-checked={desc}
            aria-label={`Направление условия ${index + 1}: ${desc ? 'по убыванию' : 'по возрастанию'}`}
            title={desc ? 'По убыванию — нажмите, чтобы по возрастанию' : 'По возрастанию — нажмите, чтобы по убыванию'}
            onClick={() => set(index, { direction: desc ? 'asc' : 'desc' })}>
            {directionIcon(columns.find((column) => column.name === level.column)?.type ?? '', desc)}
          </Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={`Убрать условие ${index + 1}`} onClick={() => onChange(order.filter((_, at) => at !== index))}><XIcon className="size-4" /></Button>
          {drag.line(index)}
        </div>;
      })}
      </div>}
      <div className={`flex flex-wrap items-center justify-between gap-3 ${order.length ? 'pt-4' : ''}`}>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!free.length} onClick={() => onChange([...order, { column: free[0]!.name, direction: 'asc' }])}>Добавить условие</Button>
          {order.length > 0 && <Tooltip>
            <TooltipTrigger asChild><button type="button" aria-label="Подсказка" className="text-muted-foreground hover:text-foreground"><InfoIcon className="size-4" /></button></TooltipTrigger>
            <TooltipContent className="max-w-72">{LEVELS_HINT}</TooltipContent>
          </Tooltip>}
        </div>
        {order.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange([])}>Очистить</Button>}
      </div>
    </section>
    </TooltipProvider>
  );
}
