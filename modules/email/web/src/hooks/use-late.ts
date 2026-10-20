import * as React from 'react';

/**
 * Whether a wait has gone on for `delay` milliseconds.
 *
 * A screen that answers quickly then shows no loading state at all and appears whole, instead of a
 * placeholder that flashes for a moment; only a slow answer gets a loader. The same 300 ms the
 * database editor waits before its own placeholder.
 */
export function useLate(waiting: boolean, delay = 300): boolean {
  const [late, setLate] = React.useState(false);

  React.useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setLate(true), delay);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [waiting, delay]);

  return waiting && late;
}
