import * as React from 'react';
import { Settings2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fieldDraft, fieldValue, hasControlCharacters, messageOf, newUuid, shortType, type Column, type FieldDraft, type Row } from './model';

export function RowEditor({ schema, table, columns, primaryKey, readOnlyReason, notice = null, row, onClose, onSave }: {
  schema: string;
  table: string;
  columns: Column[];
  primaryKey: string[];
  readOnlyReason: string | null;
  /** A warning about the table that leaves it editable; shown again here, where the save button is. */
  notice?: string | null;
  row: Row | null;
  onClose: () => void;
  onSave: (values: Row) => Promise<void>;
}) {
  const inserting = row === null;
  const [draft, setDraft] = React.useState(() => Object.fromEntries(columns.map((column) => [column.name,
    fieldDraft(inserting ? column.hasDefault || column.generated ? undefined : column.nullable ? null : '' : row[column.name]),
  ])));
  const [busy, setBusy] = React.useState(false);
  /** Modes lent out by clicking into a NULL or default box: the mode to return to if nothing gets typed. */
  const lent = React.useRef<Record<string, FieldDraft['mode']>>({});
  const editable = columns.filter((column) => !readOnlyReason && !column.readOnlyReason && !column.generated && (inserting || !primaryKey.includes(column.name)));
  // A column the database fills in is shown locked rather than hidden, so a new row explains where its number comes from.
  const fields = columns;
  const blockedInsert = inserting && columns.some((column) => column.readOnlyReason && !column.generated && !column.hasDefault && !column.nullable);
  const changed = inserting || editable.some((column) => {
    try { return fieldValue(effective(column.name)) !== row[column.name]; }
    catch { return true; }
  });
  const generatedKey = (column: Column) => inserting && !column.readOnlyReason && primaryKey.length === 1 && primaryKey[0] === column.name
    && column.type === 'uuid' && !column.nullable && !column.hasDefault && !column.generated;

  function change(name: string, field: FieldDraft) {
    setDraft((previous) => ({ ...previous, [name]: field }));
  }
  /*
   * A box in "SQL NULL" or "По умолчанию" mode is not disabled: clicking into it switches to
   * "Значение" so one can just type. Leaving it with nothing typed switches back, so a stray click
   * never turns NULL into an empty string. The mode chosen in the settings panel is kept as is.
   */
  function enter(name: string) {
    const current = draft[name]!;
    if (current.mode === 'value') return;
    lent.current[name] = current.mode;
    change(name, { ...current, mode: 'value' });
  }
  function leave(name: string) {
    const previous = lent.current[name];
    if (!previous) return;
    delete lent.current[name];
    const current = draft[name]!;
    if (current.mode === 'value' && current.text === '') change(name, { ...current, mode: previous });
  }
  function chooseMode(name: string, mode: FieldDraft['mode']) {
    delete lent.current[name];
    change(name, { ...draft[name]!, mode });
  }
  /** The field as it will be saved: a box only clicked into, still empty, counts as what it was. */
  function effective(name: string): FieldDraft {
    const current = draft[name]!;
    const previous = lent.current[name];
    return previous && current.mode === 'value' && current.text === '' ? { ...current, mode: previous } : current;
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
        const value = fieldValue(effective(column.name));
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

  const form = React.useRef<HTMLFormElement>(null);
  // The first tabbable thing is now a field's settings icon: start in the first box one can type into instead.
  function focusFirstField(event: Event) {
    const field = form.current?.querySelector<HTMLElement>('input:not([disabled]):not([type=radio]), textarea:not([disabled])');
    if (!field) return;
    event.preventDefault();
    field.focus();
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" onInteractOutside={(event) => event.preventDefault()} onOpenAutoFocus={focusFirstField}>
      <DialogHeader>
        <DialogTitle>{inserting ? 'Новая строка' : 'Строка'}</DialogTitle>
        <DialogDescription>{schema}.{table}</DialogDescription>
      </DialogHeader>
      <form ref={form} onSubmit={(event) => void submit(event)} className="space-y-5">
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {readOnlyReason && <p role="status" className="text-sm text-muted-foreground">Только чтение: {readOnlyReason}</p>}
          {!readOnlyReason && notice && <p role="note" className="rounded-md border px-3 py-2 text-sm">{notice}</p>}
          {!readOnlyReason && <p className="text-xs text-muted-foreground">Значения записываются в исходном текстовом формате PostgreSQL. Пустая строка, SQL NULL и значение по умолчанию выбираются отдельно.</p>}
          {!inserting && primaryKey.length > 0 && <p className="text-xs text-muted-foreground">Ключ — только чтение: {primaryKey.join(', ')}</p>}
          {blockedInsert && <p role="alert" className="text-sm text-destructive">Добавление недоступно: обязательная колонка имеет неподдержанный тип.</p>}
          {fields.map((column) => {
            const automatic = inserting && column.generated;
            const reason = readOnlyReason ?? column.readOnlyReason
              ?? (automatic ? 'Автоматически — PostgreSQL назначит значение при сохранении'
                : column.generated ? 'Вычисляется PostgreSQL' : !inserting && primaryKey.includes(column.name) ? 'Первичный ключ' : null);
            const locked = !!reason;
            const current = draft[column.name]!;
            const disabled = locked || busy;
            const input = { id: `database-field-${column.name}`, disabled, value: current.mode === 'value' ? current.text : '',
              placeholder: automatic ? 'Автоматически' : current.mode === 'null' ? 'SQL NULL' : current.mode === 'default' ? 'По умолчанию' : undefined,
              autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
              onFocus: () => enter(column.name),
              onBlur: () => leave(column.name),
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => changeText(column.name, event.target.value),
              onPaste: (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => paste(event, column.name),
              onDrop: (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                event.preventDefault();
                toast.info('Вставьте текст из буфера обмена: перетаскивание может изменить спецсимволы.');
              },
            };
            return <div key={column.name} className="space-y-1.5" data-testid="database-field" data-column={column.name}>
              <div className="flex items-center gap-2">
                <Label htmlFor={input.id}>{column.name}</Label>
                <span className="text-xs text-muted-foreground" title={column.type}>{shortType(column.type)}</span>
                {reason
                  ? <span className="ml-auto text-xs text-muted-foreground">Только чтение: {reason}</span>
                  : <FieldSettings column={column} current={current} busy={busy}
                    modes={[...(column.nullable ? [['null', 'SQL NULL'] as const] : []), ['value', 'Значение'], ...(inserting && column.hasDefault ? [['default', 'По умолчанию'] as const] : [])]}
                    onMode={(mode) => chooseMode(column.name, mode)} onEscape={(escaped) => toggleEscaping(column.name, escaped)} />}
              </div>
              <div className="flex gap-2">
                {current.escaped || /json|xml|bytea/i.test(column.type) || (row?.[column.name] ?? '').length > 80
                  ? <textarea {...input} className="flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs disabled:opacity-50" />
                  : <Input {...input} type="text" />}
                {generatedKey(column) && <Button type="button" variant="outline" disabled={busy} onClick={() => change(column.name, fieldDraft(newUuid()))}>Сгенерировать</Button>}
              </div>
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

/**
 * The field's mode and escaping, behind a settings icon opposite its name (the owner's layout, 12 October 2026):
 * a popover with the mode as radio buttons where the column has more than one (SQL NULL first, the owner's order), and the escaping box
 * with its spelling note. The icon is tinted while anything is set.
 */
function FieldSettings({ column, current, busy, modes, onMode, onEscape }: {
  column: Column;
  current: FieldDraft;
  busy: boolean;
  modes: readonly (readonly [FieldDraft['mode'], string])[];
  onMode: (mode: FieldDraft['mode']) => void;
  onEscape: (escaped: boolean) => void;
}) {
  // No tooltip on the icon (the owner, 12 October): the state is read by opening the panel; the tint only says there is one.
  const set = current.mode !== 'value' || current.escaped;
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={`Настройки ${column.name}`} data-set={set ? 'true' : undefined}
        className={`ml-auto size-7 ${set ? 'text-primary' : 'text-muted-foreground'}`}><Settings2Icon className="size-4" /></Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-72 space-y-3 text-sm" aria-label={`Настройки ${column.name}`}>
      {modes.length > 1 && <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs text-muted-foreground">Режим</legend>
        {modes.map(([mode, label]) => <label key={mode} className="flex items-center gap-2">
          <input type="radio" name={`database-mode-${column.name}`} value={mode} checked={current.mode === mode} disabled={busy} onChange={() => onMode(mode)} />
          {label}
        </label>)}
      </fieldset>}
      {current.mode === 'value' && <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <Checkbox checked={current.escaped} disabled={busy} onCheckedChange={(checked) => onEscape(checked === true)} aria-label="Экранировать спецсимволы" />
          Экранировать спецсимволы
        </label>
        <p className="text-xs text-muted-foreground">JSON-строка в двойных кавычках: {'\\r'} — возврат каретки, {'\\n'} — перевод строки, {'\\t'} — табуляция.</p>
      </div>}
    </PopoverContent>
  </Popover>;
}
