<script setup lang="ts">
import { computed } from 'vue';

import { cellText, shortType } from '../labels';

/**
 * One cell, in full, beside the cell the pointer is on.
 *
 * A table shows a line of a value; a uuid, a hash or a json document is longer than the line. Hovering
 * a cell shows the whole of it — element-plus's own popover rather than the browser's `title`, which is
 * grey, slow to appear and cannot show a json document as anything but one long line.
 *
 * **Nothing in here is interactive**, and that follows from opening on hover: the popover is a passing
 * thing, so it never sits under the pointer (`pointer-events: none`) and carries no buttons. json is
 * always indented, because a document is what it is.
 *
 * One instance for the whole table, positioned by `virtual-ref` on the cell being hovered. A popover per
 * cell would be several hundred components on a page of twenty rows, all to show one at a time.
 */
const props = defineProps<{
  column: { name: string; type: string } | null;
  value: unknown;
  /** The cell element the popover points at. Null when nothing is shown. */
  anchor: HTMLElement | null;
}>();

const text = computed(() => cellText(props.value));
const lines = computed(() => text.value.split('\n').length);

/** A json value is stored as one line and reads as none: indented, it is a document again. */
const body = computed(() => {
  if (typeof props.value !== 'object' || props.value === null) return text.value;
  return JSON.stringify(props.value, null, 2);
});
</script>

<template>
  <el-popover
    :visible="column !== null && anchor !== null"
    :virtual-ref="anchor ?? undefined"
    virtual-triggering
    placement="bottom-start"
    :width="520"
    :show-arrow="false"
    popper-class="value-popover"
  >
    <div class="head">
      <span class="head-name">{{ column?.name }}</span>
      <span class="head-type" :title="column?.type">{{ shortType(column?.type ?? '') }}</span>
      <span class="head-size">{{ text.length }} символов{{ lines > 1 ? `, ${lines} строк` : '' }}</span>
    </div>

    <pre class="value">{{ body }}</pre>
  </el-popover>
</template>

<style>
/*
 * Never wider than the frame it sits in, and never under the pointer: it appears on hover, so a
 * popover that took the mouse would block the cell it describes and the ones next to it.
 */
.value-popover {
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
</style>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.head-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  font-weight: 600;
}

.head-type,
.head-size {
  color: var(--el-text-color-placeholder);
  font-size: 0.75rem;
}

.head-size {
  margin-left: auto;
}

/* The value itself: monospace, wrapping where it has to, scrolling when it is a long json document. */
.value {
  margin: 0;
  padding: 8px 10px;
  max-height: 20rem;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
