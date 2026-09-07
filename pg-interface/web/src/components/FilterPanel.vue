<script setup lang="ts">
import { computed } from 'vue';

import type { Column, Filter } from '../api';
import { CONDITION_LABELS, WITH_LIST, WITH_RANGE, WITHOUT_VALUE } from '../labels';

const props = defineProps<{
  columns: Column[];
  filters: Filter[];
  combine: 'and' | 'or';
}>();

const emit = defineEmits<{
  update: [filters: Filter[], combine: 'and' | 'or'];
}>();

const byName = computed(() => new Map(props.columns.map((column) => [column.name, column])));

/**
 * Which conditions this column takes, as the server said when it described the table.
 *
 * Asked rather than guessed: the server is what refuses a condition that does not apply, so offering
 * a different list here would only produce refusals a person cannot act on.
 */
function conditionsOf(name: string): readonly string[] {
  return byName.value.get(name)?.conditions ?? [];
}

function add(): void {
  const first = props.columns[0];
  if (!first) return;

  const condition = conditionsOf(first.name)[0] ?? 'is';
  emit('update', [...props.filters, { column: first.name, condition, value: '' }], props.combine);
}

function remove(index: number): void {
  emit(
    'update',
    props.filters.filter((_, at) => at !== index),
    props.combine,
  );
}

/**
 * Every condition at once, for the way people actually stop filtering: they narrowed a page down
 * four conditions deep and want the whole table back, and removing them one by one asks the server
 * for a page after each. The combination is kept — with nothing left to combine it is not shown, and
 * it is the answer to a question that has not changed.
 */
function clear(): void {
  emit('update', [], props.combine);
}

function change(index: number, patch: Partial<Filter>): void {
  const next = props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter));

  // A column of another kind takes other conditions, so the old one would be refused: the first
  // condition of the new column is the honest default.
  if (patch.column !== undefined) {
    const allowed = conditionsOf(patch.column);
    const current = next[index];
    if (current && !allowed.includes(current.condition)) {
      current.condition = allowed[0] ?? current.condition;
    }
  }

  /*
   * A value shaped for the old condition is not a value for the new one: one string where a range needs
   * two, a list where one value is asked for. Cleared rather than converted, because a half-carried
   * value is what makes a filter ask something nobody meant.
   */
  if (patch.condition !== undefined) {
    const current = next[index];
    const previous = props.filters[index]?.condition ?? '';
    if (current && shapeOf(patch.condition) !== shapeOf(previous)) current.value = undefined;
  }

  emit('update', next, props.combine);
}

/** What kind of value a condition takes. Two conditions of the same shape can keep the value. */
function shapeOf(condition: string): 'none' | 'one' | 'range' | 'list' {
  if (WITHOUT_VALUE.has(condition)) return 'none';
  if (WITH_RANGE.has(condition)) return 'range';
  if (WITH_LIST.has(condition)) return 'list';
  return 'one';
}

/** One end of a range, as text for its field. */
function endOf(entry: Filter, at: 0 | 1): string {
  const range = Array.isArray(entry.value) ? entry.value : [];
  return String(range[at] ?? '');
}

function changeEnd(index: number, entry: Filter, at: 0 | 1, value: string): void {
  const range = Array.isArray(entry.value) ? [...entry.value] : ['', ''];
  range[at] = value;
  change(index, { value: [range[0] ?? '', range[1] ?? ''] });
}

/** The values of a list condition, as the select wants them. */
function listOf(entry: Filter): unknown[] {
  return Array.isArray(entry.value) ? entry.value : [];
}
</script>

<template>
  <div class="filters">
    <div v-if="filters.length > 0" class="filters-combine">
      <el-radio-group
        :model-value="combine"
        size="small"
        @update:model-value="emit('update', filters, $event as 'and' | 'or')"
      >
        <el-radio-button value="and" label="и" />
        <el-radio-button value="or" label="или" />
      </el-radio-group>
    </div>

    <div v-for="(filter, index) in filters" :key="index" class="filters-row">
      <!--
        `teleported: false` у каждого списка, и это несущее: element-plus по умолчанию рисует
        выпадающий список в конце документа, то есть вне поповера с фильтрами, — а поповер считает
        клик по нему кликом наружу и закрывается. Выбрать колонку было нельзя: панель захлопывалась.
      -->
      <el-select
        :model-value="filter.column"
        size="small"
        class="filters-column"
        :teleported="false"
        @update:model-value="change(index, { column: $event as string })"
      >
        <el-option v-for="column in columns" :key="column.name" :value="column.name" :label="column.name" />
      </el-select>

      <el-select
        :model-value="filter.condition"
        size="small"
        class="filters-condition"
        :teleported="false"
        @update:model-value="change(index, { condition: $event as string })"
      >
        <el-option
          v-for="condition in conditionsOf(filter.column)"
          :key="condition"
          :value="condition"
          :label="CONDITION_LABELS[condition] ?? condition"
        />
      </el-select>

      <!-- Каким бывает значение: его нет, оно одно, их два конца или это список. -->
      <span v-if="WITHOUT_VALUE.has(filter.condition)" class="filters-value filters-value_absent">—</span>

      <div v-else-if="WITH_RANGE.has(filter.condition)" class="filters-value filters-range">
        <el-input
          :model-value="endOf(filter, 0)"
          size="small"
          placeholder="от"
          @update:model-value="changeEnd(index, filter, 0, $event)"
        />
        <span class="filters-range-dash">—</span>
        <el-input
          :model-value="endOf(filter, 1)"
          size="small"
          placeholder="до"
          @update:model-value="changeEnd(index, filter, 1, $event)"
        />
      </div>

      <!--
        Список значений: element-plus умеет принимать введённое как новый вариант, и это здесь всё,
        что нужно — заранее известных вариантов у колонки нет, их печатает человек.
      -->
      <el-select
        v-else-if="WITH_LIST.has(filter.condition)"
        :model-value="listOf(filter)"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        :teleported="false"
        no-data-text="Введите значение и нажмите Enter"
        size="small"
        class="filters-value filters-list"
        placeholder="значения"
        @update:model-value="change(index, { value: $event as unknown[] })"
      />

      <el-input
        v-else
        :model-value="String(filter.value ?? '')"
        size="small"
        class="filters-value"
        placeholder="значение"
        @update:model-value="change(index, { value: $event })"
      />

      <el-button size="small" text @click="remove(index)">убрать</el-button>
    </div>

    <div class="filters-actions">
      <el-button size="small" class="filters-add" @click="add">Добавить условие</el-button>
      <!--
        Only with something to clear: an always-there button that does nothing reads as broken. Outlined
        in the colour the screen already uses for deleting, because it throws away work — several
        conditions someone assembled — even though nothing in the database is touched.
      -->
      <el-button
        v-if="filters.length > 0"
        size="small"
        type="danger"
        plain
        class="filters-clear"
        @click="clear"
      >
        Очистить всё
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 30rem;
}

.filters-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filters-column,
.filters-condition {
  width: 11rem;
}

.filters-value {
  width: 12rem;
}

.filters-value_absent {
  color: var(--el-text-color-placeholder);
  text-align: center;
}

/* Два конца диапазона в ширине одного поля: строка фильтра и без того длинная. */
.filters-range {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filters-range-dash {
  color: var(--el-text-color-placeholder);
}

/* Список значений растёт вниз, а не в ширину — иначе строка фильтра расползается. */
.filters-list {
  max-width: 12rem;
}

/* Добавить и очистить стоят в одной строке: обе про набор условий целиком. */
.filters-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/*
 * Очистка уходит к правому краю, подальше от «Добавить условие»: соседние кнопки — это промах мимо
 * одной по дороге к другой, а здесь промах стоит всех собранных условий.
 */
.filters-clear {
  margin-left: auto;
}
</style>
