import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fieldDraft, fieldValue, hasControlCharacters, messageOf, newUuid, shortType, type Column, type FieldDraft, type Row } from './model';

export function RowEditor({ schema, table, columns, primaryKey, readOnlyReason, row, onClose, onSave }: {
  schema: string;
  table: string;
  columns: Column[];
  primaryKey: string[];
  readOnlyReason: string | null;
  row: Row | null;
  onClose: () => void;
  onSave: (values: Row) => Promise<void>;
}) {
  const inserting = row === null;
  const [draft, setDraft] = React.useState(() => Object.fromEntries(columns.map((column) => [column.name,
    fieldDraft(inserting ? column.hasDefault || column.generated ? undefined : column.nullable ? null : '' : row[column.name]),
  ])));
  const [busy, setBusy] = React.useState(false);
  const editable = columns.filter((column) => !readOnlyReason && !column.readOnlyReason && !column.generated && (inserting || !primaryKey.includes(column.name)));
  const fields = inserting ? columns.filter((column) => !column.generated) : columns;
  const blockedInsert = inserting && columns.some((column) => column.readOnlyReason && !column.generated && !column.hasDefault && !column.nullable);
  const changed = inserting || editable.some((column) => {
    try { return fieldValue(draft[column.name]!) !== row[column.name]; }
    catch { return true; }
  });
  const generatedKey = (column: Column) => inserting && !column.readOnlyReason && primaryKey.length === 1 && primaryKey[0] === column.name
    && column.type === 'uuid' && !column.nullable && !column.hasDefault && !column.generated;

  function change(name: string, field: FieldDraft) {
    setDraft((previous) => ({ ...previous, [name]: field }));
  }
  function changeText(name: string, text: string) {
    const current = draft[name]!;
    change(name, current.escaped ? { ...current, text } : { ...fieldDraft(text), mode: current.mode });
  }
  function toggleEscaping(name: string, escaped: boolean) {
    try {
      const current = draft[name]!;
      const text = fieldValue({ ...current, mode: 'value' })!;
      if (!escaped && hasControlCharacters(text)) throw new Error('Спецсимволы требуют экранирования, чтобы браузер сохранил их без изменений.');
      change(name, { ...current, escaped, text: escaped ? JSON.stringify(text) : text });
    } catch (error) { toast.error(messageOf(error)); }
  }
  function paste(event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, name: string) {
    const current = draft[name]!;
    const pasted = event.clipboardData.getData('text/plain');
    if (current.escaped || !hasControlCharacters(pasted)) return;
    event.preventDefault();
    const { selectionStart, selectionEnd } = event.currentTarget;
    changeText(name, current.text.slice(0, selectionStart ?? current.text.length) + pasted + current.text.slice(selectionEnd ?? current.text.length));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || readOnlyReason || blockedInsert || !changed) return;
    setBusy(true);
    try {
      const values: [string, string | null][] = [];
      for (const column of editable) {
        const value = fieldValue(draft[column.name]!);
        if (value === undefined || (!inserting && value === row[column.name])) continue;
        values.push([column.name, value]);
      }
      if (inserting || values.length) await onSave(Object.fromEntries(values));
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
          {readOnlyReason && <p role="status" className="text-sm text-muted-foreground">Только чтение: {readOnlyReason}</p>}
          {!readOnlyReason && <p className="text-xs text-muted-foreground">Значения записываются в исходном текстовом формате PostgreSQL. Пустая строка, SQL NULL и значение по умолчанию выбираются отдельно.</p>}
          {!inserting && primaryKey.length > 0 && <p className="text-xs text-muted-foreground">Ключ — только чтение: {primaryKey.join(', ')}</p>}
          {blockedInsert && <p role="alert" className="text-sm text-destructive">Добавление недоступно: обязательная колонка имеет неподдержанный тип.</p>}
          {fields.map((column) => {
            const reason = readOnlyReason ?? column.readOnlyReason ?? (column.generated ? 'Вычисляется PostgreSQL' : !inserting && primaryKey.includes(column.name) ? 'Первичный ключ' : null);
            const locked = !!reason;
            const current = draft[column.name]!;
            const disabled = locked || busy || current.mode !== 'value';
            const input = { id: `database-field-${column.name}`, disabled, value: current.mode === 'value' ? current.text : '',
              placeholder: current.mode === 'null' ? 'SQL NULL' : current.mode === 'default' ? 'По умолчанию' : undefined,
              autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => changeText(column.name, event.target.value),
              onPaste: (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => paste(event, column.name),
              onDrop: (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                event.preventDefault();
                toast.info('Вставьте текст из буфера обмена: перетаскивание может изменить спецсимволы.');
              },
            };
            return <div key={column.name} className="space-y-1.5" data-testid="database-field" data-column={column.name}>
              <div className="flex items-baseline gap-2">
                <Label htmlFor={input.id}>{column.name}</Label>
                <span className="text-xs text-muted-foreground" title={column.type}>{shortType(column.type)}</span>
                {reason && <span className="ml-auto text-xs text-muted-foreground">Только чтение: {reason}</span>}
              </div>
              {!locked && (column.nullable || (inserting && column.hasDefault)) && <select
                aria-label={`Режим ${column.name}`} className="rounded-md border bg-background px-2 py-1 text-xs" disabled={busy}
                value={current.mode} onChange={(event) => change(column.name, { ...current, mode: event.target.value as FieldDraft['mode'] })}>
                <option value="value">Значение</option>
                {column.nullable && <option value="null">SQL NULL</option>}
                {inserting && column.hasDefault && <option value="default">По умолчанию</option>}
              </select>}
              <div className="flex gap-2">
                {current.escaped || /json|xml|bytea/i.test(column.type) || (row?.[column.name] ?? '').length > 80
                  ? <textarea {...input} className="flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs disabled:opacity-50" />
                  : <Input {...input} type="text" />}
                {generatedKey(column) && <Button type="button" variant="outline" disabled={busy} onClick={() => change(column.name, fieldDraft(newUuid()))}>Сгенерировать</Button>}
              </div>
              {!locked && current.mode === 'value' && <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={current.escaped} disabled={busy} onChange={(event) => toggleEscaping(column.name, event.target.checked)} />
                Экранировать спецсимволы
              </label>}
              {current.escaped && current.mode === 'value' && <p className="text-xs text-muted-foreground">JSON-строка в двойных кавычках: {'\\r'} — возврат каретки, {'\\n'} — перевод строки, {'\\t'} — табуляция.</p>}
            </div>;
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
          <Button type="submit" disabled={busy || !changed || !!readOnlyReason || blockedInsert}>{busy ? 'Сохраняем…' : inserting ? 'Добавить' : 'Сохранить'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
