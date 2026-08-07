import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { BrandMark } from './BrandMark';

/** Render the gateway's running version compactly. Docker stamps a
 *  full git SHA into HAP_BUILD_SHA — show the short 7-char form so it
 *  fits in the nav. npm passes a semver string ("0.1.4") which is
 *  already short. Empty until /health responds. */
function formatVersion(v: string): string {
  if (!v) return '';
  if (v === 'dev') return 'dev';
  if (/^[0-9a-f]{40}$/i.test(v)) return v.slice(0, 7); // git SHA
  return v;
}

const THEME_ICONS: Record<string, string> = {
  system: '\u25D1',
  light: '\u2600',
  dark: '\u263E',
};

interface TopNavProps {
  onMenuToggle?: () => void;
}

export function TopNav({ onMenuToggle }: TopNavProps) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { version, updateAvailable, latestVersion } = useUpdateCheck();
  const versionLabel = formatVersion(version);

  return (
    <nav className="top-nav">
      <div className="top-nav-inner">
        {/* The running version sits with the product name, not in the actions
            cluster, and shows whether or not anyone is signed in — it is a
            property of this gateway, and it is most useful WHILE working (the
            old placement showed it only on the login screen).

            The group/domain pair that used to live in the user chip is gone: it
            was repeated verbatim in the sidebar's "Active context", and the
            second copy was a raw UUID, which is the least readable thing that
            was on the page. */}
        <div className="logo-group">
          <BrandMark size={20} />
          <span className="logo">Suveren</span>
          <span className="version-badge">Local Gateway</span>
          {versionLabel && (
            <span
              className="gw-version"
              title={updateAvailable && latestVersion
                ? `Running v${versionLabel} — v${latestVersion} is available`
                : 'Running gateway version'}
              data-stale={updateAvailable ? 'true' : undefined}
            >
              v{versionLabel}{updateAvailable && latestVersion ? ` → ${latestVersion}` : ''}
            </span>
          )}
        </div>
        <div className="nav-spacer" />
        <div className="nav-actions nav-actions-desktop">
          {user ? (
            <>
              <span className="user-chip">
                <strong>{user.name}</strong>
              </span>
              <button className="theme-toggle" onClick={toggle} title={`Theme: ${theme}`}>
                {THEME_ICONS[theme]}
              </button>
              <button className="nav-logout" onClick={logout}>Logout</button>
            </>
          ) : (
            <button className="theme-toggle" onClick={toggle} title={`Theme: ${theme}`}>
              {THEME_ICONS[theme]}
            </button>
          )}
        </div>
        {user && onMenuToggle && (
          <button className="mobile-menu-btn" onClick={onMenuToggle} aria-label="Menu">
            {'\u2630'}
          </button>
        )}
      </div>
    </nav>
  );
}
