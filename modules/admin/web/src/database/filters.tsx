import * as React from 'react';
import { GripVerticalIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DateField, DateRangeFields, dateKindOf, type DateKind } from './date-field';
import { useDragOrder } from './drag-order';
import { CONDITION_LABELS, chained, filterShape, groupConditions, isFilterReady, isTextColumn, type Column, type Filter } from './model';

const JOIN_HINT = 'Условия через И выполняются вместе; ИЛИ разделяет такие группы.';
/** The spelling the table uses for control characters is read back here; shown on text columns only. */
const SPELLING_HINT = 'Спецсимволы пишутся как в таблице: \\r — возврат каретки, \\n — перевод строки, \\t — табуляция. Обратная косая черта сама по себе — \\\\.';
const CASE_HINT = 'Действует на «содержит», «начинается с», «заканчивается на». «Равно» всегда различает большие и маленькие буквы.';
/** How long a condition may stay unfilled before the panel points at it. */
const IDLE_MS = 5000;

/**
 * The filter panel: a chain of conditions, each joined to the next with И or ИЛИ.
 *
 * The chain reads the way SQL does — И binds tighter — and the panel draws it that way: conditions
 * joined with И form one block in the markup and nothing else: a tinted background came and went as
 * the joins changed and read as flicker, a rule down the left read as debris, a wider gap made the
 * panel jump — and the switch between the rows already says where a group ends. The join sits at
 * the end of a row, between the two conditions it connects. Order matters, so every condition has a handle: drag it,
 * or focus it and press the arrow keys. An unfilled condition is pointed at only once the person has
 * moved on — added another condition after it, or stopped typing for a while — not the moment it
 * appears (the owner's rule, 8 October 2026).
 */
export function Filters({ columns, filters, caseSensitive, onChange }: {
  columns: Column[];
  filters: Filter[];
  caseSensitive: boolean;
  onChange: (filters: Filter[], caseSensitive: boolean) => void;
}) {
  const drag = useDragOrder(filters.length, (from, to) => {
    const next = [...filters];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    update(next);
  }, 'database-filter');
  const [idle, setIdle] = React.useState(false);
  const columnOf = (name: string) => columns.find((column) => column.name === name);
  const conditions = (name: string) => columnOf(name)?.conditions ?? [];
  const update = (next: Filter[]) => onChange(chained(next), caseSensitive);

  // Any change to the filters restarts the clock; after IDLE_MS of silence the unfilled ones light up.
  const edition = JSON.stringify(filters);
  React.useEffect(() => {
    setIdle(false);
    const timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [edition]);

  function change(index: number, patch: Partial<Filter>) {
    update(filters.map((filter, at) => {
      if (at !== index) return filter;
      const next = { ...filter, ...patch };
      if (patch.column) {
        if (!conditions(patch.column).includes(next.condition)) next.condition = conditions(patch.column)[0] ?? 'is';
        // A value typed for one kind of column rarely fits another: text on an array column travels as an array literal and is refused.
        if (columnOf(patch.column)?.type !== columnOf(filter.column)?.type) next.value = undefined;
      }
      if (filterShape(next.condition) !== filterShape(filter.condition)) next.value = undefined;
      return next;
    }));
  }
  // Blocks: a condition joined with ИЛИ starts a new one; everything joined with И stays in the current.
  const blocks: number[][] = [];
  filters.forEach((filter, index) => {
    if (index === 0 || filter.join === 'or') blocks.push([index]);
    else blocks[blocks.length - 1]!.push(index);
  });
  const pointedAt = (index: number) => !isFilterReady(filters[index]!) && (index < filters.length - 1 || idle);

  // The join between condition `index` and the next one: it belongs to the next, the row shows it after this.
  const joinToNext = (index: number) => {
    const or = (filters[index + 1]!.join ?? 'and') === 'or';
    const side = (active: boolean) => `text-sm ${active ? 'text-foreground' : 'text-muted-foreground'}`;
    return <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex items-center gap-2 px-1">
          <span className={side(!or)}>и</span>
          <Switch checked={or} onCheckedChange={(checked) => change(index + 1, { join: checked ? 'or' : 'and' })}
            aria-label={`Связка между условиями ${index + 1} и ${index + 2}: ${or ? 'или' : 'и'}`} />
          <span className={side(or)}>или</span>
        </label>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{JOIN_HINT}</TooltipContent>
    </Tooltip>;
  };

  return (
    <TooltipProvider delayDuration={250}>
      <section aria-label="Фильтры таблицы" className="space-y-2 p-4">
        {filters.length > 0 && <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
              <Checkbox checked={caseSensitive} onCheckedChange={(checked) => onChange(filters, checked === true)} aria-label="Учитывать регистр" />
              Учитывать регистр
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{CASE_HINT}</TooltipContent>
        </Tooltip>}
        {/* Five conditions in view; the rest scroll inside the panel, the buttons below stay put. */}
        {filters.length > 0 && <div className="max-h-56 space-y-2 overflow-y-auto py-1.5 pr-1">
        {blocks.map((block) => <div key={block[0]} data-testid="database-filter-block" className="space-y-2">
          {block.map((index) => {
            const filter = filters[index]!;
            const shape = filterShape(filter.condition);
            const invalid = pointedAt(index);
            // A date column gets a calendar beside each text box; the box itself stays free text.
            const dates = dateKindOf(columnOf(filter.column)?.type ?? '');
            const spelled = isTextColumn(columnOf(filter.column));
            const row = drag.row(index);
            return <div key={index} data-testid="database-filter" className={`relative flex flex-wrap items-center gap-2 ${row.dimmed ? 'opacity-40' : ''}`} aria-invalid={invalid}
                onDragOver={row.onDragOver} onDrop={row.onDrop}>
              <button {...drag.handle(index, `Переместить условие ${index + 1}`)}><GripVerticalIcon className="size-4" /></button>
              <Select value={filter.column} onValueChange={(column) => change(index, { column })}>
                <SelectTrigger aria-label={`Колонка условия ${index + 1}`} className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={filter.condition} onValueChange={(value) => {
                const condition = conditions(filter.column).find((entry) => entry === value);
                if (condition) change(index, { condition });
              }}>
                <SelectTrigger aria-label={`Условие ${index + 1}`} className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{(() => {
                  const groups = groupConditions(conditions(filter.column));
                  // Headings only where there is more than one group: a heading over the whole list says nothing.
                  return groups.map((group) => <SelectGroup key={group.label}>
                    {groups.length > 1 && group.label && <SelectLabel>{group.label}</SelectLabel>}
                    {group.conditions.map((condition) => <SelectItem key={condition} value={condition}>{CONDITION_LABELS[condition] ?? condition}</SelectItem>)}
                  </SelectGroup>);
                })()}</SelectContent>
              </Select>
              {shape === 'none' ? <span className="w-80" aria-hidden="true" /> : shape === 'range' || shape === 'pair' ? <div className="flex w-80 items-center gap-2">
                {(() => {
                  const pair = Array.isArray(filter.value) ? filter.value : ['', ''];
                  const text = (half: 0 | 1) => String(pair[half] ?? '');
                  const write = (half: 0 | 1, next: string) => {
                    const values = [text(0), text(1)];
                    values[half] = next;
                    change(index, { value: values });
                  };
                  if (shape === 'range' && dates) {
                    return <DateRangeFields kind={dates} labels={['От', 'До']} values={[text(0), text(1)]} invalid={invalid} onChange={write} />;
                  }
                  return ([0, 1] as const).map((half) => {
                    const label = shape === 'range' ? (half === 0 ? 'От' : 'До') : (half === 0 ? 'Ключ' : 'Значение');
                    return <Input key={half} aria-label={label} placeholder={label.toLowerCase()} value={text(half)} aria-invalid={invalid && text(half) === ''} onChange={(event) => write(half, event.target.value)} />;
                  });
                })()}
              </div> : shape === 'list' ? <ValueList values={Array.isArray(filter.value) ? filter.value.map(String) : []} invalid={invalid} dates={dates} spelled={spelled} onChange={(value) => change(index, { value })} />
                : dates && shape === 'one'
                  ? <DateField className="w-80" kind={dates} label="Значение" placeholder="значение" value={String(filter.value ?? '')} invalid={invalid} onChange={(value) => change(index, { value })} />
                  : withSpellingHint(spelled && shape === 'one', <Input className="w-80" aria-label="Значение" placeholder={shape === 'number' ? 'число' : 'значение'} inputMode={shape === 'number' ? 'numeric' : undefined}
                    value={String(filter.value ?? '')} aria-invalid={invalid} onChange={(event) => change(index, { value: event.target.value })} />)}
              {index < filters.length - 1 && joinToNext(index)}
              <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={`Убрать условие ${index + 1}`} onClick={() => update(filters.filter((_, at) => at !== index))}><XIcon className="size-4" /></Button>
              {drag.line(index)}
            </div>;
          })}
        </div>)}
        </div>}
        <div className={`flex flex-wrap items-center justify-between gap-3 ${filters.length ? 'pt-4' : ''}`}>
          <Button size="sm" variant="outline" disabled={!columns.length} onClick={() => {
            const column = columns[0]!;
            update([...filters, { column: column.name, condition: column.conditions[0] ?? 'is', value: '' }]);
          }}>Добавить условие</Button>
          {filters.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange([], caseSensitive)}>Очистить всё</Button>}
        </div>
      </section>
    </TooltipProvider>
  );
}

/**
 * A text box with the spelling hint on hover, or the box alone where the spelling is not read.
 * Hover only: a tooltip opened by focus would sit over the box while typing, and Escape would
 * close it instead of the panel.
 */
function withSpellingHint(shown: boolean, input: React.ReactElement<{ onFocus?: React.FocusEventHandler }>): React.ReactElement {
  if (!shown) return input;
  const quiet = React.cloneElement(input, { onFocus: (event: React.FocusEvent) => event.preventDefault() });
  return <Tooltip><TooltipTrigger asChild>{quiet}</TooltipTrigger><TooltipContent className="max-w-72">{SPELLING_HINT}</TooltipContent></Tooltip>;
}

function ValueList({ values, invalid, dates, spelled, onChange }: { values: string[]; invalid: boolean; dates: DateKind | null; spelled: boolean; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = React.useState('');
  const add = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && draft !== '') { event.preventDefault(); onChange([...values, draft]); setDraft(''); }
  };
  return <div className="flex w-80 flex-wrap gap-1">
    {values.map((value, index) => <Button key={index} size="sm" variant="secondary" aria-label={`Убрать значение ${value}`} onClick={() => onChange(values.filter((_, at) => at !== index))}>{value}<XIcon className="size-3" /></Button>)}
    {dates
      ? <DateField className="w-full" kind={dates} label="Значения" placeholder="значения" value={draft} invalid={invalid} onChange={setDraft} onKeyDown={add} />
      : withSpellingHint(spelled, <Input aria-label="Значения" placeholder="значения" value={draft} aria-invalid={invalid} onChange={(event) => setDraft(event.target.value)} onKeyDown={add} />)}
  </div>;
}
