import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../hooks/useTheme';

const THEME_ICONS: Record<string, string> = {
  system: '\u25D1',
  light: '\u2600',
  dark: '\u263E',
};

const NAV_ITEMS = [
  { to: '/', icon: '\u25A1', label: 'Dashboard' },
  { to: '/proposals', icon: '\u25B7', label: 'Pending Approvals' },
  { to: '/authorizations', icon: '\u2630', label: 'Mandates' },
  { to: '/agent-brief', icon: '▤', label: 'Agent Brief' },
  { to: '/audit', icon: '\u25A3', label: 'Tickets' },
  { to: '/groups', icon: '\u25C9', label: 'Team' },
  { to: '/integrations', icon: '\u29D7', label: 'Integrations' },
  { to: '/settings', icon: '\u2699', label: 'AI Assistant' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function MobileMenu({ open, onClose }: Props) {
  const { user, activeGroup, activeDomain, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const location = useLocation();

  // Close on route change
  useEffect(() => {
    onClose();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="mobile-menu-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="mobile-menu-panel">
        {/* User info */}
        {user && (
          <div className="mobile-menu-header">
            <strong>{user.name}</strong>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {activeGroup ? `${activeGroup.name} / ${activeDomain}` : activeDomain || 'personal'}
            </span>
          </div>
        )}

        {/* Navigation */}
        <nav className="mobile-menu-nav">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `mobile-menu-item${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Actions */}
        <div className="mobile-menu-footer">
          <button className="mobile-menu-action" onClick={() => { toggle(); }}>
            <span className="icon">{THEME_ICONS[theme]}</span>
            Theme: {theme}
          </button>
          <button className="mobile-menu-action" onClick={() => { logout(); onClose(); }}>
            Logout
          </button>
        </div>
      </div>
    </>
  );
}
