// Asks the daemon to refresh recently updated items whenever the dashboard is revealed, so
// changes made outside the browser (e.g. closing a PR with the gh CLI) show up promptly.
import { useEffect, useRef } from 'react';

/**
 * Calls `refresh` fire-and-forget when the component mounts, when the tab becomes visible
 * (`visibilitychange`), and when the window regains focus (`focus`). Failures are ignored: the
 * refresh is a best-effort hint, rate-limited by the daemon, whose results arrive through the
 * dashboard's regular polling.
 */
export function useRefreshOnReveal(refresh: () => Promise<unknown>): void {
  // Keep the latest callback without re-registering the listeners when it changes.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const trigger = async () => {
      try {
        await refreshRef.current();
      } catch {
        // Best effort: the next reveal (or the daemon's own timer) tries again.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void trigger();
      }
    };

    void trigger();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', trigger);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', trigger);
    };
  }, []);
}
