import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cellText, messageOf, newUuid, shortType, type Column, type Row } from './model';

function inputType(column: Column): 'text' | 'date' | 'datetime-local' {
  return column.type === 'date' ? 'date' : /timestamp/i.test(column.type) ? 'datetime-local' : 'text';
}

/** Local timestamps stay local; instants are displayed in the browser's time zone. */
function fieldText(column: Column, value: unknown): string {
  const text = cellText(value);
  if (!text || inputType(column) === 'text') return text;
  if (inputType(column) === 'date') return text.slice(0, 10);
  if (column.type !== 'timestamp with time zone') return text.replace(' ', 'T');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function storedValue(column: Column, typed: string): unknown {
  if (typed === '') return column.nullable ? null : '';
  return column.type === 'timestamp with time zone' ? new Date(typed).toISOString() : typed;
}

export function RowEditor({ schema, table, columns, primaryKey, row, onClose, onSave }: {
  schema: string;
  table: string;
  columns: Column[];
  primaryKey: string[];
  row: Row | null;
  onClose: () => void;
  onSave: (values: Row) => Promise<void>;
}) {
  const inserting = row === null;
  const [initial] = React.useState(() => Object.fromEntries(columns.map((column) => [column.name, fieldText(column, row?.[column.name])])));
  const [draft, setDraft] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const editable = columns.filter((column) => !column.generated && (inserting || !primaryKey.includes(column.name)));
  const fields = inserting ? editable : columns;
  const changed = inserting || editable.some((column) => draft[column.name] !== initial[column.name]);
  const generatedKey = (column: Column) => inserting && primaryKey.length === 1 && primaryKey[0] === column.name
    && column.type === 'uuid' && !column.nullable && !column.hasDefault && !column.generated;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const values: Row = {};
      for (const column of editable) {
        const typed = draft[column.name] ?? '';
        if (inserting ? typed === '' && column.hasDefault : typed === initial[column.name]) continue;
        values[column.name] = storedValue(column, typed);
      }
      await onSave(values);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" onInteractOutside={(event) => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle>{inserting ? 'Новая строка' : 'Строка'}</DialogTitle>
        <DialogDescription>{schema}.{table}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {!inserting && primaryKey.length > 0 && <p className="text-xs text-muted-foreground">Ключ — только чтение: {primaryKey.join(', ')}</p>}
          {fields.map((column) => {
            const locked = !inserting && (primaryKey.includes(column.name) || column.generated);
            const hint = locked ? 'только чтение' : inserting && column.hasDefault ? 'пусто = по умолчанию' : column.nullable ? 'пусто = SQL NULL' : inserting ? 'обязательно' : '';
            const text = draft[column.name] ?? '';
            return <div key={column.name} className="space-y-1.5" data-testid="database-field" data-column={column.name}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor={`database-field-${column.name}`}>{column.name}</Label>
                <span className="text-xs text-muted-foreground" title={column.type}>{shortType(column.type)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
              </div>
              <div className="flex gap-2">
                {inputType(column) === 'text' && (/json|xml|bytea/i.test(column.type) || (initial[column.name] ?? '').length > 80)
                  ? <textarea id={`database-field-${column.name}`} className="flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs disabled:opacity-50" disabled={locked || busy} value={text} onChange={(event) => setDraft({ ...draft, [column.name]: event.target.value })} />
                  : <Input id={`database-field-${column.name}`} type={inputType(column)} step="any" disabled={locked || busy} value={text} onChange={(event) => setDraft({ ...draft, [column.name]: event.target.value })} />}
                {generatedKey(column) && <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft({ ...draft, [column.name]: newUuid() })}>Сгенерировать</Button>}
              </div>
            </div>;
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
          <Button type="submit" disabled={busy || !changed}>{busy ? 'Сохраняем…' : inserting ? 'Добавить' : 'Сохранить'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
