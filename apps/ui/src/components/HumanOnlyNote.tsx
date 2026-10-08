/**
 * "Only you" — on the sign-in page and on Approvals. An AI that controls a
 * browser or the screen could otherwise sign in with the key and approve its
 * own proposals. The person is the one who has to keep it out; this says so.
 */
export function HumanOnlyNote({ what }: { what: 'sign-in' | 'approve' }) {
  return (
    <div className="human-only-note" role="note">
      <strong>Only you.</strong>{' '}
      {what === 'sign-in'
        ? 'Never let an AI or a browser it controls sign in here or see this key.'
        : 'Approve only yourself. Never let an AI or a browser it controls open this page or approve for you.'}
    </div>
  );
}
