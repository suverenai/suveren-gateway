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
