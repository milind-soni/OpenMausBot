# New-user onboarding

Status: built on `feat/onboarding`. This is the as-built design; the
exploratory plan it replaced considered recorded clips and a field-guide
page, both dropped in favour of code-drawn scenes and a guided tour on the
real interface.

## Goal

A new install should leave the first session knowing what OpenMausBot is
(agents with hands, connected apps, channels, automations, the terminal)
and where each of those lives in the app, without reading a manual. Every
part is skippable, replayable from Settings, and never shown on a paired
remote client.

## Three layers

1. **Welcome flow** (`src/components/onboarding/WelcomeFlow.tsx`). One
   card that morphs between beats with the View Transitions API, with the
   mascot as a single guide. Beats, in order: hello, reel, engines,
   permissions (only when dictation is available), phone, meet your bot.
   The order is pure logic in `src/lib/onboarding.ts` (`beatsFor`,
   `nextBeat`, `previousBeat`) and unit-tested.
2. **Feature reel** (`src/components/onboarding/reel/`). Six scenes drawn
   in code, each a small timeline that reports mascot cues and its own end:
   agents, hands, apps, channels, automations, terminal. Drawing them
   means no media to ship, every skin and locale gets the same picture, and
   a UI change cannot leave a stale recording behind. `REEL` in
   `scenes/index.ts` is the playing order.
3. **Guided tour** (`src/components/onboarding/GuidedTour.tsx`,
   `src/lib/guided-tour.ts`). After the welcome flow, spotlights on the
   live interface with Next on every step. The tour travels the way a user
   would: it opens the Tools menu and points at the item before opening the
   page behind it, and closes what it opened so the last card sits over the
   chat. Steps: composer, model chip, Computer button, the panel's view
   tabs (Browser tab when present), Tools menu, Connected apps item,
   marketplace, Automations item, Automations page, closing card.

A fourth, small piece, `FirstConversationTour.tsx`, explains the first
approval card and the first connect-app card when they appear on their
own during a real turn.

## Persistence

The server config carries an `onboarding` block (`server/config.ts`):
`completedAt`, `version`, `reelSeen`, `hintsSeen[]`. The welcome flow is
due when there is no completion timestamp at the current `WELCOME_VERSION`;
installs that finished the old localStorage gate get one release of grace
and are not shown the new flow. Tour steps and spotlights are ids in
`hintsSeen`, written through `PUT /api/config` before the interface moves
on, so a reload lands on the same step. Steps that live inside something a
previous step opened reopen it on enter for the same reason.

Settings → General has two replay entries: the welcome tour and the app
tour. To reset by hand:

```
curl -X PUT http://127.0.0.1:<port>/api/config -H 'content-type: application/json' \
  -d '{"onboarding":{"completedAt":"","version":0,"reelSeen":false,"hintsSeen":[]}}'
```

## Spotlight

`Spotlight.tsx` finds its anchor by a `data-tour` id, never a class, so a
refactor cannot silently break the tour. The dim layer is an even-odd
clip-path polygon that eases from the full window down to the anchor; the
cutout carries an accent ring and halo. The card sits above, below, or
beside the anchor (beside for sidebar controls), inside the anchor when it
fills the window, and centred when there is no anchor. Layout, scroll,
resize, and DOM mutations re-measure it. Escape ends the tour.

Anchors: `composer`, `model`, `computer`, `computer-tabs`,
`computer-browser`, `tools`, `nav-apps`, `nav-automations`, `apps-panel`,
`apps-close`, `automations-page`, `approval`, `connector`.

The sidebar Tools popover ignores pointer-downs on the tour card
(`[data-tour-card]`) so pressing Next does not close the menu it is
describing. When the user presses the highlighted control instead of Next,
the tour does not repeat the control's own action.

## Motion

Transform and opacity only, house curve `cubic-bezier(0.22, 1, 0.36, 1)`,
40 ms stagger, nothing enters from `scale(0)`. Tokens and keyframes live
in `src/styles.css` (`rise`, `spot-in`, `orbit`, `ripple`, `bolt`). Reduced
motion is honoured through `reducedMotion()` in `src/lib/onboarding.ts`,
which reads the media query and a `data-reduced-motion` dev hook: the
reel scenes render their final frame, the spotlight appears without the
sweep, and beats swap without the view transition.

## Preview and verification

- `onboarding-preview.html` + `src/onboarding-preview.tsx` is a dev gallery
  of every beat in every skin (`?beat=&skin=&reduced=1&all=1`).
- Pure logic is covered by Vitest: `onboarding.test.ts`,
  `guided-tour.test.ts`, `first-conversation.test.ts`, and the config merge
  in `server/config.test.ts`.
- The tour was walked end to end in headless Chrome against the isolated
  fixture (`node --experimental-strip-types scripts/control-omb.ts launch`)
  with a screenshot per step. Note that the record is per workspace, so a
  second client on the same server runs the same tour and skips steps it
  cannot see; test from one window.

## Out of scope

- Phone and native clients: they see nothing from this branch.
- A skin picker inside the welcome flow.
- Per-user onboarding state (prepared for `feat/rbac-users`, moved there).
- The CLI setup wizard in `server/cli-setup.ts`.
