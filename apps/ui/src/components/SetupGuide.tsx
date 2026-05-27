import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';

interface SetupGuideProps {
  aiConfigured: boolean;
  hasRunningIntegration: boolean;
  hasActiveAuth: boolean;
  hasAgentConnected: boolean;
  mcpEndpoint: string;
}

type StepStatus = 'done' | 'skipped' | 'pending';

const LS_AI_SKIPPED = 'suveren-setup-ai-skipped';
const LS_AGENT_DONE = 'suveren-setup-agent-done';
const LS_DISMISSED = 'suveren-setup-dismissed';

// Legacy storage keys — migrated to `suveren-setup-*` on first read. Kept
// here so the migration helper has a single source of truth.
const LS_LEGACY_KEYS: Record<string, string> = {
  'hap-setup-ai-skipped': LS_AI_SKIPPED,
  'hap-setup-agent-done': LS_AGENT_DONE,
  'hap-setup-dismissed': LS_DISMISSED,
};
function migrateLegacyLS() {
  for (const [oldKey, newKey] of Object.entries(LS_LEGACY_KEYS)) {
    const v = localStorage.getItem(oldKey);
    if (v !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, v);
    }
    if (v !== null) localStorage.removeItem(oldKey);
  }
}
migrateLegacyLS();

const MCP_CONFIGS: Record<string, { label: string; snippet: (endpoint: string) => string }> = {
  'claude-code': {
    label: 'Claude Code',
    snippet: (ep) => JSON.stringify({
      mcpServers: {
        'suveren-gateway': { url: `${ep}/sse` },
      },
    }, null, 2),
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    snippet: (ep) => `Add to ~/Library/Application Support/Claude/claude_desktop_config.json:\n\n${JSON.stringify({
      mcpServers: {
        'suveren-gateway': { url: `${ep}/sse` },
      },
    }, null, 2)}`,
  },
  other: {
    label: 'Other',
    snippet: (ep) => `Streamable HTTP:  POST ${ep}/mcp\nSSE transport:    GET  ${ep}/sse\nHealth check:     GET  ${ep}/health`,
  },
};

export function SetupGuide({ aiConfigured, hasRunningIntegration, hasActiveAuth, hasAgentConnected, mcpEndpoint }: SetupGuideProps) {
  const [aiSkipped, setAiSkipped] = useState(() => localStorage.getItem(LS_AI_SKIPPED) === 'true');
  const [agentMarkedDone, setAgentMarkedDone] = useState(() => localStorage.getItem(LS_AGENT_DONE) === 'true');
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_DISMISSED) === 'true');
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [configTab, setConfigTab] = useState('claude-code');
  const [copied, setCopied] = useState(false);

  const steps: { label: string; detail?: string; to?: string; status: StepStatus; optional?: boolean }[] = [
    {
      label: 'AI Assistant',
      detail: 'A trusted AI helps you think through authorizations — surfacing risks and asking the right questions.',
      to: '/settings',
      status: aiConfigured ? 'done' : aiSkipped ? 'skipped' : 'pending',
      optional: true,
    },
    {
      label: 'Connect a service',
      to: '/integrations',
      status: hasRunningIntegration ? 'done' : 'pending',
    },
    {
      label: 'Authorize your agent',
      to: '/agent/new',
      status: hasActiveAuth ? 'done' : 'pending',
    },
    {
      label: 'Connect your agent',
      status: (hasAgentConnected || agentMarkedDone) ? 'done' : 'pending',
    },
  ];

  const completedCount = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const allComplete = completedCount === steps.length;

  const handleSkipAI = useCallback(() => {
    localStorage.setItem(LS_AI_SKIPPED, 'true');
    setAiSkipped(true);
  }, []);

  const handleAgentDone = useCallback(() => {
    localStorage.setItem(LS_AGENT_DONE, 'true');
    setAgentMarkedDone(true);
    setExpandedStep(null);
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(LS_DISMISSED, 'true');
    setDismissed(true);
  }, []);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  if (dismissed || allComplete) return null;

  const firstPendingIdx = steps.findIndex(s => s.status === 'pending');

  return (
    <div style={{
      border: '2px solid var(--accent)',
      borderRadius: '0.75rem',
      padding: '1.5rem',
      marginBottom: '1.5rem',
      background: 'var(--bg-elevated)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Get Started</h2>
        <button
          onClick={handleDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: '1.1rem',
            padding: '0 0.25rem',
            lineHeight: 1,
          }}
          title="Hide setup guide"
        >
          {'\u00D7'}
        </button>
      </div>

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {steps.map((step, i) => {
          const isHighlighted = i === firstPendingIdx;
          const indicator = step.status === 'done' ? '\u25CF'
            : step.status === 'skipped' ? '\u25CF'
            : '\u25CB';
          const indicatorColor = step.status === 'done' ? 'var(--success)'
            : step.status === 'skipped' ? 'var(--text-tertiary)'
            : isHighlighted ? 'var(--accent)' : 'var(--text-tertiary)';

          return (
            <div key={i}>
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: isHighlighted ? '0.75rem' : '0.25rem 0',
                borderRadius: isHighlighted ? '0.5rem' : undefined,
                background: isHighlighted ? 'var(--accent-subtle)' : undefined,
              }}>
                <span style={{ color: indicatorColor, fontSize: '0.75rem', marginTop: '0.2rem', flexShrink: 0 }}>
                  {indicator}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {step.to && step.status === 'pending' ? (
                      <Link to={step.to} style={{
                        fontSize: '0.9rem',
                        fontWeight: isHighlighted ? 600 : 500,
                        color: isHighlighted ? 'var(--accent)' : 'var(--text-primary)',
                        textDecoration: 'none',
                      }}>
                        {step.label}
                      </Link>
                    ) : step.status === 'pending' && i === 3 ? (
                      <button
                        onClick={() => setExpandedStep(expandedStep === 3 ? null : 3)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontSize: '0.9rem',
                          fontWeight: isHighlighted ? 600 : 500,
                          color: isHighlighted ? 'var(--accent)' : 'var(--text-primary)',
                        }}
                      >
                        {step.label}
                      </button>
                    ) : (
                      <span style={{
                        fontSize: '0.9rem',
                        fontWeight: 500,
                        color: step.status === 'done' ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                      }}>
                        {step.label}
                      </span>
                    )}
                    {step.optional && step.status === 'pending' && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>optional</span>
                    )}
                    {step.status === 'skipped' && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>skipped</span>
                    )}
                  </div>
                  {/* Detail text for step 1 when pending */}
                  {step.detail && step.status === 'pending' && isHighlighted && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem', lineHeight: 1.5 }}>
                      {step.detail}
                    </div>
                  )}
                </div>
                {/* Skip button for optional steps */}
                {step.optional && step.status === 'pending' && (
                  <button
                    onClick={handleSkipAI}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      padding: '0.125rem 0.5rem',
                      flexShrink: 0,
                    }}
                  >
                    Skip
                  </button>
                )}
                {/* Arrow for clickable steps */}
                {step.to && step.status === 'pending' && (
                  <Link to={step.to} style={{ color: 'var(--text-tertiary)', textDecoration: 'none', fontSize: '0.8rem', flexShrink: 0 }}>
                    {'\u203A'}
                  </Link>
                )}
              </div>

              {/* Step 4 inline expand: agent connection */}
              {i === 3 && expandedStep === 3 && (
                <div style={{
                  marginTop: '0.75rem',
                  marginLeft: '1.5rem',
                  padding: '1rem',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: '0.5rem',
                }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
                    MCP Endpoint
                  </div>
                  <div style={{
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    padding: '0.5rem 0.75rem',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: '0.375rem',
                    marginBottom: '1rem',
                    wordBreak: 'break-all',
                  }}>
                    {mcpEndpoint}
                  </div>

                  {/* Tabs */}
                  <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.75rem' }}>
                    {Object.entries(MCP_CONFIGS).map(([key, cfg]) => (
                      <button
                        key={key}
                        onClick={() => setConfigTab(key)}
                        style={{
                          padding: '0.375rem 0.75rem',
                          fontSize: '0.75rem',
                          fontWeight: configTab === key ? 600 : 400,
                          background: configTab === key ? 'var(--accent-subtle)' : 'transparent',
                          color: configTab === key ? 'var(--accent)' : 'var(--text-secondary)',
                          border: `1px solid ${configTab === key ? 'var(--accent)' : 'var(--border)'}`,
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                        }}
                      >
                        {cfg.label}
                      </button>
                    ))}
                  </div>

                  {/* Config snippet */}
                  <pre style={{
                    fontFamily: 'monospace',
                    fontSize: '0.78rem',
                    lineHeight: 1.6,
                    padding: '0.75rem',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: '0.375rem',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    marginBottom: '0.75rem',
                  }}>
                    {MCP_CONFIGS[configTab].snippet(mcpEndpoint)}
                  </pre>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleCopy(MCP_CONFIGS[configTab].snippet(mcpEndpoint))}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleAgentDone}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: '1.25rem' }}>
        <div style={{
          height: '4px',
          background: 'var(--border)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${(completedCount / steps.length) * 100}%`,
            background: 'var(--accent)',
            borderRadius: '2px',
            transition: 'width 0.3s ease',
          }} />
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.375rem' }}>
          {completedCount} of {steps.length} complete
        </div>
      </div>
    </div>
  );
}
