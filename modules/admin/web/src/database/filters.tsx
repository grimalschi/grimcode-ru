import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CONDITION_LABELS, filterShape, type Column, type Filter } from './model';

export function Filters({ columns, filters, combine, onChange }: {
  columns: Column[];
  filters: Filter[];
  combine: 'and' | 'or';
  onChange: (filters: Filter[], combine: 'and' | 'or') => void;
}) {
  const conditions = (name: string) => columns.find((column) => column.name === name)?.conditions ?? [];
  function change(index: number, patch: Partial<Filter>) {
    onChange(filters.map((filter, at) => {
      if (at !== index) return filter;
      const next = { ...filter, ...patch };
      if (patch.column && !conditions(patch.column).includes(next.condition)) {
        next.condition = conditions(patch.column)[0] ?? 'is';
      }
      if (filterShape(next.condition) !== filterShape(filter.condition)) next.value = undefined;
      return next;
    }), combine);
  }
  return (
    <section aria-label="Фильтры таблицы" className="space-y-3 rounded-lg border bg-muted/20 p-4">
      {filters.length > 0 && <div className="flex gap-2" aria-label="Объединение условий">
        <Button size="sm" variant={combine === 'and' ? 'default' : 'outline'} aria-pressed={combine === 'and'} onClick={() => onChange(filters, 'and')}>И</Button>
        <Button size="sm" variant={combine === 'or' ? 'default' : 'outline'} aria-pressed={combine === 'or'} onClick={() => onChange(filters, 'or')}>ИЛИ</Button>
      </div>}
      {filters.map((filter, index) => {
        const shape = filterShape(filter.condition);
        return <div key={index} data-testid="database-filter" className="flex flex-wrap items-center gap-2">
          <Select value={filter.column} onValueChange={(column) => change(index, { column })}>
            <SelectTrigger aria-label={`Колонка условия ${index + 1}`} className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={filter.condition} onValueChange={(value) => {
            const condition = conditions(filter.column).find((entry) => entry === value);
            if (condition) change(index, { condition });
          }}>
            <SelectTrigger aria-label={`Условие ${index + 1}`} className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{conditions(filter.column).map((condition) => <SelectItem key={condition} value={condition}>{CONDITION_LABELS[condition] ?? condition}</SelectItem>)}</SelectContent>
          </Select>
          {shape === 'none' ? <span className="w-48 text-muted-foreground">—</span> : shape === 'range' ? <div className="flex w-56 items-center gap-2">
            {([0, 1] as const).map((at) => <Input key={at} aria-label={at === 0 ? 'От' : 'До'} placeholder={at === 0 ? 'от' : 'до'} value={String((Array.isArray(filter.value) ? filter.value[at] : '') ?? '')} onChange={(event) => {
              const range = Array.isArray(filter.value) ? [...filter.value] : ['', ''];
              range[at] = event.target.value;
              change(index, { value: range });
            }} />)}
          </div> : shape === 'list' ? <ValueList values={Array.isArray(filter.value) ? filter.value.map(String) : []} onChange={(value) => change(index, { value })} />
            : <Input className="w-56" aria-label="Значение" placeholder="значение" value={String(filter.value ?? '')} onChange={(event) => change(index, { value: event.target.value })} />}
          <Button size="icon" variant="ghost" aria-label={`Убрать условие ${index + 1}`} onClick={() => onChange(filters.filter((_, at) => at !== index), combine)}><XIcon /></Button>
        </div>;
      })}
      <div className="flex justify-between gap-2">
        <Button size="sm" variant="outline" disabled={!columns.length} onClick={() => {
          const column = columns[0]!;
          onChange([...filters, { column: column.name, condition: column.conditions[0] ?? 'is', value: '' }], combine);
        }}>Добавить условие</Button>
        {filters.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange([], combine)}>Очистить всё</Button>}
      </div>
    </section>
  );
}

function ValueList({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = React.useState('');
  return <div className="flex w-56 flex-wrap gap-1">
    {values.map((value, index) => <Button key={index} size="sm" variant="secondary" aria-label={`Убрать значение ${value}`} onClick={() => onChange(values.filter((_, at) => at !== index))}>{value}<XIcon className="size-3" /></Button>)}
    <Input aria-label="Значения" placeholder="значения" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Enter' && draft !== '') { event.preventDefault(); onChange([...values, draft]); setDraft(''); }
    }} />
  </div>;
}
