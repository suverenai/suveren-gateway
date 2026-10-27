import { useState, useEffect } from 'react';
import { spClient } from '../lib/sp-client';
import { AssistantChatPanel } from '../components/AssistantChatPanel';
import { BottomSheet } from '../components/BottomSheet';

// Plain-spoken default brief for first-time users. Covers what Suveren is,
// how to behave under bounded authority, when to pull intent details on
// demand, and a few example rules. Intentionally generic — the
// user tailors it for their actual workflow.
const STARTER_TEMPLATE = `# Agent Brief

You act on my behalf through Suveren — the gateway that gates every
privileged tool call you make. Suveren implements the bounded-authority
model from the open Human Agency Protocol (HAP): each mandate
describes an area of authority, a set of numeric limits, and a scope.
Operate inside those bounds or the Gatekeeper will reject your action.

## Before you act in a domain

1. Call \`list-authorizations(domain: "<domain>")\` to load the full
   intent, scope, and usage for that area. The session brief shows only
   a one-line summary per mandate — the Intent paragraph lives behind
   that call, and often contains soft rules you MUST honor (e.g. "never
   publish on weekends", "only reply in English").
2. If the action would exceed a bound or fall outside the scope, stop
   and explain what would be blocked instead of trying.
3. If you're not sure whether an action is covered, ask me first.

## How to handle reviews

Mandates in review mode require my approval before the action
executes. When you propose an action:
- Include everything I need to judge it (title, recipients, amounts,
  dates, attendees) in the tool arguments.
- Don't batch unrelated proposals — one proposal per decision.

## Your own rules

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
  // The brief helper only exists once an AI assistant is set up (Settings → AI Assistant);
  // until then it is a missing setup step (Get started, dashboard), not an empty panel.
  const [aiConfigured, setAiConfigured] = useState(false);
  useEffect(() => {
    spClient.getCredential('ai-config').then(c => setAiConfigured(c.configured)).catch(() => setAiConfigured(false));
  }, []);

  const dirty = context !== originalContext;
  const byteLength = new Blob([context]).size;
  const MAX_BYTES = 16 * 1024;
  const overLimit = byteLength > MAX_BYTES;

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
      // The quiet line under the editor turns to "Saved" — backend truth, no extra banner.
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
    <div className="su-page is-wide">
      <div className="page-header">
        <h1 className="page-title">Agent Brief</h1>
        <p className="page-subtitle">What every connected AI reads first, at the start of each session.</p>
      </div>

      {message && message.kind === 'error' && (
        <div className="error-message" style={{ marginBottom: '1rem' }}>
          {message.text}
        </div>
      )}

      <div className={`intent-layout su-duo${aiConfigured ? '' : ' no-chat'}`} style={{ marginBottom: '1rem' }}>
        {/* LEFT — AI helper (hidden on ≤768px; reachable via floating button) — only with an AI assistant set up */}
        {aiConfigured && <article className="ob-card su-card su-helper intent-pane chat">
          <AssistantChatPanel
            target={{ kind: 'context' }}
            currentText={context}
            onApply={(text) => {
              if (context.trim() && !confirm('Replace the current context with the applied draft?')) return;
              setContext(text);
            }}
            greeting="Tell me what your agent should know — I'll help you write the brief."
            placeholder="Ask for help with your brief…"
          />
        </article>}

        {/* RIGHT — the brief itself: the editor, one quiet line, Revert and Save */}
        <article className="ob-card su-card su-brief intent-pane document">
          <textarea
            className="su-editor"
            aria-label="Agent brief"
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder={loadingContext ? 'Loading…' : 'Write what every AI should know — or start from a template.'}
            disabled={loadingContext}
            rows={18}
          />

          <div className="su-editor-line">
            <span>{dirty ? 'Unsaved changes' : 'Saved'}</span>
            <span className={overLimit ? 'ob-bold' : undefined}>
              {byteLength.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes{overLimit ? ' — too long to save' : ''}
            </span>
          </div>

          {!context.trim() && !loadingContext && (
            <div className="ob-btns is-inline">
              <button
                className="ob-btn"
                onClick={handleStarter}
                disabled={saving}
                title="Insert a starter brief covering Suveren basics and example rules"
              >
                Insert starter template
              </button>
            </div>
          )}

          <div className="ob-btns">
            <button className="ob-btn" onClick={handleRevert} disabled={saving || !dirty}>
              Revert
            </button>
            <button
              className="ob-btn is-solid"
              style={{ flex: '3 1 10rem' }}
              onClick={handleSave}
              disabled={saving || !dirty || overLimit || loadingContext}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </article>

        {/* Mobile floating help + bottom-sheet drawer (only with an AI assistant) */}
        {aiConfigured && <>
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
            greeting="Tell me what your agent should know — I'll help you write the brief."
            placeholder="Ask for help with your brief…"
          />
        </BottomSheet>
        </>}
      </div>
    </div>
  );
}
