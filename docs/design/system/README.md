# Musterd design system — pointers for Claude Design

This is not a second component library. The live system is CSS tokens + a few shared classes + React screens. Point GitHub Import / “Add a design system” at these paths.

## Tokens & skins

| What | Path |
| --- | --- |
| All skin tokens, animations, shared UI classes | `src/styles.css` |
| Skin IDs, names, system light/dark mapping | `src/lib/skins.ts` |
| Skin picker UI | `src/components/SkinPicker.tsx` |
| Optional font overrides (`data-font`) | `src/lib/fonts.ts` |
| Contrast gate | `scripts/check-skin-contrast.mjs` |

**Mechanism:** `@theme` declares defaults (Midnight). Each skin reassigns the same custom properties under `[data-skin="<id>"]` (not `:root[data-skin]`), so a subtree can preview a skin.

**Core color tokens to preserve / evolve together:**

- Surfaces: `--color-app`, `--color-panel`, `--color-raised`, `--color-raised-hover`, `--color-card`, `--color-inset`, `--color-control`, `--color-frame`
- Composer / menus: `--color-composer`, `--color-composer-ring`, `--color-menu`, `--color-menu-hover`, `--color-menu-active`
- Ink: `--color-ink`, `--color-ink-secondary`, `--color-ink-tertiary`
- Accent / focus: `--color-accent`, `--color-accent-border`, `--color-focus`, `--color-accent-text`
- Feedback: `--color-success`, `--color-danger`, `--color-warning`
- Chat: `--color-bubble-user`, `--chat-bubble-max`, `--chat-column-max`
- Type: `--font-sans`, `--font-mono`
- Motion: `--animate-panel-in`, `--animate-sheet-in`, `--animate-msg-in`, `--animate-pop-in`, …

**Shipped skins:** `midnight`, `atelier`, `foundry`, `lagoon`, `graphite`, `linen`, `dusk`, `daylight`, `meadow`, `pop`, `halloween`.  
**System pair:** dark → `midnight`, light → `daylight`.

## Shared primitives (CSS)

Defined in `src/styles.css` under `@layer components` (and a few outside):

- `.ui-button`, `.ui-button-primary`, `.ui-button-pill`, `.ui-button-lg`, `.ui-icon-button`
- `.popover-surface`, `.glass-surface`
- `.chat-column`, `.chat-column-dock`
- `.ui-modal` (+ skin tweaks)

Prefer restyling these over inventing parallel button/card systems.

## Primary React surfaces

| Area | Paths |
| --- | --- |
| Shell | `src/App.tsx`, `src/components/app/AppFrame.tsx`, `AppChrome.tsx` |
| Sidebar | `src/components/Sidebar.tsx`, `Sidebar*.tsx`, `src/components/sidebar-preview.ts` |
| Chat | `src/components/ChatView.tsx`, `ChatEmptyState.tsx`, `ChatMarkdown.tsx` |
| Composer | `src/components/Composer.tsx`, `Composer*.tsx` |
| Rooms | `src/components/RoomHeader.tsx`, `src/components/room-panel/` |
| Bots | `BotPickerList.tsx`, `BotSettingsDialog.tsx`, `src/components/bot-settings/`, `src/components/bot-panel/` |
| Inbox / activity | `src/components/inbox/`, `ActivityPanel.tsx`, `ApprovalCard.tsx` |
| Onboarding | `src/components/onboarding/` |
| Apps / widgets | `src/components/app/`, `src/components/widget/` |

## Stack notes

- React + Vite; Tailwind CSS v4 via `@tailwindcss/vite`
- Fonts: `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`
- Icons: `lucide-react`
- Class merge: `src/lib/cn.ts` (tailwind-merge)

## What Claude Design should output against this system

Map mockups onto **token changes** + **class/component restyles**. Do not assume a separate Storybook or Figma library exists in-repo — it does not.
