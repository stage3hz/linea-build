// The wait after wrong codes, as the screens see it: one shared counter in the saved settings, so the
// lock screen and the settings' «confirm your code» step cost the same and a restart does not reset it.
import { useEffect, useState } from 'react';
import { retryWaitMs } from './model';
import { useLockSettings } from './storage';

/** Milliseconds before the next try is allowed (0 = may try), ticking every half second while waiting. */
export function useRetryWait(): number {
  const settings = useLockSettings();
  const [now, setNow] = useState(() => Date.now());
  const wait = retryWaitMs(settings.failures, settings.lastFailureAt, now);
  const waiting = wait > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [waiting]);
  return wait;
}
