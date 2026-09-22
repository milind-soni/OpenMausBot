# Sidebar attention popover geometry

The Active Threads menu in the sidebar header is anchored `right-0` inside
the header's icon group, which sits 16px (`px-4`) inside the sidebar's right
edge, so the menu's width decides whether it fits. The compact sidebar is
272px wide: a static 288px (`w-72`) menu spilled 32px past the window's left
edge, where the OS clipped it — the reported bug showed the title row as
"ive Threads", because its 14px of padding left the leading text inside the
clipped zone while the thread rows below survived on their wider inset.

The icons density had a different anchoring failure: its icon cluster
stacks vertically, so the same cluster-anchored popover opened below the
"+" button that ends the column instead of below the Active Threads
button. The button and its popover are now wrapped in a container that is
`relative` in icons and `contents` (invisible to layout) in the expanded
densities, so the popover anchors to the attention button itself:
`left-0` on the button's left edge and `top-full` plus `mt-1` directly
below it.

`pnpm exec electron scripts/smoke-approval-modes.cjs --sidebar-attention-only`
runs the leg (`scripts/testing/sidebar-attention-ui-smoke.cjs`) against a
disposable fake-engine server: one bot whose settled reply is never read is
exactly the unread state the cross-bot attention list collects
(`src/components/SidebarBotActivity.tsx`). The leg mounts the real Sidebar
through `scripts/testing/sidebar-attention-preview.tsx` at compact,
comfortable, and icons densities — seeded through `src/lib/sidebar-preferences.ts`
before the first render — opens the menu by its accessible name, and
measures it with `getBoundingClientRect`:

1. In compact the menu is 240px wide (`w-60`), not the 288px that cannot
   fit beside its own anchor.
2. In both expanded densities the menu's left edge sits 16px inside the
   sidebar's left edge — the inset the comfortable sidebar always had.
3. The title text starts inside the window (left edge at or past 0), so the
   clipped "ive Threads" of the field report cannot recur.
4. In icons the menu anchors to the attention button, not the cluster: its
   left edge matches the button's left edge and its top sits 4px (`mt-1`)
   below the button's bottom, with the full 288px (`w-72`) width on screen.

PNG evidence for all three densities lands in `.omb-scratch/verify-evidence/sidebar-attention`.
Pass `--capture-only` alongside the flag to write those PNGs without
asserting, which is how a before/after composite is captured on a pre-fix
tree. The leg also runs in the runner's `--ui` group with the approval ui
fixtures.

The geometry is the renderer's own layout, so no unit test can stand in for
it; the assertions above run headlessly through the same Electron smoke
pattern as the approval fixtures (`scripts/testing/approval-ui-smoke.cjs`).
For the interactive sidebar checks that need a human eye, see the
[sidebar fixture](sidebar.md).
