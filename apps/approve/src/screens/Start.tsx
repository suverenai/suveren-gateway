import type { Need } from '../lib/compat';
import { P } from '../texts';
import { Screen } from './Frame';

const NEEDS: Record<Need, string> = {
  install_app: P.needsInstall,
  newer_system: P.needsSystem,
  passkey: P.needsPasskey,
  storage: P.needsStorage,
};

/** This phone lacks something the app needs. It says WHICH ability, so the person knows which phone or system version is needed. */
export function NeedsScreen({ needs }: { needs: Need[] }) {
  return (
    <Screen title={P.needsTitle}>
      <p>{P.needsIntro}</p>
      <ul data-testid="needs">
        {needs.map((n) => <li key={n}>{NEEDS[n]}</li>)}
      </ul>
    </Screen>
  );
}

/** A phone that is not paired: two ways in. */
export function WelcomeScreen({ onNew, onJoin }: { onNew: () => void; onJoin: () => void }) {
  return (
    <Screen title={P.welcomeTitle}>
      <p>{P.welcomeBody}</p>
      <p>{P.welcomeReadOnly}</p>
      <button type="button" className="btn btn-primary btn-full btn-lg" onClick={onNew}>{P.welcomeNew}</button>
      <p className="text-sm">{P.welcomeNewWhy}</p>
      <button type="button" className="btn btn-secondary btn-full btn-lg" onClick={onJoin}>{P.welcomeJoin}</button>
      <p className="text-sm">{P.welcomeJoinWhy}</p>
    </Screen>
  );
}
