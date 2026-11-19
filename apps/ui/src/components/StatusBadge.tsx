interface Props {
  status: 'active' | 'pending' | 'expired' | 'revoked';
  label?: string;
}

const LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  expired: 'Expired',
  revoked: 'Ended',
};

export function StatusBadge({ status, label }: Props) {
  return (
    <span className={`status-badge status-${status}`}>
      {label || LABELS[status]}
    </span>
  );
}
