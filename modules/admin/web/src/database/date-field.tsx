import * as React from 'react';
import { CalendarIcon } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** What a column of dates takes: a day, or a day and a time of day. */
export type DateKind = 'date' | 'datetime';

/** The kind of date field a column gets, or null for a column that is not a date at all. */
export function dateKindOf(type: string): DateKind | null {
  if (type === 'date') return 'date';
  if (type.startsWith('timestamp')) return 'datetime';
  return null;
}

/** `YYYY-MM-DD` of a day in the person's own calendar — not `toISOString`, which would shift it by the zone. */
const dayText = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

/** The day a typed value starts with, when it starts with one; what the calendar opens on. */
function dayOf(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? undefined : day;
}

/** The time of day a typed value carries, or midnight: what the time box shows and what a picked day gets. */
const timeOf = (value: string) => /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(value)?.[1] ?? '00:00';

/**
 * A text field for a date with a calendar beside it.
 *
 * The text stays the source of truth and can be typed freely — seconds, a zone, anything PostgreSQL
 * reads. The calendar only writes into it: a day as `YYYY-MM-DD`, and for a column with a time of day
 * `YYYY-MM-DD HH:MM`, the time from the box under the month (midnight until changed). The owner chose
 * this over a date-only input, which could not have held a time (8 October 2026).
 */
export function DateField({ value, onChange, kind, label, placeholder, invalid, className, onKeyDown, open: openProp, onOpenChange, onPick }: {
  value: string;
  onChange: (value: string) => void;
  kind: DateKind;
  label: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /** The calendar's open state, when a parent drives it — a range opens the second calendar as the first closes. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called after a day was picked, once the value is written. */
  onPick?: () => void;
}) {
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const day = dayOf(value);
  const time = timeOf(value);
  const write = (picked: Date, at: string) => onChange(kind === 'datetime' ? `${dayText(picked)} ${at}` : dayText(picked));

  return <div className={cn('relative', className)}>
    <Input aria-label={label} placeholder={placeholder} value={value} aria-invalid={invalid} className="pr-9" onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Календарь: ${label}`} className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground">
          <CalendarIcon className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar mode="single" selected={day} defaultMonth={day} onSelect={(picked) => {
          if (!picked) return;
          write(picked, time);
          if (kind === 'date' || onPick) setOpen(false);
          onPick?.();
        }} />
        {kind === 'datetime' && <label className="flex items-center gap-2 border-t p-3 text-sm">
          Время
          <Input type="time" aria-label={`Время: ${label}`} className="w-32" value={time} onChange={(event) => {
            if (day) write(day, event.target.value || '00:00');
          }} />
        </label>}
      </PopoverContent>
    </Popover>
  </div>;
}

/**
 * The two ends of a date range as one gesture: picking the start closes its calendar and opens the
 * end's, so a range is two clicks, not four. For a column with a time of day the time stays
 * midnight; it is changed by reopening the calendar or typing (the owner's request, 9 October 2026).
 */
export function DateRangeFields({ kind, values, labels, invalid, onChange }: {
  kind: DateKind;
  values: [string, string];
  labels: [string, string];
  invalid: boolean;
  onChange: (half: 0 | 1, value: string) => void;
}) {
  const [opened, setOpened] = React.useState<0 | 1 | null>(null);
  return <>
    {([0, 1] as const).map((half) => <DateField key={half} kind={kind} label={labels[half]} placeholder={labels[half].toLowerCase()}
      value={values[half]} invalid={invalid && values[half] === ''} onChange={(value) => onChange(half, value)}
      open={opened === half} onOpenChange={(open) => setOpened(open ? half : null)}
      onPick={() => setOpened(half === 0 && values[1] === '' ? 1 : null)} />)}
  </>;
}
