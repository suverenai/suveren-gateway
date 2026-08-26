/**
 * The complete receipt — the artifact itself, verbatim.
 *
 * The card is the readable form; this is deliberately NOT a second prose
 * rendering of it. What a person needs here is the exact object they could
 * hand to an auditor, a lawyer, or a verifier script, byte-for-byte as issued.
 *
 * Two sources, and the difference is the whole point of the local archive:
 *  - **this device** — the archive entry: signed receipt + the attestation
 *    blobs it ran under + the issuer key at issuance. Survives the Authority
 *    Server going away, which is exactly when evidence matters most.
 *  - **the Authority Server** — the same signed receipt, fetched live, for
 *    receipts predating the local archive or executed on another machine.
 *
 * The source is always stated. Showing an AS-fetched copy as if it were held
 * locally would misrepresent what the user actually has custody of.
 */

import { useEffect, useState } from 'react';
import {
  spClient,
  type ExecutionReceipt,
  type LocalReceiptEntry,
  type SignatureStatus,
} from '../lib/sp-client';

interface Props {
  receipt: ExecutionReceipt;
  onClose: () => void;
}

type Source = 'local' | 'authority-server';

export function ReceiptCompleteDialog({ receipt, onClose }: Props) {
  const [entry, setEntry] = useState<LocalReceiptEntry | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [signature, setSignature] = useState<SignatureStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    spClient
      .getArchivedReceipt(receipt.id)
      .then(found => {
        if (cancelled) return;
        setEntry(found);
        setSource(found ? 'local' : 'authority-server');
        setSignature(found?.signature ?? null);
      })
      .catch(() => {
        // Local evidence unreachable (MCP down, vault locked) — fall back to
        // the AS copy already in hand rather than showing nothing.
        if (!cancelled) setSource('authority-server');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [receipt.id]);

  // What we display IS what Download/Copy hand over — so a third party gets
  // exactly the bytes the user was shown.
  const payload = entry ? entry.entry : { receipt };
  const json = JSON.stringify(payload, null, 2);

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `suveren-receipt-${receipt.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: '44rem' }}>
        <div className="modal-header">
          <h3 className="modal-title">Complete receipt</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="modal-body">
          {signature === 'valid' && (
            <p className="receipt-verified" style={{ margin: '0 0 0.5rem', fontSize: '0.8rem' }}>
              &#10003; Ed25519 signature verified on this device, against the issuer key archived
              when this receipt was issued.
            </p>
          )}
          {signature === 'invalid' && (
            <p className="receipt-tamper" style={{ margin: '0 0 0.5rem', fontSize: '0.8rem' }}>
              &#9888; Signature check FAILED — the stored receipt does not match what was signed.
            </p>
          )}
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
            {loading
              ? 'Loading…'
              : source === 'local'
                ? 'Held on this device — the signed receipt, the attestation it ran under, and the issuer key. Anyone with this file and that key can verify it offline, without Suveren.'
                : 'No local copy of this receipt (it predates local archiving, or ran on another device). Shown from the Authority Server — complete and signed, but it needs the server to retrieve.'}
          </p>

          <pre
            style={{
              fontFamily: "'SF Mono', Monaco, monospace",
              fontSize: '0.68rem',
              lineHeight: 1.65,
              margin: 0,
              background: 'var(--accent-subtle)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '0.75rem 0.85rem',
              overflowX: 'auto',
              maxHeight: '22rem',
              overflowY: 'auto',
            }}
          >
            {json}
          </pre>
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary btn-sm" onClick={download}>Download</button>
          <button className="btn btn-secondary btn-sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
