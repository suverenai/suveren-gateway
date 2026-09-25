import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';

/** Forward a pre-v0.7 address to its new path, keeping the query string (e.g. ?highlight=, ?step=). */
function Forward({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { EventSourceProvider, useSSEEvent } from './contexts/EventSourceContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { DashboardPage } from './pages/DashboardPage';
import { GateWizardPage } from './pages/GateWizardPage';
import { AgentReviewPage } from './pages/AgentReviewPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { GroupsPage } from './pages/GroupsPage';
import { AuthorizationsPage } from './pages/AuthorizationsPage';
import { AuditPage } from './pages/AuditPage';
import { SettingsServicesPage } from './pages/SettingsServicesPage';
import { ProposalReviewPage } from './pages/ProposalReviewPage';
import { AgentBriefPage } from './pages/AgentBriefPage';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, mode, domain } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Personal mode: always has domain='owner', skip onboarding
  // Team mode: show onboarding if no domain set (no group joined yet)
  if (mode === 'team' && !domain) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, handleSessionLocked } = useAuth();

  // The gateway locked ITSELF (AS session ended: 30-day expiry, or revoked)
  // — return to the sign-in screen with a reason, exactly like the UI
  // already does for a plain logout, but without calling /auth/logout
  // (the session that call would use is the one that just ended).
  useSSEEvent('session-locked', (payload) => {
    const message = (payload as { message?: string } | null)?.message;
    handleSessionLocked(message);
  });

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/onboarding" element={user ? <OnboardingPage /> : <Navigate to="/login" replace />} />
      <Route element={
        <AuthGuard>
          <AppShell />
        </AuthGuard>
      }>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/mandates" element={<AuthorizationsPage />} />
        <Route path="/mandates/new/intent" element={<GateWizardPage />} />
        <Route path="/mandates/new/sign" element={<AgentReviewPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/team" element={<GroupsPage />} />
        <Route path="/tickets" element={<AuditPage />} />
        <Route path="/approvals" element={<ProposalReviewPage />} />
        {/* Pre-v0.7 addresses: bookmarks and links already sent keep working. */}
        <Route path="/agent/new" element={<Navigate to="/mandates?new=1" replace />} />
        <Route path="/agent/gate" element={<Forward to="/mandates/new/intent" />} />
        <Route path="/agent/review" element={<Forward to="/mandates/new/sign" />} />
        <Route path="/authorizations" element={<Forward to="/mandates" />} />
        <Route path="/groups" element={<Forward to="/team" />} />
        <Route path="/audit" element={<Forward to="/tickets" />} />
        <Route path="/proposals" element={<Forward to="/approvals" />} />
        <Route path="/agent-brief" element={<AgentBriefPage />} />
        <Route path="/settings" element={<SettingsServicesPage />} />
        {/* Redirect old routes */}
        <Route path="/settings/services" element={<Navigate to="/settings" replace />} />
        <Route path="/deploy" element={<Navigate to="/integrations" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <EventSourceProvider>
          <AppRoutes />
        </EventSourceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
