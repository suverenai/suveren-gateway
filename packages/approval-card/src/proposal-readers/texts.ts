/**
 * Step 8: every word the person reads about WHO CAN OPEN A PROPOSAL (readers whose device chain did not verify,
 * a computer that has not received a proposal's key yet, a card context that could not be opened). ONE module for
 * every device: the gateway page and the later phone app import these same strings.
 *
 * EVERY text here is `DRAFT`: there is no signed-off mockup for it yet. The maintainer approves the wording
 * (O19); nothing here is shown until a screen imports it. The codes are what the gateway returns
 * (control-plane lib/device-readers.ts `UnreadableCode`, lib/content-wraps.ts `ContextErrorCode`).
 *
 * Pure: no React, no network.
 */

export const S8 = {
  /** DRAFT: the alarm title when a reader's device chain did not verify. */
  alarmTitle: 'Someone cannot read this request',
  /** DRAFT: shown for `chain_invalid`, `chain_fork`, `chain_rollback`, `head_mismatch`. {name} is the person as the team list names them. */
  alarmChain: (name: string): string => `The devices of ${name} could not be checked, so ${name} cannot read this request. Nothing was sent to them.`,
  /** DRAFT: `as_unreachable`, `as_answer_invalid`, `not_signed_in`. */
  readerOutage: (name: string): string => `${name} could not be reached right now, so ${name} cannot read this request yet.`,
  /** DRAFT: `no_active_device`, `device_key_invalid`, `no_reading_key`. */
  readerNoDevice: (name: string): string => `${name} has no device that can open this request yet.`,
  /** DRAFT: a computer or phone added after the request was made, before it got its key. */
  notYetOpenable: 'This device has not received the key to this request yet. Another of your devices will pass it on.',
  /** DRAFT: `context_unreadable`, `context_invalid`: the card is drawn with the arguments only. */
  contextMissing: 'The extra details for this card could not be opened. The request itself is shown in full.',
} as const;

/** Which text group a gateway code belongs to. Unknown codes are an outage, never silence. */
export function readerCodeKind(code: string): 'alarm' | 'outage' | 'no_device' {
  if (code === 'chain_invalid' || code === 'chain_fork' || code === 'chain_rollback' || code === 'head_mismatch') return 'alarm';
  if (code === 'no_active_device' || code === 'device_key_invalid' || code === 'no_reading_key') return 'no_device';
  return 'outage';
}
