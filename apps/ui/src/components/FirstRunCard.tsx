import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { deriveFirstRunCard, type FirstRunCardInput } from '../lib/first-run-card';
import { relativeTime } from './RecentBlocks';
import { McpConnectDetails } from './McpConnectDetails';
import type { AgentContact } from '../lib/sp-client';

interface FirstRunCardProps {
  contact: AgentContact | null;
  hasDelegationMandate: boolean;
  otherMandateCount: number;
  delegationProposalCount: number;
  managed: boolean;
  simulationOn: boolean;
  mcpEndpoint: string;
}

// `?new=1` opens the "New mandate" picker; `profile=delegation` (matched by
// short id — see lib/picker-entries.ts's findPreselectedEntry) skips straight
// to Scope & Limits instead of making the person find Delegation in the grid.
const DELEGATION_MANDATE_HREF = '/mandates?new=1&profile=delegation';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [text]);
  return (
    <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A step's title: plain text when open, a button that opens it when muted. */
function StepTitle({ todo, onOpen, children }: { todo: boolean; onOpen: () => void; children: React.ReactNode }) {
  if (!todo) return <span className="flow-step-title">{children}</span>;
  return (
    <button type="button" className="flow-step-title flow-todo-title flow-step-open-btn" onClick={onOpen}>
      {children}
    </button>
  );
}

/**
 * Dashboard first-run card — one card, three backend-truth steps:
 * connect your AI, give the Delegation mandate, ask your AI to start. Shown
 * while the person has no mandate besides (maybe) Delegation and hasn't
 * finished all three; see lib/first-run-card.ts for the (pure, unit-tested)
 * visibility and step-state logic this only renders.
 */
export function FirstRunCard({
  contact,
  hasDelegationMandate,
  otherMandateCount,
  delegationProposalCount,
  managed,
  simulationOn,
  mcpEndpoint,
}: FirstRunCardProps) {
  const input: FirstRunCardInput = {
    hasContact: contact !== null,
    hasDelegationMandate,
    otherMandateCount,
    delegationProposalCount,
    managed,
    simulationOn,
  };
  // A muted step line is a button: the person can open any step that isn't
  // done — e.g. give the Delegation mandate before connecting their AI.
  const [chosen, setChosen] = useState<number | null>(null);
  const state = deriveFirstRunCard(input, chosen);
  if (!state.visible) return null;

  const connectSnippet = `Please connect to the Suveren gateway: MCP server at ${mcpEndpoint}/mcp`;

  return (
    <div className="card setup-card">
      <h2 className="card-title">Get started</h2>
      <p className="setup-intro">
        You decide what your AI can do — it acts only within that. Every action that
        changes something gets a signed ticket.
      </p>

      {/* Step 1 — Connect your AI */}
      <div className="flow-step">
        <div className="flow-step-head">
          <span className={`flow-step-marker flow-${state.step1.status === 'open' ? 'open' : state.step1.status === 'done' ? 'done' : 'todo'}`}>
            {state.step1.status === 'done' ? '✓' : '1'}
          </span>
          {state.step1.status === 'done' && contact ? (
            <span className="flow-step-title flow-done-title">
              {contact.clientName} connected &middot; last contact {relativeTime(Date.parse(contact.lastSeenAt), Date.now()).toLowerCase()}
            </span>
          ) : (
            <StepTitle todo={state.step1.status === 'todo'} onOpen={() => setChosen(0)}>
              Connect your AI
            </StepTitle>
          )}
        </div>

        {state.step1.status === 'open' && (
          <div className="flow-step-body">
            {state.step1.variant === 'managed' ? (
              <>
                <p>Your IT sets up the connection. Open your AI — if Suveren isn't there, contact your IT.</p>
                <details className="int-details">
                  <summary>For your IT</summary>
                  <div style={{ marginTop: '0.75rem' }}>
                    <McpConnectDetails mcpEndpoint={mcpEndpoint} />
                  </div>
                </details>
              </>
            ) : (
              <>
                <p>Ask your AI to connect to Suveren. Copy this into it:</p>
                <div className="gate-content-block" style={{ marginBottom: '0.75rem' }}>
                  <div className="quote-box">
                    <span className="quote-text">{connectSnippet}</span>
                    <CopyButton text={connectSnippet} />
                  </div>
                </div>
                <p className="cta-helper" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                  If your AI can't add it itself, it will tell you how. In ChatGPT, use a local session.
                </p>
                <details className="int-details">
                  <summary>Set it up by hand</summary>
                  <div style={{ marginTop: '0.75rem' }}>
                    <McpConnectDetails mcpEndpoint={mcpEndpoint} />
                  </div>
                </details>
              </>
            )}
          </div>
        )}
      </div>

      {/* Step 2 — Give the Delegation mandate */}
      <div className="flow-step">
        <div className="flow-step-head">
          <span className={`flow-step-marker flow-${state.step2.status === 'open' ? 'open' : state.step2.status === 'done' ? 'done' : 'todo'}`}>
            {state.step2.status === 'done' ? '✓' : '2'}
          </span>
          {state.step2.status === 'done' ? (
            <span className="flow-step-title flow-done-title">
              Delegation mandate given &middot; <Link to="/mandates">review or revoke under Mandates</Link>
            </span>
          ) : (
            <StepTitle todo={state.step2.status === 'todo'} onOpen={() => setChosen(1)}>
              Give the Delegation mandate
            </StepTitle>
          )}
        </div>

        {state.step2.status === 'open' && (
          <div className="flow-step-body">
            <p>
              Delegation lets your AI propose the rest of its own setup — new mandates
              and its working instructions. It can only propose; nothing changes until
              you approve it.
            </p>
            <ul className="bound-list">
              <li>Read the setup guides</li>
              <li>Propose new mandates — each waits for your approval</li>
              <li>Propose an updated agent brief — also waits for your approval</li>
            </ul>

            {state.step2.simulationOn ? (
              <>
                <Link to={DELEGATION_MANDATE_HREF} className="btn btn-primary">
                  Give the Delegation mandate &#8594;
                </Link>
                <p className="cta-helper">You set the daily limit in the next step.</p>
                {state.step2.variant === 'managed' && (
                  <p className="managed-note">
                    In a company team you may need approver rights — ask your IT if the button is refused.
                  </p>
                )}
              </>
            ) : (
              <p className="managed-note" style={{ marginTop: 0 }}>
                {state.step2.variant === 'managed'
                  ? 'Delegation works in simulation mode only. Ask your IT to turn on simulation mode.'
                  : <>Delegation works in simulation mode only. Turn it on with <code>suveren-gateway simulation on</code> and restart.</>}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Step 3 — Ask your AI to start */}
      <div className="flow-step">
        <div className="flow-step-head">
          <span className={`flow-step-marker flow-${state.step3.status === 'open' ? 'open' : 'todo'}`}>
            3
          </span>
          <StepTitle todo={state.step3.status === 'todo'} onOpen={() => setChosen(2)}>
            Ask your AI: &ldquo;How do I start with Suveren?&rdquo;
          </StepTitle>
        </div>

        {state.step3.status === 'open' && (
          <div className="flow-step-body">
            <div className="gate-content-block" style={{ marginBottom: '0.875rem' }}>
              <div className="quote-box">
                <span className="quote-text">&ldquo;How do I start with Suveren?&rdquo;</span>
                <CopyButton text="How do I start with Suveren?" />
              </div>
            </div>
            <p>
              It will interview you, suggest test data, and propose mandates and a brief.
              Approve its proposals under <Link to="/approvals">Approvals</Link>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
