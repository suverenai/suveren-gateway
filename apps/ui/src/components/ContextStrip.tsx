import { profileDisplayName } from '@suveren/approval-card/lib/profile-display';

interface Props {
  profileId?: string;
  bounds?: string;
  groupName?: string;
  domain?: string;
  onSwitch?: () => void;
}

export function ContextStrip({ profileId, bounds, groupName, domain, onSwitch }: Props) {
  return (
    <div className="context-strip">
      {groupName && (
        <>
          <span className="context-strip-label">Team:</span>
          <span><strong>{groupName}</strong>{domain ? ` / ${domain}` : ''}</span>
        </>
      )}
      {profileId && <span><strong>Profile:</strong> {profileDisplayName(profileId)}</span>}
      {bounds && <span><strong>Bounds:</strong> {bounds}</span>}
      {onSwitch && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 'auto', padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
          onClick={onSwitch}
        >
          Switch
        </button>
      )}
    </div>
  );
}
