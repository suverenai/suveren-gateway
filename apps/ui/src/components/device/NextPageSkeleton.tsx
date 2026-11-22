import { SkelArea, SkelLine, SkelBlock } from '@suveren/approval-card/components/LoadGate';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';
import { DashboardSkeleton } from '../../pages/DashboardPage';
import { SettingsSkeleton, SETTINGS_SUBTITLE } from '../../pages/SettingsServicesPage';

/**
 * DEC-100 (Andreas, 2026-11-22): no turning mark while loading. Every wait between two pages shows the next page
 * greyed out: after the touch or the password the dashboard, after turning Touch ID on for approvals Settings. The
 * frame (top bar, sidebar, column, page title) sits where the real one will, so the page fills in without moving.
 * Nothing here reads data: the person is not signed in yet while it shows.
 */
export function ShellSkeleton({ page }: { page: 'dashboard' | 'settings' }) {
  return (
    <div data-testid={`shell-skeleton-${page}`}>
      <TopNav />
      <UpdateBanner />
      <SidebarSkeleton />
      <div className="main-content">
        <div className="page-inner">
          {page === 'dashboard' ? (
            <div className="dash-page">
              <div className="page-header"><h1 className="page-title">Dashboard</h1></div>
              <div className="load-gate"><DashboardSkeleton /></div>
            </div>
          ) : (
            <div className="su-page">
              <div className="page-header">
                <h1 className="page-title">Settings</h1>
                <p className="page-subtitle">{SETTINGS_SUBTITLE}</p>
              </div>
              <div className="load-gate"><SettingsSkeleton /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The sidebar's rows greyed out: which rows a person has (team, devices) is only known once they are signed in. */
function SidebarSkeleton() {
  const row = (w: string, key: string) => (
    <li key={key}>
      <span className="sidebar-item" aria-hidden="true">
        <span className="icon"><SkelBlock w="1.125rem" h="1.125rem" radius="0.25rem" /></span>
        <SkelLine w={w} />
      </span>
    </li>
  );
  return (
    <div className="sidebar">
      <SkelArea>
        <div className="sidebar-top"><ul className="sidebar-nav">{row('60%', 't')}</ul></div>
        <div className="sidebar-core"><ul className="sidebar-nav">{['55%', '50%', '45%', '50%', '45%'].map((w, i) => row(w, `c${i}`))}</ul></div>
        <div className="sidebar-setup">
          <div className="sidebar-divider" />
          <ul className="sidebar-nav">{['45%', '55%', '55%', '45%'].map((w, i) => row(w, `s${i}`))}</ul>
        </div>
      </SkelArea>
    </div>
  );
}
