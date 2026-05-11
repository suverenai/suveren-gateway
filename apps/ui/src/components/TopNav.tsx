import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { useUpdateCheck } from '../hooks/useUpdateCheck';

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

function ContextLabel() {
  const { mode, group, domain } = useAuth();
  if (mode === 'personal') return <span>personal</span>;
  if (group) return <span>{group.name} / {domain}</span>;
  return <span>{domain}</span>;
}

interface TopNavProps {
  onMenuToggle?: () => void;
}

export function TopNav({ onMenuToggle }: TopNavProps) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { version } = useUpdateCheck();
  const versionLabel = formatVersion(version);

  return (
    <nav className="top-nav">
      <div className="top-nav-inner">
        <div className="logo-group">
          <span className="logo">Suveren</span>
          <span className="version-badge">Local Gateway</span>
        </div>
        <div className="nav-spacer" />
        <div className="nav-actions nav-actions-desktop">
          {user ? (
            <>
              <span className="user-chip">
                <strong>{user.name}</strong>
                <span className="dot" />
                <ContextLabel />
              </span>
              <button className="theme-toggle" onClick={toggle} title={`Theme: ${theme}`}>
                {THEME_ICONS[theme]}
              </button>
              <button className="nav-logout" onClick={logout}>Logout</button>
            </>
          ) : (
            <>
              {versionLabel && (
                <span
                  title="Running gateway version"
                  style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}
                >
                  v{versionLabel}
                </span>
              )}
              <button className="theme-toggle" onClick={toggle} title={`Theme: ${theme}`}>
                {THEME_ICONS[theme]}
              </button>
            </>
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
