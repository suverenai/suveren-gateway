/**
 * Read-only "Data folder" line. The path comes from the control plane (the
 * folder the running gateway actually uses); nothing is guessed client-side
 * and there is deliberately no control to change it.
 */
import { useEffect, useState } from 'react';
import { Fragment } from 'react';
import { spClient } from '../lib/sp-client';
import { DATA_FOLDER_LABEL, DATA_FOLDER_NOTE, pathWrapParts } from '../lib/data-folder';

export function DataFolderLine() {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    spClient.getDataFolder().then(r => setDir(r.dataDir)).catch(e => setError(e instanceof Error ? e.message : 'Unknown error'));
  }, []);

  return (
    <p className="su-datafolder" style={{ fontSize: 'var(--text-body-sm)', color: 'var(--text-muted)', margin: 'var(--space-3) 0 0', overflowWrap: 'anywhere' }}>
      <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{DATA_FOLDER_LABEL}</strong>{' '}
      {dir !== null ? (
        <>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)' }}>
            {pathWrapParts(dir).map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}
          </code>{' '}
          — {DATA_FOLDER_NOTE}
        </>
      ) : error ? (
        <span role="alert">could not be read ({error})</span>
      ) : (
        'checking…'
      )}
    </p>
  );
}
