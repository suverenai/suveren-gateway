import { useState, useEffect } from 'react';
import { spClient } from '../lib/sp-client';
import { AssistantChatPanel } from '../components/AssistantChatPanel';
import { BottomSheet } from '../components/BottomSheet';

// Plain-spoken default brief for first-time users. Covers what Suveren is,
// how to behave under bounded authority, when to pull intent details on
// demand, and a few example standing-orders. Intentionally generic — the
// user tailors it for their actual workflow.
const STARTER_TEMPLATE = `# Agent Brief

You act on my behalf through Suveren — the gateway that gates every
privileged tool call you make. Suveren implements the bounded-authority
model from the open Human Agency Protocol (HAP): each authorization
describes an area of authority, a set of numeric limits, and a scope.
Operate inside those bounds or the Gatekeeper will reject your action.

## Before you act in a domain

1. Call \`list-authorizations(domain: "<domain>")\` to load the full
   intent, scope, and usage for that area. The session brief shows only
   a one-line summary per authority — the Intent paragraph lives behind
   that call, and often contains soft rules you MUST honor (e.g. "never
   publish on weekends", "only reply in English").
2. If the action would exceed a bound or fall outside the scope, stop
   and explain what would be blocked instead of trying.
3. If you're not sure whether an action is covered, ask me first.

## How to handle reviews

Authorizations in review mode require my approval before the action
executes. When you propose an action:
- Include everything I need to judge it (title, recipients, amounts,
  dates, attendees) in the tool arguments.
- Don't batch unrelated proposals — one proposal per decision.

## Standing orders

(Add your own here. Examples:)

- Every morning, summarize today's calendar and flag conflicts.
- On Fridays, give me a weekly review: what's done, what slipped, what's
  next.
- Never email anyone outside the company without asking first.
- When drafting posts, prefer plain language over marketing copy.
`;

export function AgentBriefPage() {
  const [context, setContext] = useState<string>('');
  const [originalContext, setOriginalContext] = useState<string>('');
  const [loadingContext, setLoadingContext] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [chatOpenMobile, setChatOpenMobile] = useState(false);

  const dirty = context !== originalContext;
  const byteLength = new Blob([context]).size;
  const MAX_BYTES = 16 * 1024;

  // Guard against navigating away with unsaved edits.
  //
  // Two listeners cover the two exit paths:
  //   1. beforeunload — tab close, refresh, external URL, hard back/forward.
  //      Fires the browser's native "Leave site?" dialog.
  //   2. Document click capture — intercepts any same-origin <a> / <Link>
  //      click (sidebar, mobile menu, in-page links) BEFORE react-router
  //      processes it. If the user cancels, preventDefault stops the nav.
  //
  // We do NOT use useBlocker here — it requires the data-router
  // (createBrowserRouter) setup, and this app uses the classic
  // <BrowserRouter>/<Routes> JSX form. Intercepting clicks works with either.
  //
  // Programmatic navigate() calls within this page would bypass both guards,
  // but this page doesn't navigate itself, so that gap is fine.
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      // Modifier-clicks (new tab / window) and non-left-clicks aren't route
      // changes from our perspective — let the browser handle them.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor || !anchor.href) return;
      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return; // same-page anchors
      if (!confirm('You have unsaved changes to your agent brief. Leave anyway?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  // Initial load of context.md + preview.
  useEffect(() => {
    let cancelled = false;
    spClient.getAgentContext()
      .then(c => {
        if (cancelled) return;
        setContext(c);
        setOriginalContext(c);
      })
      .catch(err => {
        if (cancelled) return;
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load context' });
      })
      .finally(() => { if (!cancelled) setLoadingContext(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await spClient.saveAgentContext(context);
      setOriginalContext(context);
      setMessage({ kind: 'ok', text: 'Saved. New MCP sessions will pick this up on next connect.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    setContext(originalContext);
    setMessage(null);
  };

  const handleStarter = () => {
    if (context.trim() && !confirm('Replace current context with the starter template?')) return;
    setContext(STARTER_TEMPLATE);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Agent Brief</h1>
        <p className="page-subtitle">
          Standing orders for agents that connect via MCP. This text
          prepends every new session — keep it tight.
        </p>
        {!context.trim() && !loadingContext && (
          <button
            className="btn btn-primary btn-sm"
            onClick={handleStarter}
            disabled={saving}
            title="Insert a starter brief covering Suveren basics and example standing orders"
            style={{ marginTop: '0.5rem' }}
          >
            Insert starter template
          </button>
        )}
      </div>

      {message && (
        <div
          className={message.kind === 'ok' ? 'alert alert-success' : 'error-message'}
          style={{ marginBottom: '1rem' }}
        >
          {message.text}
        </div>
      )}

      <div className="intent-layout" style={{ marginBottom: '1rem' }}>
        {/* LEFT — AI chat (hidden on ≤768px; reachable via floating button) */}
        <div className="card intent-pane chat">
          <AssistantChatPanel
            target={{ kind: 'context' }}
            currentText={context}
            onApply={(text) => {
              if (context.trim() && !confirm('Replace the current context with the applied draft?')) return;
              setContext(text);
            }}
            greeting="Tell me what your agent should know — I'll help shape your standing orders. Or ask me to draft a full brief and we'll iterate."
            placeholder="Ask for help with your brief…"
          />
        </div>

        {/* RIGHT — context.md document, the centerpiece */}
        <div className="card intent-pane document">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <h3 className="card-title" style={{ marginBottom: 0 }}>context.md</h3>
            <span style={{ fontSize: '0.75rem', color: byteLength > MAX_BYTES ? 'var(--danger)' : 'var(--text-muted)' }}>
              {byteLength.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
            </span>
          </div>

          <textarea
            className="form-textarea"
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder={loadingContext ? 'Loading…' : 'Type your standing orders here, or click "Insert starter template" below.'}
            disabled={loadingContext}
            rows={18}
            style={{ fontFamily: "'SF Mono', Monaco, monospace", fontSize: '0.85rem', lineHeight: 1.5, minHeight: '22rem' }}
          />

          <div className="intent-footer" style={{ marginTop: '0.75rem' }}>
            <button
              className="btn btn-ghost"
              onClick={handleRevert}
              disabled={saving || !dirty}
            >
              Revert
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleSave}
              disabled={saving || !dirty || byteLength > MAX_BYTES || loadingContext}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* Mobile floating help + bottom-sheet drawer */}
        <button
          type="button"
          className="floating-help"
          onClick={() => setChatOpenMobile(true)}
          aria-label="Open brief assistant"
        >
          Get help with brief
        </button>

        <BottomSheet
          open={chatOpenMobile}
          onClose={() => setChatOpenMobile(false)}
          ariaLabel="Brief assistant"
        >
          <AssistantChatPanel
            target={{ kind: 'context' }}
            currentText={context}
            onApply={(text) => {
              if (context.trim() && !confirm('Replace the current context with the applied draft?')) return;
              setContext(text);
              setChatOpenMobile(false);
            }}
            greeting="Tell me what your agent should know — I'll help shape your standing orders."
            placeholder="Ask for help with your brief…"
          />
        </BottomSheet>
      </div>

    </>
  );
}
