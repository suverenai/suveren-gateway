import { SkelArea, SkelLine, SkelBlock } from '@suveren/approval-card/components/LoadGate';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';
import { SimulationBanner } from '../SimulationBanner';
import { DashboardSkeleton } from '../../pages/DashboardPage';
import { SettingsSkeleton } from '../../pages/SettingsServicesPage';

/**
 * DEC-100 (maintainer, 2026-11-22): no turning mark while loading. Every wait between two pages shows the next page
 * greyed out: after the touch or the password the dashboard, after turning Touch ID on for approvals Settings. The
 * frame (top bar, sidebar, column, page title) sits where the real one will, so the page fills in without moving.
 * Nothing here reads data: the person is not signed in yet while it shows. The page title is greyed out too: a real
 * `.page-title` means a signed-in page (the e2e journeys and the app wait for it), and nobody is signed in yet.
 */
export function ShellSkeleton({ page }: { page: 'dashboard' | 'settings' }) {
  return (
    <div data-testid={`shell-skeleton-${page}`}>
      <TopNav />
      <UpdateBanner />
      {/* As in the real frame (AppShell): in simulation mode the banner is there from the first frame. */}
      <SimulationBanner />
      <SidebarSkeleton />
      <div className="main-content">
        <div className="page-inner">
          {page === 'dashboard' ? (
            <div className="dash-page">
              <div className="page-header"><PageTitleSkeleton /></div>
              <div className="load-gate"><DashboardSkeleton /></div>
            </div>
          ) : (
            <div className="su-page">
              <div className="page-header"><PageTitleSkeleton subtitle /></div>
              <div className="load-gate"><SettingsSkeleton /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A page title (and subtitle) greyed out, as tall as the real ones. */
function PageTitleSkeleton({ subtitle }: { subtitle?: boolean }) {
  return (
    <div className="page-header-text" aria-hidden="true">
      <SkelLine w="9rem" h="1.8rem" style={{ marginBottom: '0.25rem' }} />
      {subtitle && <SkelLine w="70%" h="0.9rem" style={{ marginTop: '0.4rem' }} />}
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
