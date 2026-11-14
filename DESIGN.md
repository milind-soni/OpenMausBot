# OpenMausBot design rules

These are the rules for how OpenMausBot looks, reads and behaves. They cover
the desktop and web app in `src/`. Every UI change follows them, whoever
writes it: a maintainer, a first-time contributor or a coding agent.

They are rules, not suggestions. A reviewer can point at a section number and
ask for a change. If a rule stops you from doing the right thing, change the
rule in the same PR and say why in the description. Don't quietly break it.

Older screens don't all follow these rules yet. New and changed UI does. Fix
what you touch as you go; don't restyle the app in sweeps, which conflict with
everyone else's work.

Several rules are enforced by tests and scripts; [section 15](#15-what-the-checks-enforce)
lists them. The rest rely on review.

## 1. Principles

1. **Calm by default.** The resting screen is quiet. Nothing blinks, counts
   or competes for attention unless the person needs to act. When in doubt,
   leave it out.
2. **One product.** A new screen looks like it was always there. Use the
   tokens, components and words that already exist. A one-off style is a bug.
3. **Name it, don't explain it.** A good label beats a paragraph. If a
   control needs a sentence of help text to be understood, rename or redesign
   it first.
4. **Plain words.** Say what a person knows, not what the code calls it:
   "AI", not "engine"; "cloud desktop", not "VM".
5. **Every state is designed.** Empty, loading, error, long text, narrow
   window, light and dark skins. Nobody ships only the happy path.
6. **Everyone can use it.** Keyboard, touch, screen readers, right-to-left
   languages and reduced motion are part of the design, not a follow-up.
7. **Borrow the feel, never the form.** Another product can inspire the
   finish. Don't copy its signature parts; build ours.

## 2. Where things go

The experimental desktop dynamic island (`--dynamic-island`) is an explicit
prototype exception to the placement and no-new-settings rules below. Its
capture start/pause and Omi connection controls belong inside the island.
It starts with capture paused, never takes focus on a background update, and
uses the product's own mascot and skin colours. This is not enabled on normal
startup until the desktop acceptance checks in `docs/verification/dynamic-island.md`
have been completed.

The app has three places: the **sidebar** (bots and conversations), the
**chat**, and the **bot panel** (everything about one bot). Put new things
where they belong instead of adding new places.

- **No new header buttons.** The chat header shows the bot, its model and its
  screen. Anything else goes in the bot panel, a menu or the command palette.
- **No count badges and no "needs you" summaries** above the sidebar list or
  in the header. A status mark on the row it belongs to is fine.
- **Settings for one bot live in its bot panel.** App-wide settings live in
  Settings. Don't add a second home for the same setting.
- **No new settings.** No new global settings, toggles or hidden flags. Make
  the behaviour automatic with a good default. An optional field on something
  the person sets up is fine.
- **No new asks.** No new permission asks, approval cards, confirm dialogs,
  nags or waits that interrupt the person, and no default below Full access.
  A bot gets on with the work; a change that needs undoing gets **Undo**.
- **Bots set themselves up.** A new bot asks its questions in chat
  (`/setup`). Don't add form fields for things the bot can learn by asking.
- **Simple mode comes first.** It is the default for new installs. Design the
  Simple version, then decide what Advanced adds (see [section 13](#13-simple-and-advanced-mode)).
- **Don't hide everyday features.** A thing most people use must be reachable
  in two clicks from the chat in Simple mode.

## 3. Colour

Every colour comes from a token in [`src/styles.css`](src/styles.css). Use
them through Tailwind (`bg-panel`, `text-ink-secondary`, `border-hairline`).

| Job | Tokens |
|---|---|
| Surfaces | `app` (chat), `panel` (sidebar), `card`, `raised` / `raised-hover` (selected row), `inset` (search field), `control`, `menu` / `menu-hover` / `menu-active`, `composer` |
| Text | `ink` (primary), `ink-secondary` (supporting), `ink-tertiary` (timestamps, hints, placeholders) |
| Lines | `hairline` (borders, dividers), `edge` (where two panes meet) |
| Accent | `accent`, `accent-text` (accent-coloured text), `accent-ink` (text on an accent fill), `focus` (keyboard ring) |
| Status | `success`, `warning`, `danger`, each with an `-ink` for text on its fill |
| Bots | `identity-*`, one per bot colour |

Rules:

- **No raw colours.** No hex, `rgb()`, or Tailwind palette classes
  (`text-gray-500`, `bg-white`, `text-black`). A skin can't restyle them.
  The only exception is a third-party logo that needs its own plate.
- **Hover and pressed fills are ink at low opacity:** `hover:bg-ink/[0.06]`,
  `active:bg-ink/[0.08]`. They work on every skin.
- **Hierarchy comes from ink, not colour.** Use the three ink levels and
  size. Don't use grey hex values or extra opacity to make a fourth level.
- **Accent is rare.** Use it for links, focus and the selected state. In
  Midnight and Daylight the primary button is a neutral ink pill, not an
  accent one. Give a view one primary action at most.
- **Status colours mean status.** Use `danger` for destructive actions and
  errors only, never as decoration.
- **Bot colours belong to bots.** Use `identity-*` only for things owned by
  one bot: its mark, its bubble, `.bot-button`.
- **A new token goes in every skin.** `src/lib/skins.test.ts` fails
  otherwise. Run `pnpm check:contrast`: text clears 4.5:1 on every surface it
  sits on.
- **Check both reference skins.** Midnight (dark) and Daylight (light) are the
  reference skins; every change is checked in both. The other skins restyle
  tokens, so a change that only uses tokens works there too.

## 4. Type

Midnight and Daylight use **Geist** for text and **Geist Mono** for code, keys
and paths. A skin may choose its own face; components never set `font-family`
and never add fonts.

| Use | Size / line height | Weight | Ink |
|---|---|---|---|
| Page or dialog title | 20px, `tracking-[-0.01em]` | 600 | `ink` |
| Sheet or section title | 17px | 600 | `ink` |
| Chat bubble (Simple) | 15 / 22px | 400 | `ink` |
| Menu item (`MENU_ITEM`) | 14 / 18px | 400 | `ink` |
| Body, rows, menu rows (`MENU_ROW`) | 13 / 18px | 400 | `ink` or `ink-secondary` |
| Names in lists | 13 / 18px | 500 | `ink` |
| Meta, hints, group labels | 12 / 16px | 400 (group labels 500) | `ink-tertiary` |
| Keycaps (`ShortcutHint`), tiny badges | 11px | 400 | `ink-secondary` or `ink-tertiary` |

Rules:

- **Buttons size their own labels.** `.ui-button` and its variants set the
  size and weight; don't add text classes to them.
- **Stick to the table.** No 16px or 18px body text, and no new text under 11px.
- **Three weights:** 400 for text, 500 for names and labels, 600 for titles.
  No 700.
- **Sentence case everywhere.** Titles, buttons, menu items and labels.
  No ALL CAPS labels and no Title Case.
- **One line for titles and rows.** Truncate with `truncate` and keep the
  full text reachable (a `title` or the opened view). Let body text wrap.
- **Numbers that change in place** (timers, counts, usage) use
  `tabular-nums` so they don't jitter.

## 5. Shape

Midnight and Daylight share one radius scale. Other skins, and phone-width
windows, retune the radius tokens, which is why you use the class for the
element's job and never a pixel value:

| Element | Radius | Class |
|---|---|---|
| Buttons, pills, chips, avatars | full | the button and chip classes, `rounded-full` |
| Menu rows | 6px | `rounded-md` |
| Fields, controls, sidebar rows | 8px | `rounded-lg` |
| Cards, menus, popovers | 12px | `rounded-xl` |
| Dialogs | 14px | `.ui-modal` |
| Bubbles, cards in the transcript | 18px | `rounded-4xl` |
| Composer | 22px (18px once it wraps) | set by the composer |
| Window panes | 0 | |

- **No in-between values** (`rounded-[10px]`, `rounded-[14px]`). Pick the step
  for the element's job.
- **A nested shape is smaller than its container.** A card (12) in a dialog
  (14) is right; a 12px card inside a 12px menu is not.

## 6. Space and layout

- **Use the 4px grid.** Tailwind's spacing scale. An arbitrary value like
  `py-[7px]` belongs in a shared recipe with a reason, not in a one-off.
- **One inset per surface.** Everything in a panel, menu or card starts at the
  same left edge and ends at the same right edge. Leading icons sit in a fixed
  gutter (`MENU_GUTTER`, 16px) so labels line up whether or not a row has an
  icon.
- **Labels line up with their heading.** Put shortcut letters, counts and
  chevrons at the end of a row, not before the label.
- **Control heights: 24, 28, 32 or 36px.** Menu rows are 30px. On touch
  screens, targets grow to 40–44px with the `touch:` variant.
- **Group with space before you group with lines.** Add a divider only between
  groups that space alone can't separate. Never a divider under a heading.
- **No cards inside cards.** If a card needs sections, use spacing and a group
  label.
- **Use logical properties.** Write `ms-`, `me-`, `ps-`, `pe-`, `start-` and
  `end-`, never `ml-` or `left-`, so right-to-left layouts mirror. Directional
  icons flip with `rtl:-scale-x-100`.
- **Design for 1440×900 and check it narrow.** Nothing may clip or overlap at
  the smallest window the app allows.

## 7. Icons

- **Use `lucide-react` only.** No emoji as icons, no icon fonts, no
  hand-drawn SVGs for things Lucide has. Product marks (the Maus, third-party
  logos) are the exception.
- **Sizes:** 16px in menus, rows and toolbars; 14px next to 12–13px text.
- **Don't set `strokeWidth`.** The stylesheet draws Lucide at 1.75, and menus
  at 1.5 through `MENU_SHEET`. Menu code that passes `MENU_STROKE` is the one
  exception.
- **Icons are bare.** Don't put them in tinted squares or circles. A bot's
  avatar is the only mark that gets a plate.
- **Decorative icons get `aria-hidden="true"`.** An icon-only button needs an
  `aria-label`, and a `title` when its meaning isn't obvious.
- **One icon, one meaning.** If an icon already means something in the app,
  don't reuse it for something else.

## 8. Surfaces and depth

- **Only floating things cast shadows:** menus, popovers and dialogs. Use
  `menu-surface` or `popover-surface`, which carry each skin's shadow. Cards
  in the page are flat, with a `hairline` border or a tint.
- **Borders are 1px `hairline`.** Panes meet on a 0.5px `edge`. An element in
  the page gets a border or a tint, not both, and no shadow. Floating surfaces
  take their surface class, which already balances all three.
- **Rich content in a reply stays in the bubble.** Tables, code and quotes are
  drawn alike: no fill of their own, a 1px hairline and a faint tint. One
  reply is one bubble.
- **Scrims** (`ui-scrim`) dim the app behind a modal dialog; nothing else
  dims the app.

## 9. Components

Reuse what exists. If something is missing, add it once to the shared module
and use it everywhere, rather than styling a one-off.

| You need | Use |
|---|---|
| Class merging | `cn()` from `src/lib/cn.ts` |
| A button | `.ui-button` with `-sm` / `-md` / `-lg`, `-pill`, `-primary`, or `.ui-icon-button` |
| A chip or pill | `.ui-chip` (static), `.ui-pill` (clickable) |
| A menu | `MENU_SHEET`, `MENU_ROW`, `MENU_LABEL`, `MENU_SEPARATOR`, `MENU_META` and the rest of `src/components/menu-recipe.ts`; `SidebarPopoverMenu` for anchored menus; `useMenuMotion` |
| A dropdown | `Select` from `src/components/Select.tsx`; never a native `<select>` |
| A dialog | `.ui-modal`; `useModalDialog` for the focus trap, Escape and returning focus |
| A confirmation | Don't add one (see [section 2](#2-where-things-go)). Existing ones use `ConfirmDialog` |
| Closing on Escape or outside click | `usePopoverDismiss` |
| A switch | `Switch` from `src/components/SettingsPrimitives.tsx` |
| Settings rows | `SettingsGroup`, `SettingRow`, `SettingsDisclosureRow` |
| Bot panel rows | `src/components/bot-panel/rows.tsx` (`NavRow`, `SwitchRow`, `Segmented`, `ItemRow` and more) |
| A keyboard shortcut hint | `ShortcutHint` |
| Copy to clipboard | `copyText` from `src/lib/copy-text.ts` |

## 10. Motion

Motion explains a change. It never decorates.

- **Use the tokens:** `animate-pop-in` / `pop-out` (menus, 200ms),
  `animate-panel-in` (240ms), `animate-msg-in` (180ms), `animate-fade-in`.
  Movement eases with `cubic-bezier(0.22, 1, 0.36, 1)`; fades use `ease-out`.
- **300ms ceiling.** Only first-run onboarding may run longer.
- **Nothing scales in from zero.** Things grow from about 96% and fade.
- **Hover and press transitions are 120ms** on colour and opacity only. Don't
  animate layout.
- **No loops** except a live status that is really live (a bot working).
  Never animate something just to draw the eye.
- **Respect reduced motion.** Pair every transition with
  `motion-reduce:transition-none` and every animation with
  `motion-reduce:animate-none`, or gate it in CSS on
  `prefers-reduced-motion` and `[data-reduced-motion="true"]`.

## 11. Words

The words are part of the design. Write the way a calm, competent colleague
talks.

- **Sentence case, short sentences, no exclamation marks.** No marketing
  excitement inside the app.
- **Buttons say what they do:** "Save", "Connect Gmail", "Delete bot". Not
  "OK", "Submit" or "Yes".
- **Errors say what happened and what to do next:** "Couldn't reach Gmail.
  Check that you're online and try again." Never blame the person, never show
  a raw error code without a sentence before it.
- **Name controls exactly as they're labelled.** If copy says "open
  Automations", the button reads "Automations" (a test checks this).
- **Use the product's words.** "MausBot Cloud" or "the Cloud", "cloud
  desktop", "This computer", "AI", "Organization". The vocabulary tests list
  the retired ones and the internal words to avoid.
- **Show values, not explanations.** "Theme · Midnight" beats a sentence about
  themes. "Your name · Not set yet" beats an empty field with grey text.
- **Empty states are one line and one action.** Say what goes here and how
  to add the first one. No paragraphs, no illustrations made for the occasion.
- **Never promise.** No "coming soon" and no teasers for unbuilt features.
- **Use "…" (one character)** for work in progress ("Saving…") and for a
  command that asks for more before acting ("Rename…").
- **Every string goes through `t("…")`** with its English in
  `src/locales/en.json`. Changing the English of an existing key makes its
  translations stale; follow [`docs/localization.md`](docs/localization.md).
  Placeholders are never labels: a field has a visible label or a clear
  `aria-label`.

## 12. States

Before a UI change is done, it handles each of these:

- **Default, hover, focus-visible, pressed, disabled.** The shared classes
  dim disabled controls themselves; a custom row uses `disabled:opacity-50`
  and drops its hover fill. Say why it's disabled when the reason isn't
  obvious.
- **Loading.** Keep the layout steady; reserve the space. A spinner only if it
  takes over 300ms. No skeletons for things that load in under a second.
- **Empty.** See [section 11](#11-words).
- **Error.** Inline, next to what failed, with a way to retry.
- **Long and odd content.** A 60-character name, a 2,000-row table, an emoji,
  Arabic or Hebrew text, no avatar.
- **Narrow window, touch screen, light and dark skins.**

## 13. Simple and Advanced mode

`useAdvancedMode()` from `src/lib/interface-mode.ts` tells you which mode is
on. Simple is the default for new installs.

- **Simple mode shows what a person needs to talk to bots and get work done.**
  Tokens, usage, inspectors, raw logs and developer tools belong in Advanced.
- **Advanced adds; it doesn't rearrange.** The same thing sits in the same
  place in both modes. Advanced may show more rows or more detail.
- **Switching modes never loses data.**

## 14. Accessibility

- **Never remove the focus ring without a replacement.** The global
  `:focus-visible` ring uses `--color-focus`. Menu rows show focus as their
  hover fill; text fields colour their border.
- **Everything works from the keyboard.** Menus move with the arrows, Home and
  End, type-ahead, Enter and Escape (`src/components/model-menu-keys.ts`,
  `src/lib/menu-keys.ts`). Tab never lands on something hidden.
- **Hover-only controls also show on touch and on keyboard focus.** Pair
  `group-hover:opacity-100` with a `touch:` rule and a `focus-visible` or
  `focus-within` rule. A test enforces this.
- **Disclosures** use a button with `aria-expanded` and `aria-controls`, and
  hide their content with the `hidden` attribute.
- **Dialogs trap focus and give it back** (`useModalDialog`, or
  `ConfirmDialog`, which does it itself). A destructive
  confirmation focuses Cancel, so a stray Enter never deletes anything.
- **Use the right role:** `role="switch"` with `aria-checked` for switches,
  `aria-pressed` for segmented buttons, `aria-live="polite"` or
  `role="status"` for messages that appear on their own.
- **Contrast:** text 4.5:1, focus rings and control edges 3:1, on every skin.
- **Chat text and inputs use `dir="auto"`** so mixed-direction text reads
  correctly.

## 15. What the checks enforce

| Check | Rule |
|---|---|
| `pnpm check:contrast` | Every skin's text clears 4.5:1 on its surfaces |
| `src/lib/skins.test.ts` | Every skin defines every token |
| `src/lib/control-scale.test.ts` | Button heights 32 / 28 / 24px, on skin tokens |
| `src/components/Select.guard.test.ts` | No native `<select>` |
| `src/components/touch-actions.test.ts` | Hover reveals have touch and focus versions |
| `src/components/chat-dir-auto.test.ts` | Chat inputs use `dir="auto"` |
| `src/lib/copy-text.guard.test.ts` | Clipboard writes go through `copyText` |
| `src/locales/vocabulary.test.ts`, `everyday-words.test.ts`, `words.test.ts`, `welcome-words.test.ts` | Product words, no internal words, no retired names, no em dashes in the welcome |
| `pnpm i18n:check` | Locale structure, placeholders, stale translations |
| `scripts/testing/file-size-ratchet.test.ts` | No file grows past its line limit |

## 16. Before you open a UI pull request

- [ ] It follows sections 1–14, or the PR changes this file and says why.
- [ ] Only tokens, the radius scale, the type table and existing components.
- [ ] Checked in **Midnight and Daylight**, in **Simple mode** (and Advanced
      if you touched it), at 1440×900 and at a narrow width.
- [ ] Every state in [section 12](#12-states) handled.
- [ ] Works with the keyboard alone; focus is visible throughout.
- [ ] New strings go through `t()`; `pnpm i18n:check` passes.
- [ ] Before/after screenshots in the PR for both skins; a short video for
      anything that moves.
- [ ] Screenshots use test data, never real accounts, names or messages.
