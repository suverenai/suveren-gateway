# @suveren/approval-card

The approval card and the browser-side code that opens sealed proposal content.
Shared by the gateway page (`apps/ui`) and the phone app (`apps/approve`, later).

Source-only: the host app's bundler compiles it. No Node-only imports; it runs in
Chromium and WebKit.

## Host seam

The card knows nothing about the gateway's control-plane URL, router or session.
The page that renders it calls `configureApprovalHost(...)` once, before the first
render (`src/host.ts`):

- `data`: the reads the card needs and the one decrypt call
  (`decryptProposalContent` opens a sealed payload with this device's key).
- `useSession`, `useServerEvent`, `useSimulationMode`, `useOpenMandateScreen`, `Link`.
  `useOpenMandateScreen` returns null on a host without a mandate screen; the two
  "edit" links are then not shown.

The gateway page does this in `apps/ui/src/lib/approval-host.ts`.

The card shows only what is bound (the proposal) plus the host's own local data.
Nothing in the seam lets a caller add text that reaches the approver.

## Public API

`src/index.ts`: `ApprovalCard`, `ApprovalBody`, `configureApprovalHost`,
`decryptProposalArgs`, `contentHashForDecision`, `useProposalContent`, the wire types.
Deeper modules are importable by path (`@suveren/approval-card/lib/<name>`,
`/components/<name>`, `/hooks/<name>`, `/types`, `/host`) because the gateway's
other screens use the same helpers.

## Styles

Not in this package yet. The card's rules (`av3-*`, `mc-*`, ...) sit in
`apps/ui/src/styles/design-system.css` and `tokens.css`. A host page must load both.
They were not split out so the gateway page renders exactly as before.

## Fixture

A bare page that renders a plain and a sealed proposal with no gateway behind it.

    pnpm --filter @suveren/approval-card fixture        # dev server, port 5199
    pnpm --filter @suveren/approval-card fixture:build  # static files in fixture/dist

Tests: `pnpm --filter @suveren/approval-card test`.

## The mandate card (one for every device)

`src/components/MandateProposalCard.tsx` draws a mandate proposal: the type line with the commitment badge, the title, the summary line,
the "You sign this" tile (Intent, Commitment, Valid, Limits, Scope, Applies to, Title) and the folded rows; `CommitmentBand` sits right
above the give button. The gateway's `ApprovalBody` and the phone's `GiveBody` (apps/approve) both render through it and write no
markup of their own for the mandate; `apps/approve/src/screens/give-card-drift.test.ts` fails if the phone grows its own copy.

The facts (rows, summary line, "Valid", money as "€2,000", lists with a space after each comma) come from `lib/mandate-facts.ts` and
`lib/mandate-card-model.ts`, read from the profile's schema only. `shortSummary` is the one rule for the short line on a list card
(scope first, then limits in the profile's own order, at most four facts, schema defaults and full enums left out, "+N more").

Looking at it: `apps/approve/fixture` draws the same proposal on both devices; `apps/approve/e2e/card-parity.pw.ts` compares them at 390 px
and 1100 px (`npx playwright test -c apps/approve/playwright.config.ts`; `SHOTS_DIR=<dir>` also writes screenshots).
