/**
 * UI spec §2.1/§15.2 — "Text — written by the AI": the one argument a
 * tool's manifest names via `display.aiText` (e.g. mail/gmail's
 * `send_message` -> `body`), shown in its own amber box, separate from the
 * sealed recipients/subject/attachment boxes. Reuses `.preview-box
 * .preview-box-ai` (RequestContextBox's own "Request" box) — same token,
 * never a new hue.
 *
 * Still sealed — content-binding hashes this value exactly like every
 * other bound field; this box only changes WHERE it is shown, never
 * whether it counts as bound. The small "sealed" tag says so, the same tag
 * the "What will be sent" box already uses (ApprovalBody.tsx).
 */
export interface AiTextBoxProps {
  text: string;
}

export function AiTextBox({ text }: AiTextBoxProps) {
  return (
    <div className="preview-box preview-box-ai" data-testid="ai-text">
      <h4>
        Text — written by the AI
        <span className="src-tag src-tag-sealed">sealed</span>
      </h4>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</p>
    </div>
  );
}
