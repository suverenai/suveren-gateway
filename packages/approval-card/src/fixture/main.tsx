/**
 * Bare page that renders the approval card with no gateway behind it:
 * no router, no control plane, no event stream. For the WebKit and Chromium
 * check of the shared card (device-keys plan, step 9). Decisions are not sent
 * anywhere; `decide` only answers locally.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../apps/ui/src/styles/tokens.css';
import '../../../../apps/ui/src/styles/design-system.css';
import { ApprovalCard } from '../components/ApprovalCard';
import { configureFixtureHost } from './fixture-host';
import { FIXTURE_PLAIN_PROPOSAL, FIXTURE_SEALED_PROPOSAL } from './fixture-proposal';

configureFixtureHost();

const decide = async () => ({});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 16, display: 'grid', gap: 24 }}>
      <section data-testid="fixture-plain">
        <ApprovalCard proposal={FIXTURE_PLAIN_PROPOSAL} currentUserId="fixture-owner" decide={decide} />
      </section>
      <section data-testid="fixture-sealed">
        <ApprovalCard proposal={FIXTURE_SEALED_PROPOSAL} currentUserId="fixture-owner" decide={decide} />
      </section>
    </main>
  </StrictMode>,
);
