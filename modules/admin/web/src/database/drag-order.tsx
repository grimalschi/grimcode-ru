import * as React from 'react';

/**
 * Reordering a list of rows by hand: drag a row's handle, or focus it and press the arrow keys.
 *
 * Shared by the filter and sorting panels. While a row is dragged it is dimmed, and a thin line in
 * the gap above or below the row under the pointer shows where it will land — above when it comes
 * from below, below when it comes from above, which is where `reorder` puts it. A line rather than a
 * slot the height of a row, because the slot made the panel jump (the owner, 9 October 2026).
 *
 * `prefix` names the rows in the DOM (`<prefix>-drop` for the line, `data-handle` for the handles),
 * so the two panels do not read each other's handles.
 */
export function useDragOrder(count: number, reorder: (from: number, to: number) => void, prefix: string) {
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<number | null>(null);
  const end = () => { setDragging(null); setOver(null); };

  function move(from: number, to: number) {
    if (to < 0 || to >= count || from === to) return;
    reorder(from, to);
    // Keep the keyboard on the handle that moved, so another press moves it again.
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-handle="${prefix}-${to}"]`)?.focus());
  }

  return {
    /** Props for the row element; `dimmed` is for the caller's class list. */
    row: (index: number) => ({
      dimmed: dragging === index,
      onDragOver: (event: React.DragEvent) => { if (dragging !== null) { event.preventDefault(); if (over !== index) setOver(index); } },
      onDrop: (event: React.DragEvent) => { event.preventDefault(); if (dragging !== null) move(dragging, index); end(); },
    }),
    /** Props for the handle button inside the row. */
    handle: (index: number, label: string) => ({
      type: 'button' as const,
      draggable: true,
      'data-handle': `${prefix}-${index}`,
      'aria-label': label,
      title: 'Перетащите или нажмите стрелки вверх и вниз, чтобы изменить порядок',
      className: 'cursor-grab rounded text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing',
      onDragStart: (event: React.DragEvent) => { event.dataTransfer.effectAllowed = 'move'; setDragging(index); },
      onDragEnd: end,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); move(index, index - 1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(index, index + 1); }
      },
    }),
    /** The landing line for this row, or null; the row must be `relative`. */
    line: (index: number) => dragging !== null && over === index && dragging !== index
      ? <div data-testid={`${prefix}-drop`} aria-hidden="true" className={`absolute inset-x-0 h-0.5 rounded bg-ring ${dragging > index ? '-top-[5px]' : '-bottom-[5px]'}`} />
      : null,
  };
}
