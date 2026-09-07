import * as React from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs a request and keeps its loading and failure state.
 *
 * Deliberately small: the admin screens read a handful of endpoints, and a data-fetching library
 * would be a dependency the template does not otherwise need. A result that arrives after the
 * inputs changed is discarded rather than shown.
 */
export function useAsync<T>(run: () => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [state, setState] = React.useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    run().then(
      (data) => current && setState({ data, error: null, loading: false }),
      (error: unknown) => current && setState({ data: null, error, loading: false }),
    );

    return () => {
      current = false;
    };
    /*
     * `deps` is this hook's contract with its caller — the caller says what the request depends on,
     * exactly as it would for `useEffect`. `run` is a fresh closure every render and including it
     * would refetch forever.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);

  return { ...state, reload };
}

/** Shape every paginated admin endpoint returns. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
