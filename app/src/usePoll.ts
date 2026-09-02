import { useEffect } from 'react';

/** The panels' poll idiom, in one place: call `poll` once on a zero
 *  timeout (keeping setState out of the effect body per
 *  react-hooks/set-state-in-effect), then every `ms` until unmount.
 *  `enabled` gates the whole loop — a panel that is not showing polls
 *  nothing. */
export function usePoll(poll: () => void | Promise<void>, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const initial = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => void poll(), ms);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [poll, ms, enabled]);
}
