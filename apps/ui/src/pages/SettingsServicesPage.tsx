import { useState, useEffect, useCallback } from 'react';
import { spClient } from '../lib/sp-client';

const PROVIDER_CONFIG: Record<string, { provider: string; endpoint: string; models: string[] }> = {
  ollama: {
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    models: ['gemma4:e4b', 'gemma4:e2b', 'gemma4:26b', 'gemma4:31b', 'llama3.2', 'llama3.1', 'mistral', 'qwen2.5'],
  },
  openrouter: {
    provider: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1',
    models: ['google/gemma-4-31b-it', 'qwen/qwen3.6-plus:free', 'stepfun/step-3.5-flash:free', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'anthropic/claude-haiku-4'],
  },
  openai: {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  },
  groq: {
    provider: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'gemma2-9b-it'],
  },
  together: {
    provider: 'openai-compatible',
    endpoint: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3-8b-chat-hf', 'meta-llama/Llama-3-70b-chat-hf'],
  },
};

export function SettingsServicesPage() {
  const [successMsg, setSuccessMsg] = useState('');

  // AI config state
  const [aiPreset, setAiPreset] = useState('openrouter');
  const [aiProvider, setAiProvider] = useState('openai-compatible');
  const [aiEndpoint, setAiEndpoint] = useState('https://openrouter.ai/api/v1');
  const [aiModel, setAiModel] = useState('google/gemma-4-31b-it');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<string | null>(null);

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const aiStatus = await spClient.getCredential('ai-config');
      setAiConfigured(aiStatus.configured);
      if (aiStatus.configured && aiStatus.fields) {
        if (aiStatus.fields.provider) setAiProvider(aiStatus.fields.provider);
        if (aiStatus.fields.endpoint) setAiEndpoint(aiStatus.fields.endpoint);
        if (aiStatus.fields.model) setAiModel(aiStatus.fields.model);
        const ep = aiStatus.fields.endpoint ?? '';
        if (ep.includes('openai.com')) setAiPreset('openai');
        else if (ep.includes('groq.com')) setAiPreset('groq');
        else if (ep.includes('together.xyz')) setAiPreset('together');
        else if (ep.includes('openrouter.ai')) setAiPreset('openrouter');
        else setAiPreset('ollama');
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleAiPresetChange = (preset: string) => {
    setAiPreset(preset);
    const cfg = PROVIDER_CONFIG[preset];
    if (cfg) {
      setAiProvider(cfg.provider);
      setAiEndpoint(cfg.endpoint);
      setAiModel(cfg.models[0]);
    }
  };

  const saveAiConfig = async () => {
    setAiSaving(true);
    try {
      await spClient.setCredential('ai-config', {
        provider: aiProvider,
        endpoint: aiEndpoint,
        model: aiModel,
        ...(aiApiKey ? { apiKey: aiApiKey } : {}),
      });
      setAiConfigured(true);
      showSuccess('AI configuration saved!');
    } catch {
      showSuccess('Failed to save AI config');
    } finally {
      setAiSaving(false);
    }
  };

  const testAi = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const result = await spClient.aiTest(aiApiKey ? {
        provider: aiProvider,
        endpoint: aiEndpoint,
        model: aiModel,
        apiKey: aiApiKey,
      } : {});
      setAiTestResult(result.ok ? `OK: ${result.message}` : `Failed: ${result.message}`);
    } catch (e) {
      setAiTestResult(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setAiTesting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">AI Assistant</h1>
        <p className="page-subtitle">Advisory AI to help you think through intent when authorizing agents.</p>
      </div>

      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* AI Assistant card */}
      <div className="card">
        <h3 className="card-title">Configuration</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Connect a trusted AI model that has access to your intent — problem, objective, and tradeoffs — to help you think through authorizations. Keys are encrypted in your vault.
        </p>

        {aiConfigured && (
          <div className="status-banner status-banner-success" style={{ marginBottom: '1rem', fontSize: '0.8rem' }}>
            <span className="status-banner-icon">{'\u2713'}</span>
            <span className="status-banner-text">AI configured</span>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label className="form-label">Provider Preset</label>
          <select
            className="form-input"
            value={aiPreset}
            onChange={e => handleAiPresetChange(e.target.value)}
          >
            <option value="openrouter">OpenRouter (recommended)</option>
            <option value="ollama">Ollama (local)</option>
            <option value="openai">OpenAI</option>
            <option value="groq">Groq</option>
            <option value="together">Together</option>
          </select>
        </div>

        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label className="form-label">Model</label>
          {(() => {
            const models = PROVIDER_CONFIG[aiPreset]?.models ?? [];
            const isKnown = models.includes(aiModel);
            return (
              <>
                <select
                  className="form-input"
                  value={isKnown ? aiModel : '__custom__'}
                  onChange={e => {
                    if (e.target.value === '__custom__') {
                      setAiModel('');
                    } else {
                      setAiModel(e.target.value);
                    }
                  }}
                  style={{ marginBottom: !isKnown ? '0.375rem' : undefined }}
                >
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  <option value="__custom__">Custom model...</option>
                </select>
                {!isKnown && (
                  <input
                    className="form-input"
                    value={aiModel}
                    onChange={e => setAiModel(e.target.value)}
                    placeholder="Enter model name"
                  />
                )}
              </>
            );
          })()}
        </div>

        <div className="form-group" style={{ marginBottom: '1rem' }}>
          <label className="form-label">API Key (if required)</label>
          <input
            className="form-input"
            type="password"
            value={aiApiKey}
            onChange={e => setAiApiKey(e.target.value)}
            placeholder={aiConfigured ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : 'sk-... (not needed for Ollama)'}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={saveAiConfig} disabled={aiSaving}>
            {aiSaving ? 'Saving...' : 'Save & Encrypt'}
          </button>
          {aiConfigured && (
            <button className="btn btn-ghost" onClick={testAi} disabled={aiTesting}>
              {aiTesting ? 'Testing...' : 'Test Connection'}
            </button>
          )}
        </div>

        {aiTestResult && (
          <div className={`alert ${aiTestResult.startsWith('OK') ? 'alert-success' : 'alert-error'}`} style={{ marginTop: '0.75rem' }}>
            {aiTestResult}
          </div>
        )}
      </div>

      {/* Advanced — AI assistant prompts (collapsed by default) */}
      <AdvancedAIPrompts />

      {/* Security guidance */}
      <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>Security</h2>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.375rem' }}>What the gateway protects</div>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              <li>Every tool call verified against your authorization bounds</li>
              <li>Credentials never exposed to agents through MCP</li>
              <li>Every action produces a signed receipt</li>
            </ul>
          </div>

          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.375rem' }}>Your responsibility</div>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              <li>If your AI agent has full access to your computer, it could bypass the gateway</li>
              <li>For best security, run agents in sandboxed environments</li>
              <li>The gateway secures what agents do through tools — not what they do on your machine</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Advanced — AI assistant prompts (collapsible) ──────────────────────

type PromptKind = 'intent' | 'context';

interface PromptState {
  current: string;
  default: string;
  overridden: boolean;
}

function AdvancedAIPrompts() {
  const [data, setData] = useState<Record<PromptKind, PromptState> | null>(null);
  const [drafts, setDrafts] = useState<Record<PromptKind, string>>({ intent: '', context: '' });
  const [saving, setSaving] = useState<PromptKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedKind, setSavedKind] = useState<PromptKind | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Lazy-load the prompts the first time the user opens the card.
  const loadIfNeeded = useCallback(async () => {
    if (loaded) return;
    try {
      const resp = await spClient.getAIPrompts();
      setData(resp);
      setDrafts({ intent: resp.intent.current, context: resp.context.current });
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prompts');
    }
  }, [loaded]);

  const onSave = async (kind: PromptKind) => {
    if (!data) return;
    setSaving(kind);
    setError(null);
    try {
      const value = drafts[kind];
      // If the user saved exactly the default text, treat as revert.
      const toStore = value.trim() === data[kind].default.trim() ? '' : value;
      await spClient.setAIPrompt(kind, toStore);
      const refreshed = await spClient.getAIPrompts();
      setData(refreshed);
      setDrafts({ intent: refreshed.intent.current, context: refreshed.context.current });
      setSavedKind(kind);
      setTimeout(() => setSavedKind(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  };

  const onRevert = async (kind: PromptKind) => {
    if (!confirm(`Revert ${kind} prompt to the built-in default?`)) return;
    setSaving(kind);
    setError(null);
    try {
      await spClient.setAIPrompt(kind, '');
      const refreshed = await spClient.getAIPrompts();
      setData(refreshed);
      setDrafts({ intent: refreshed.intent.current, context: refreshed.context.current });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <details
      className="card"
      style={{ padding: '1.5rem', marginTop: '1rem' }}
      onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) loadIfNeeded(); }}
    >
      <summary
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          cursor: 'pointer',
          listStyle: 'revert',
          userSelect: 'none',
        }}
      >
        Advanced — AI assistant prompts
      </summary>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.75rem 0 1rem 0', lineHeight: 1.55 }}>
        These are the system prompts the AI assistant sees when helping you write
        Intent (per-authorization) or Context (your standing-orders brief).
        Edit with care — changes apply on the next chat turn.
      </p>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: '0.75rem' }}>{error}</div>
      )}

      {!loaded && !error && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading prompts…</p>
      )}

      {data && (
        <>
          <PromptEditor
            kind="intent"
            label="Intent — per-authorization"
            description="Used on the Intent gate when creating a new authorization."
            state={data.intent}
            draft={drafts.intent}
            onChange={(v) => setDrafts((d) => ({ ...d, intent: v }))}
            onSave={() => onSave('intent')}
            onRevert={() => onRevert('intent')}
            saving={saving === 'intent'}
            justSaved={savedKind === 'intent'}
          />

          <PromptEditor
            kind="context"
            label="Context — standing-orders brief"
            description="Used on the Brief page when refining your context.md."
            state={data.context}
            draft={drafts.context}
            onChange={(v) => setDrafts((d) => ({ ...d, context: v }))}
            onSave={() => onSave('context')}
            onRevert={() => onRevert('context')}
            saving={saving === 'context'}
            justSaved={savedKind === 'context'}
          />
        </>
      )}
    </details>
  );
}

function PromptEditor({
  kind,
  label,
  description,
  state,
  draft,
  onChange,
  onSave,
  onRevert,
  saving,
  justSaved,
}: {
  kind: PromptKind;
  label: string;
  description: string;
  state: PromptState;
  draft: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onRevert: () => void;
  saving: boolean;
  justSaved: boolean;
}) {
  const dirty = draft !== state.current;
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.25rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{label}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{description}</div>
        </div>
        {state.overridden && (
          <span style={{ fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Custom
          </span>
        )}
      </div>

      <textarea
        className="form-textarea"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: "'SF Mono', Monaco, 'Cascadia Code', monospace",
          fontSize: '0.82rem',
          lineHeight: 1.55,
          resize: 'vertical',
          minHeight: '14rem',
          marginTop: '0.5rem',
        }}
        aria-label={`${label} system prompt`}
      />

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state.overridden && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRevert}
            disabled={saving}
            title="Discard the override and use the built-in default"
          >
            Revert to default
          </button>
        )}
        {justSaved && (
          <span style={{ fontSize: '0.78rem', color: 'var(--success)' }}>Saved</span>
        )}
        {dirty && !saving && !justSaved && (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>
        )}
      </div>

      <details style={{ marginTop: '0.5rem' }}>
        <summary style={{ fontSize: '0.78rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
          Show built-in default
        </summary>
        <pre style={{
          marginTop: '0.5rem',
          padding: '0.75rem 1rem',
          background: 'var(--bg-main)',
          border: '1px solid var(--border)',
          borderRadius: '0.5rem',
          fontSize: '0.78rem',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          maxHeight: '20rem',
          overflowY: 'auto',
        }}>{state.default}</pre>
      </details>
      <span style={{ display: 'none' }}>{kind}</span>
    </section>
  );
}
