---
status: review
created: 2026-11-19
updated: 2026-11-19
scope: visible approval selection feedback
owner: Yv
related: [review--approval-box-consent.md]
---

# Make the selected approval unmistakable

User requested visible feedback after clicking an approval option. Shared task: `f5d68a94-b785-4ec1-b2b9-d5efba60da93`.

- [?] Give the chosen row a persistent accent, checkmark, Selected badge and accessible status; dim alternatives — `src/components/OptionCard.tsx:24`.
- [?] Play a brief click-only pulse/checkmark animation; respect reduced motion and do not animate loaded history — `src/styles.css:98`.
- [?] Normalize lower-case provider answers to visible option labels; verify Allow, Deny and Always allow in live Studio Preview — `src/components/OptionCard.tsx:27`.

## Validation

Production build (including TypeScript checks) passes. Live Studio Preview at 1440×900, isolated fake Buddy on port 8981: clicked Allow, Deny and Always allow in real approval cards. Each showed the chosen row, checkmark, Selected badge and matching accessible status, with disabled faded alternatives. Always allow selection persisted after reload. Preview diagnostics reported no events after reload. No real file copies or model calls occurred.

Allow evidence: `/Users/esoefildine/Documents/Dev/GererBuildStudio/.gbs-preview-evidence/800ff2c9-3bfd-4381-a9bd-6132dd3e5912.png`. Reduced-motion and click-only animation behavior verified in source; no reduced-motion browser emulation was available in Preview. The animation is 260–360ms, and the final selected state remains afterwards.
