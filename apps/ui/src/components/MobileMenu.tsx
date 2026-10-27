import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { NavIcon, type NavIconName } from './NavIcon';

const THEME_ICONS: Record<string, string> = {
  system: '\u25D1',
  light: '\u2600',
  dark: '\u263E',
};

export const NAV_ITEMS = [
  // Same order as the sidebar (UI spec §12.1): the core objects, then setup.
  { to: '/', icon: 'dashboard' as NavIconName, label: 'Dashboard' },
  { to: '/approvals', icon: 'approvals' as NavIconName, label: 'Approvals' },
  { to: '/mandates', icon: 'mandates' as NavIconName, label: 'Mandates' },
  { to: '/tickets', icon: 'tickets' as NavIconName, label: 'Tickets' },
  { to: '/reports', icon: 'reports' as NavIconName, label: 'Reports' },
  { to: '/blocked', icon: 'blocked' as NavIconName, label: 'Blocked' },
  { to: '/team', icon: 'team' as NavIconName, label: 'Team' },
  { to: '/agent-brief', icon: 'brief' as NavIconName, label: 'Agent Brief' },
  { to: '/integrations', icon: 'integrations' as NavIconName, label: 'Integrations' },
  { to: '/settings', icon: 'settings' as NavIconName, label: 'Settings' },
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
              <span className="icon"><NavIcon name={item.icon} /></span>
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
