import { useState, useRef, useEffect } from 'react';
import { spClient } from '../lib/sp-client';

/** What the assistant is helping refine. `intent` carries authorization
 *  context (profile/path/bounds); `context` is the standing-orders
 *  brief flow. */
export type ChatTarget =
  | { kind: 'context' }
  | { kind: 'intent'; profileId?: string; path?: string; bounds?: string };

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  target: ChatTarget;
  /** Current draft sent to the AI on every turn so the model sees
   *  the latest text. */
  currentText: string;
  /** Called when the user clicks "Apply" on a fenced draft. Receives
   *  the extracted block. */
  onApply: (text: string) => void;
  /** Optional greeting message shown when the chat is empty. Defaults
   *  to the Intent gate's greeting; pass a different one when reusing
   *  this panel elsewhere (e.g. the brief page). */
  greeting?: string;
  /** Optional placeholder for the composer textarea. */
  placeholder?: string;
  /** Optional title for the panel. Defaults to "AI Assistant". */
  title?: string;
}

/** Extract the first ```markdown (or ```) fenced block from a reply.
 *  The system prompt instructs the AI to wrap full-document drafts
 *  this way so Apply can pull the draft cleanly. */
function extractDraft(text: string): string | null {
  const match = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  return match?.[1]?.trim() ?? null;
}

/** Strip a fenced block from the assistant body so the prose around it
 *  is readable without showing the same content twice. */
function stripFencedBlock(text: string): string {
  return text.replace(/```(?:markdown|md)?\s*\n[\s\S]*?```/, '').trim();
}

/**
 * ChatGPT-style assistant chat — used by the Intent gate (kind:
 * 'intent') and the Brief page (kind: 'context'). Messages flow on
 * the panel background (no inner frame), assistant left-aligned plain
 * text, user right-aligned in a pill bubble. Single rounded composer
 * at the bottom with a circular send button. Plain Enter sends,
 * Shift+Enter inserts a newline.
 */
const DEFAULT_GREETING =
  "Tell me what your agent should do — I'll help shape it. Or ask me to draft a full intent and we'll iterate.";

export function AssistantChatPanel({
  target,
  currentText,
  onApply,
  greeting,
  placeholder,
  title,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: greeting ?? DEFAULT_GREETING },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setError(null);
    setLoading(true);
    try {
      const result = await spClient.aiChat({
        target,
        currentText,
        // Drop the synthetic greeting from the wire payload; the AI
        // doesn't need to see its own first turn.
        messages: next.filter((_, i) => !(i === 0 && _.role === 'assistant')),
      });
      if (result.success && result.reply) {
        setMessages(m => [...m, { role: 'assistant', content: result.reply! }]);
      } else {
        setError(result.error ?? 'AI returned no reply');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed');
    } finally {
      setLoading(false);
    }
  };

  /** Plain Enter sends. Shift+Enter inserts a newline. Cmd/Ctrl+Enter
   *  also sends, for keyboards where Shift is awkward. */
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="intent-chat">
      <h3 className="card-title">{title ?? 'AI Assistant'}</h3>

      <div ref={listRef} className="chat-messages">
        {messages.map((m, i) => {
          const draft = m.role === 'assistant' ? extractDraft(m.content) : null;
          const prose = draft ? stripFencedBlock(m.content) : m.content;
          return (
            <div key={i} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-body">
                {prose && <div className="chat-msg-prose">{prose}</div>}
                {draft !== null && (
                  <>
                    <pre className="chat-fenced-block">{draft}</pre>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm chat-apply-btn"
                      onClick={() => onApply(draft)}
                    >
                      Apply this draft
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="chat-msg assistant">
            <div className="chat-msg-body chat-msg-thinking">Thinking…</div>
          </div>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="chat-composer">
        <div className="chat-composer-pill">
          <textarea
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder ?? 'Ask for help articulating the intent…'}
            rows={1}
            disabled={loading}
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            aria-label="Send"
          >
            ↑
          </button>
        </div>
        <div className="chat-composer-hint">Enter to send · Shift+Enter for newline</div>
      </div>
    </div>
  );
}
