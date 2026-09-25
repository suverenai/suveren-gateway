import { useEffect, useState } from 'react';
import { applyAppBadge } from '../lib/tab-badge';
import { usePendingCount } from '../hooks/usePendingCount';

/**
 * One-time prompt, shown only where it is needed: the gateway running as a
 * Safari web app ("Add to Dock"). Safari shows the Dock badge only after
 * notification permission is granted, and it only lets a page ask from a
 * click. Chrome and Edge installed apps badge without permission, so they never
 * see this. Dismissal is remembered per browser.
 */
const DISMISS_KEY = 'suveren:dockBadgePrompt';

function needsPrompt(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (!('setAppBadge' in navigator)) return false;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone) return false;
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
  if (!isSafari) return false;
  if (Notification.permission !== 'default') return false;
  try { if (localStorage.getItem(DISMISS_KEY)) return false; } catch { /* storage unavailable */ }
  return true;
}

export function DockBadgePrompt() {
  const [show, setShow] = useState(false);
  const count = usePendingCount();

  useEffect(() => { setShow(needsPrompt()); }, []);
  if (!show) return null;

  const close = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setShow(false);
  };

  const allow = async () => {
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') applyAppBadge(count);
    } catch { /* the user or the browser declined */ }
    close();
  };

  return (
    <div className="hint-box" style={{ marginBottom: '1rem', alignItems: 'center' }}>
      <div className="hint-body">
        <div className="hint-head">Show waiting approvals on the Dock icon</div>
        Safari needs your permission once. The icon then shows how many approvals are waiting, and nothing else.
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={allow}>Allow</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={close} aria-label="Not now">Not now</button>
    </div>
  );
}
