import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { TopNav } from '../components/TopNav';
import { DifferentAccountError, type DifferentAccountSummary } from '../lib/sp-client';

export function LoginPage() {
  const [apiKey, setApiKey] = useState('');
  const { login, isLoading, error, clearError } = useAuth();
  const navigate = useNavigate();
  const [wipeWarning, setWipeWarning] = useState<DifferentAccountSummary | null>(null);

  const handleLogin = async () => {
    if (!apiKey.trim()) return;
    clearError();
    try {
      await login(apiKey);
      navigate('/');
    } catch (e) {
      if (e instanceof DifferentAccountError) {
        setWipeWarning(e.summary);
        return;
      }
      // Other errors are surfaced via context.error
    }
  };

  const handleConfirmWipe = async () => {
    setWipeWarning(null);
    clearError();
    try {
      await login(apiKey, { confirmWipe: true });
      navigate('/');
    } catch {
      // error surfaced via context
    }
  };

  const handleCancelWipe = () => {
    setWipeWarning(null);
  };

  return (
    <>
      <TopNav />
      <div className="login-split">
        {/* LEFT: Protocol summary */}
        <div className="login-split-left">
          <div style={{ maxWidth: '28rem' }}>
            <h1 style={{ fontSize: 'clamp(2.25rem, 4vw, 3.25rem)', letterSpacing: '-0.03em', lineHeight: 1.1, marginBottom: '1.25rem' }}>
              Your agents, your intent, your rules.
            </h1>
            <p style={{ fontSize: '1.125rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '3rem' }}>
              The gateway runs on your machine, between your agents and the tools they use. Your signature. Your bounds. Your receipts.
            </p>
          </div>
        </div>

        {/* RIGHT: Login form */}
        <div className="login-split-right">
          <div style={{ width: '100%', maxWidth: '24rem' }}>
            <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>Sign In</div>
              <div style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Enter your API key to manage authorizations.
              </div>
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
              <label className="form-label">API Key</label>
              <input
                className="form-input"
                type="password"
                placeholder="hap_sk_..."
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                disabled={isLoading}
                style={{ padding: '0.75rem' }}
              />
              <div className="form-hint">From your Suveren account.</div>
            </div>

            <button
              className="btn btn-primary btn-full btn-lg"
              onClick={handleLogin}
              disabled={isLoading}
              style={{ marginBottom: '2rem' }}
            >
              {isLoading ? 'Signing in...' : 'Sign In'}
            </button>

            <div className="login-divider">New here?</div>

            <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
                Create an account on Suveren.ai,<br />then come back to sign in.
              </p>
              <a
                href="https://suveren.ai/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary btn-full"
                style={{ textDecoration: 'none' }}
              >
                Create Account
              </a>
            </div>

            <div style={{ paddingTop: '1.75rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: '0.875rem' }}>
                Getting started
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                {[
                  <>Create an account at <a href="https://suveren.ai/get-started" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Suveren.ai</a></>,
                  'Join or create a team to get domain authority',
                  'Sign in here with your API key to start authorizing agents',
                ].map((text, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.625rem', alignItems: 'baseline', marginBottom: i < 2 ? '0.5rem' : 0 }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '0.95rem' }}>{i + 1}.</span>
                    {text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {wipeWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wipe-warning-title"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
          onClick={handleCancelWipe}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 520, width: '100%', margin: 0 }}
          >
            <h3 id="wipe-warning-title" className="card-title" style={{ marginBottom: '0.5rem' }}>
              Sign in with a different account?
            </h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              This gateway already holds data for another account. Signing in
              with this API key will <strong>permanently wipe</strong> the
              following local data:
            </p>
            <ul style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', paddingLeft: '1.25rem', lineHeight: 1.6 }}>
              <li>
                {wipeWarning.credentialCount} stored service credential{wipeWarning.credentialCount === 1 ? '' : 's'}
                {wipeWarning.credentialIds.length > 0 && (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '0.825rem' }}>
                    {' '}({wipeWarning.credentialIds.slice(0, 5).join(', ')}{wipeWarning.credentialIds.length > 5 ? `, +${wipeWarning.credentialIds.length - 5} more` : ''})
                  </span>
                )}
              </li>
              <li>{wipeWarning.serviceCount} configured integration{wipeWarning.serviceCount === 1 ? '' : 's'}</li>
              <li>The local E2EE keypair (a new one will be generated for this account)</li>
              <li>Any unsynchronised gate content stored locally</li>
            </ul>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Authorizations and receipts on the Service Provider are NOT affected
              — only this gateway's local state is wiped.
            </p>
            <p style={{ fontSize: '0.825rem', color: 'var(--text-tertiary)', marginBottom: '1rem' }}>
              If this isn't what you wanted, cancel and sign back in with the
              original API key, or use a different gateway instance for this account.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-ghost"
                onClick={handleCancelWipe}
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                className="btn btn-secondary"
                style={{ color: 'var(--danger, #e53e3e)' }}
                onClick={handleConfirmWipe}
                disabled={isLoading}
              >
                {isLoading ? 'Signing in...' : 'Wipe local data and sign in'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
