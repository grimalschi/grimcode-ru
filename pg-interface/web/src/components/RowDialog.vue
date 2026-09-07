<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Column } from '../api';
import { cellText, shortType } from '../labels';

const props = defineProps<{
  open: boolean;
  schema: string;
  table: string;
  columns: Column[];
  primaryKey: string[];
  row: Record<string, unknown> | null;
  saving: boolean;
  /**
   * `edit` shows the row it was given; `insert` shows an empty form for a new one.
   *
   * One dialog rather than two, because the difference is small and lives in three places: whether the
   * key is written or read, what an empty field means, and which columns appear at all.
   */
  mode?: 'edit' | 'insert';
}>();

const emit = defineEmits<{
  close: [];
  save: [values: Record<string, unknown>];
}>();

/** What is being typed, as text. Converted back on save, so an empty field can mean null. */
const draft = ref<Record<string, string>>({});

watch(
  // `open` as well as the row: the dialog for a new row stays mounted with `row` always null, so
  // without it a form opened a second time would still hold what was typed into the one before.
  [() => props.row, () => props.open],
  ([row]) => {
    draft.value = Object.fromEntries(
      props.columns.map((column) => [column.name, cellText(row?.[column.name])]),
    );
  },
  { immediate: true },
);

const inserting = computed(() => props.mode === 'insert');

/**
 * The one field offered a value of this screen's making, and the button that offers it.
 *
 * Tables here declare their key as `uuid PRIMARY KEY` with no default: the modules generate it
 * themselves when they insert a row. Nothing fills it in for a row added through this screen, so the
 * field sat empty, went to the server as an empty string, and the answer was `invalid input syntax for
 * type uuid`. A button rather than a value put there on opening: the row is the person's, and a form
 * that fills part of itself in unasked is a form nobody reads.
 *
 * The whole key and nothing else. A uuid that is *not* the key is a reference to a row somewhere —
 * `profiles.identity_id`, `sessions.identity_id`, `administrator_grants.administrator_id` — and a made
 * up one is worse there than an empty field: where the reference crosses a module boundary there is no
 * foreign key to catch it, so the row would be saved pointing at nothing. A key of two columns is left
 * alone for the same reason: at least one half of it is such a reference.
 */
function generatedKey(column: Column): boolean {
  return (
    inserting.value &&
    props.primaryKey.length === 1 &&
    props.primaryKey[0] === column.name &&
    /^uuid$/i.test(column.type) &&
    !column.nullable &&
    column.hasDefault !== true &&
    column.generated !== true
  );
}

/** `randomUUID` is only there in a secure context (https, or localhost), so there is a way without it. */
function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Which columns a new row may carry: everything the database does not fill in by itself.
 *
 * A generated column — an identity, or one computed from others — is left out of the form entirely,
 * because the server refuses a new row that carries one.
 */
const writable = computed(() => props.columns.filter((column) => column.generated !== true));

const keyColumns = computed(() =>
  inserting.value ? [] : props.columns.filter((column) => props.primaryKey.includes(column.name)),
);

const editable = computed(() =>
  inserting.value
    ? writable.value
    : props.columns.filter((column) => !props.primaryKey.includes(column.name)),
);

/** What an empty field will do, said in the label rather than discovered after saving. */
function emptyMeans(column: Column): string {
  if (column.hasDefault === true) return 'пусто = по умолчанию';
  if (column.nullable) return 'пусто = null';
  return 'обязательно';
}

/**
 * Which columns get a box to write in and which get a line.
 *
 * Every field used to be a growing textarea, which gave a uuid the same tall box with a resize corner
 * as a template body — and made a form of eight short values look like a wall. A line is the default;
 * a box is for the types that really do hold something long, or for a value that already is.
 */
const LONG_TYPES = /text|json|xml|bytea/i;

function isLong(column: Column): boolean {
  return LONG_TYPES.test(column.type) && (draft.value[column.name] ?? '').length > 80;
}

/**
 * A date is picked rather than typed.
 *
 * `date` has no time and no zone, so a plain `YYYY-MM-DD` says all of it. A timestamp keeps the
 * offset of the browser that wrote it (`…+03:00`), because a moment without one is read in the
 * server's zone and would mean something else there.
 */
function dateKind(column: Column): 'date' | 'datetime' | null {
  if (/^date$/i.test(column.type)) return 'date';
  if (/timestamp/i.test(column.type)) return 'datetime';
  return null;
}

function dateFormat(column: Column): string {
  return dateKind(column) === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ssZ';
}

/**
 * What is sent, and it differs by mode.
 *
 * Editing sends the columns that changed and nothing else, so two people editing one row do not
 * overwrite each other. Inserting sends what was filled in: a field left empty on a column with a
 * default is **omitted**, which is the only way the database's own value applies.
 */
function save(): void {
  const values: Record<string, unknown> = {};

  if (inserting.value) {
    for (const column of writable.value) {
      const typed = draft.value[column.name] ?? '';

      if (typed === '' || typed === null) {
        if (column.hasDefault === true) continue;
        values[column.name] = column.nullable ? null : '';
        continue;
      }

      values[column.name] = typed;
    }

    emit('save', values);
    return;
  }

  for (const column of editable.value) {
    const typed = draft.value[column.name] ?? '';
    if (typed === cellText(props.row?.[column.name])) continue;

    // An emptied field means null where the column allows it, and an empty string where it does not: a
    // person clearing a `not null` text column means "make it empty", not "break the row".
    values[column.name] = typed === '' ? (column.nullable ? null : '') : typed;
  }

  emit('save', values);
}

const changed = computed(() =>
  inserting.value ||
  editable.value.some((column) => (draft.value[column.name] ?? '') !== cellText(props.row?.[column.name])),
);
</script>

<template>
  <el-dialog
    :model-value="open"
    width="40rem"
    :close-on-click-modal="false"
    class="row-dialog"
    @update:model-value="emit('close')"
  >
    <template #header>
      <div class="head">
        <span class="head-title">{{ inserting ? 'Новая строка' : 'Строка' }}</span>
        <span class="head-where">{{ schema }}.{{ table }}</span>
      </div>
    </template>

    <section v-if="keyColumns.length > 0" class="block">
      <h2 class="block-title">Ключ — только чтение</h2>
      <div class="field" v-for="column in keyColumns" :key="column.name">
        <div class="field-label">
          <span class="field-name">{{ column.name }}</span>
          <span class="field-type" :title="column.type">{{ shortType(column.type) }}</span>
        </div>
        <el-input :model-value="draft[column.name]" size="small" disabled />
      </div>
    </section>

    <section class="block">
      <div class="field" v-for="column in editable" :key="column.name">
        <div class="field-label">
          <span class="field-name">{{ column.name }}</span>
          <span class="field-type" :title="column.type">{{ shortType(column.type) }}</span>
          <span v-if="inserting" class="field-hint">{{ emptyMeans(column) }}</span>
          <span v-else-if="column.nullable" class="field-hint">пусто = null</span>
        </div>
        <el-date-picker
          v-if="dateKind(column)"
          v-model="draft[column.name]"
          class="field-date"
          size="small"
          :type="dateKind(column) ?? 'date'"
          :value-format="dateFormat(column)"
          placeholder="выберите дату"
        />

        <div v-else-if="generatedKey(column)" class="field-with-button">
          <el-input v-model="draft[column.name]" size="small" />
          <el-button class="field-generate" size="small" @click="draft[column.name] = newUuid()">
            Сгенерировать
          </el-button>
        </div>

        <el-input
          v-else
          v-model="draft[column.name]"
          size="small"
          :type="isLong(column) ? 'textarea' : 'text'"
          :autosize="isLong(column) ? { minRows: 3, maxRows: 10 } : undefined"
        />
      </div>
    </section>

    <template #footer>
      <el-button size="small" @click="emit('close')">Отмена</el-button>
      <el-button size="small" type="primary" :disabled="!changed" :loading="saving" @click="save">
        {{ inserting ? 'Добавить' : 'Сохранить' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<!--
  Not scoped: element-plus renders the dialog outside this component's tree, so a scoped rule would
  never reach its body. A wide table has thirty columns, and without this the dialog grows past the
  screen and takes its own buttons with it.
-->
<style>
/* Календарь занимает строку, как остальные поля: правило не scoped, потому что обёртку рисует сама библиотека. */
.row-dialog .el-date-editor,
.row-dialog .el-date-editor .el-input__wrapper {
  width: 100%;
}

.row-dialog .el-dialog__body {
  max-height: 62vh;
  overflow: auto;
}

.row-dialog .el-dialog__header {
  margin-right: 0;
}
</style>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head-title {
  font-size: 1rem;
  font-weight: 600;
}

.head-where {
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.block + .block {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.block-title {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.field + .field {
  margin-top: 10px;
}

.field-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
}

.field-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
}

.field-type,
.field-hint {
  color: var(--el-text-color-placeholder);
  font-size: 0.72rem;
}

.field-hint {
  margin-left: auto;
}

/* The field keeps the width of every other one; the button sits beside it rather than under it. */
.field-with-button {
  display: flex;
  gap: 8px;
}

.field-with-button .el-input {
  flex: 1;
}

.field-generate {
  flex: none;
}
</style>
