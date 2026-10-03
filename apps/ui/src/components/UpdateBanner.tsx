import { useEffect, useRef, useState } from 'react';
import { useUpdateCheck, type InstallMethod } from '../hooks/useUpdateCheck';

// Survives the reload: set to the new version just before reloading so the
// freshly-loaded tab can show the green "you're on the latest" confirmation.
const JUST_UPDATED_KEY = 'suveren:updatedTo';

/** Per-install-method upgrade command. The control-plane reports
 *  `installMethod` on /health based on whether it sees /.dockerenv
 *  (docker), a node_modules path (npm), or neither (dev) — UNLESS IT policy
 *  or `SUVEREN_INSTALL_METHOD=managed` pre-empts that to `managed`.
 *  Returns `null` for `managed`: an employee on a managed install has no
 *  permission to run the npm command themselves (see
 *  docs/managed-settings.md), so there is no command to show at all. */
export function upgradeCommandFor(method: InstallMethod): string | null {
  if (method === 'managed') return null;
  if (method === 'npm') {
    // `restart`, not stop-then-start. Once the login service is installed —
    // which the CLI itself offers — stop/start no longer manage the process:
    // stop finds no PID file and start hits a port it cannot see. `restart`
    // drives whichever service manager owns the gateway, and falls back to the
    // manual path when there is none, so it is correct either way.
    return 'npm install -g @suveren/gateway@latest && suveren-gateway restart';
  }
  if (method === 'dev') {
    return 'git pull && pnpm install';
  }
  // docker (default)
  return 'docker rm -f suveren-gateway 2>/dev/null; docker ps -q --filter publish=7400 --filter publish=7430 | xargs -r docker rm -f; docker pull ghcr.io/suverenai/suveren-gateway:latest && docker run -d --name suveren-gateway -p 7400:3000 -p 7430:3030 -v $HOME/.suveren:/app/data ghcr.io/suverenai/suveren-gateway';
}

/** Shown in place of the Update button + command for a managed install —
 *  matches the signed-off mockup's copy exactly (temp/managed-settings-mockup.html). */
export const MANAGED_UPDATE_HINT =
  "Updates for this gateway come from your company's IT — no action needed here.";

/** Banner style per install method. A managed install asks nothing of the
 *  employee ("no action needed"), so it gets the neutral strip instead of the
 *  red one, which signals that the person in front of the screen should act.
 *  Every other method keeps the red banner unchanged. */
export function updateBannerClass(method: InstallMethod): string {
  return method === 'managed' ? 'update-banner is-managed' : 'update-banner';
}

/** Don't yank the page out from under in-progress work. An open modal/dialog
 *  (other than our own overlay) or a focused text field with content means the
 *  user is mid-task — defer the reload until that clears. */
function isUnsafeToReload(): boolean {
  // Any modal/dialog that isn't our own update overlay means the user is busy.
  const dialogs = document.querySelectorAll('[role="dialog"], .modal-overlay, .modal');
  for (const d of dialogs) {
    if (!d.closest('.update-overlay')) return true;
  }
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    const value = (el as HTMLInputElement).value;
    if (value && value.trim()) return true;
  }
  return false;
}

export function UpdateBanner() {
  const {
    updateAvailable, installMethod, version, latestVersion,
    serverRestarted, startFastPolling, dismiss,
  } = useUpdateCheck();

  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read the post-reload confirmation flag once, on mount.
  const [liveVersion, setLiveVersion] = useState<string | null>(() => {
    try {
      const v = sessionStorage.getItem(JUST_UPDATED_KEY);
      if (v) { sessionStorage.removeItem(JUST_UPDATED_KEY); return v; }
    } catch { /* sessionStorage unavailable */ }
    return null;
  });

  const updateCmd = upgradeCommandFor(installMethod);
  const ref = useRef<HTMLDivElement>(null);

  const reloadInto = (v: string) => {
    try { sessionStorage.setItem(JUST_UPDATED_KEY, v || latestVersion || '✓'); } catch { /* ignore */ }
    window.location.reload();
  };

  // Auto-dismiss the green confirmation bar.
  useEffect(() => {
    if (!liveVersion) return;
    const t = setTimeout(() => setLiveVersion(null), 6000);
    return () => clearTimeout(t);
  }, [liveVersion]);

  // Once the server is back on new code, reload automatically — unless the user
  // is mid-task, in which case keep retrying until it's safe (Reload now also
  // stays available as a manual override).
  useEffect(() => {
    if (!updating || !serverRestarted) return;
    const attempt = () => {
      if (!isUnsafeToReload()) { reloadInto(version); return true; }
      return false;
    };
    if (attempt()) return;
    const t = setInterval(attempt, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating, serverRestarted, version]);

  // Blur the app chrome while the overlay is up.
  useEffect(() => {
    document.body.classList.toggle('is-updating', updating);
    return () => document.body.classList.remove('is-updating');
  }, [updating]);

  // Push sidebar + main content down by the visible bar's height (red or green).
  const showBar = (updateAvailable && !updating && !liveVersion) || (!!liveVersion && !updating);
  useEffect(() => {
    if (!showBar) {
      document.documentElement.style.removeProperty('--update-banner-h');
      document.body.classList.remove('has-update-banner');
      return;
    }
    document.body.classList.add('has-update-banner');
    const measure = () => {
      const h = ref.current?.offsetHeight ?? 0;
      document.documentElement.style.setProperty('--update-banner-h', `${h}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--update-banner-h');
      document.body.classList.remove('has-update-banner');
    };
  }, [showBar]);

  const beginUpdate = () => { setUpdating(true); startFastPolling(); };
  const copyCmd = async () => {
    if (!updateCmd) return; // managed install: no command exists to copy
    try {
      await navigator.clipboard.writeText(updateCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <>
      {/* Post-reload confirmation — the most recent version is live. */}
      {liveVersion && !updating && (
        <div ref={ref} className="update-banner is-live" role="status" aria-live="polite">
          <div className="update-banner-row">
            <span className="update-banner-text">
              {'✓'} You{'’'}re on the latest version
              {liveVersion && liveVersion !== '✓' ? ` — ${liveVersion} is live` : ' — now live'}.
            </span>
            <button className="update-banner-x" onClick={() => setLiveVersion(null)} aria-label="Dismiss">{'×'}</button>
          </div>
        </div>
      )}

      {/* Update available — headline + Update only; the command lives in the overlay.
          Managed install: no command exists to run, so no Update button either —
          just the headline, the "ask your IT" hint, and dismiss. */}
      {updateAvailable && !updating && !liveVersion && (
        <div ref={ref} className={updateBannerClass(installMethod)} role="status" aria-live="polite">
          <div className="update-banner-row">
            <span className="update-banner-text">Update available.</span>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {installMethod !== 'managed' && (
                <button className="btn btn-sm btn-secondary" onClick={beginUpdate}>Update</button>
              )}
              <button className="update-banner-x" onClick={dismiss} aria-label="Dismiss">{'×'}</button>
            </div>
          </div>
          {installMethod === 'managed' && (
            <p className="update-banner-hint">{MANAGED_UPDATE_HINT}</p>
          )}
        </div>
      )}

      {/* Updating — blurred chrome behind, waiting for the restart. */}
      {updating && (
        <div className="update-overlay">
          <div className="update-overlay-card" role="dialog" aria-modal="true" aria-label="Finishing the update">
            <div className="update-spinner" />
            <h2>Finishing the update{'…'}</h2>
            <p>
              Copy this command and run it in your terminal. The gateway will restart, and{' '}
              <strong>this page updates automatically</strong> when it comes back {'—'} no need to refresh.
            </p>
            <div className="update-cmd-row">
              <code className="update-cmd">{updateCmd}</code>
              <button className="btn btn-sm btn-primary" onClick={copyCmd}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="update-status">
              <span className="update-pulse" /> Waiting for the gateway to restart{'…'}
            </div>
            <div className="update-overlay-actions">
              <button className="btn btn-primary" onClick={() => reloadInto(version)}>Reload now</button>
              <button className="btn btn-secondary" onClick={() => setUpdating(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
