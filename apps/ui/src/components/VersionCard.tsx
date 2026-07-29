/**
 * Which version is running, and whether updates are being checked at all.
 *
 * `installMethod` decides WHERE the checker looks — npm registry, GHCR digest,
 * or git commits. If it guesses wrong, the honest symptom is "no update
 * available", which is indistinguishable from being up to date. Someone asking
 * "why haven't I been told about the new release?" previously had nowhere to
 * look; /health carried the answer and nothing showed it.
 */
import { useUpdateCheck } from '../hooks/useUpdateCheck';

const HOW_WE_CHECK: Record<string, string> = {
  npm: 'Checking npm for new releases',
  docker: 'Checking the container registry for new images',
  dev: 'Git checkout — comparing against origin/main, not npm releases',
};

export function VersionCard() {
  const { version, latestVersion, updateAvailable, installMethod } = useUpdateCheck();
  if (!version) return null;

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Version</h2>

      <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
        Running <strong>{version}</strong>
        {updateAvailable && latestVersion ? <> — <strong>{latestVersion}</strong> is available</> : null}
      </p>

      <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
        {HOW_WE_CHECK[installMethod] ?? 'Update checking is unavailable'}
        {installMethod === 'dev' && (
          <> — a development checkout is not told about published releases.</>
        )}
      </p>
    </div>
  );
}
