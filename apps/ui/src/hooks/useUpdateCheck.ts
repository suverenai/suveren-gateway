import { useState, useEffect, useRef } from 'react';

const SLOW_INTERVAL = 5 * 60 * 1000; // 5 minutes — background "is an update out?"
const FAST_INTERVAL = 2000;          // 2 seconds — while waiting for a restart

export type InstallMethod = 'docker' | 'npm' | 'dev';

/**
 * Polls /health for update state AND detects when the running gateway has
 * actually restarted onto different code (its reported `version` changed from
 * what this tab first saw). The version-delta — not an absolute match against
 * a baked-in build version — is the reload trigger, so it works the same under
 * npm (semver), Docker (git SHA), and dev ('dev', which never changes).
 */
export function useUpdateCheck() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installMethod, setInstallMethod] = useState<InstallMethod>('docker');
  const [version, setVersion] = useState<string>('');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [serverRestarted, setServerRestarted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [fast, setFast] = useState(false);

  // The version this tab first observed. Set once; a later change means the
  // server is now running code this tab doesn't have → it's stale.
  const initialVersion = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = (forceRefresh = false) => {
      fetch(forceRefresh ? '/health?refresh=1' : '/health')
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          if (data.installMethod) setInstallMethod(data.installMethod);
          if (typeof data.latestVersion !== 'undefined') setLatestVersion(data.latestVersion);
          if (data.updateAvailable) setUpdateAvailable(true);
          if (data.version) {
            setVersion(data.version);
            if (initialVersion.current === null) {
              initialVersion.current = data.version;
            } else if (data.version !== initialVersion.current && data.version !== 'dev') {
              setServerRestarted(true);
            }
          }
        })
        .catch(() => {
          /* server may be momentarily unreachable mid-restart — ignore */
        });
    };

    check(true);
    const id = setInterval(() => check(false), fast ? FAST_INTERVAL : SLOW_INTERVAL);

    // Re-check the instant the user returns to the tab (e.g. after running the
    // upgrade command in their terminal), so detection isn't gated on the timer.
    const onVisible = () => { if (document.visibilityState === 'visible') check(false); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fast]);

  return {
    updateAvailable: updateAvailable && !dismissed,
    installMethod,
    version,
    latestVersion,
    serverRestarted,
    /** Switch to fast polling — call when entering the "updating" overlay. */
    startFastPolling: () => setFast(true),
    dismiss: () => setDismissed(true),
  };
}
