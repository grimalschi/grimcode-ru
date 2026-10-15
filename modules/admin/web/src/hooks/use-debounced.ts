import * as React from 'react';

/**
 * The value as it was once it stopped changing for `delay` milliseconds.
 *
 * For typing into a filter: every keystroke changes the view, and without this every keystroke was a
 * request and a redrawn table. The first value is returned at once, so a page restored from its URL
 * does not wait.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = React.useState(value);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
