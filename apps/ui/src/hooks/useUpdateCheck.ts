import { useState, useEffect } from 'react';

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export type InstallMethod = 'docker' | 'npm' | 'dev';

export function useUpdateCheck() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installMethod, setInstallMethod] = useState<InstallMethod>('docker');
  const [version, setVersion] = useState<string>('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // First call: ?refresh=1 forces a fresh GHCR check on the backend.
    // This is the "on login / reload" path — users who just opened the app
    // get an accurate update status in this round-trip. Subsequent interval
    // calls omit the flag and use the backend's hourly cache.
    const check = (forceRefresh = false) => {
      fetch(forceRefresh ? '/health?refresh=1' : '/health')
        .then(r => r.json())
        .then(data => {
          if (data.updateAvailable) setUpdateAvailable(true);
          if (data.installMethod) setInstallMethod(data.installMethod);
          if (data.version) setVersion(data.version);
        })
        .catch(() => {});
    };

    check(true);
    const id = setInterval(() => check(false), CHECK_INTERVAL);
    return () => clearInterval(id);
  }, []);

  return {
    updateAvailable: updateAvailable && !dismissed,
    installMethod,
    version,
    dismiss: () => setDismissed(true),
  };
}
