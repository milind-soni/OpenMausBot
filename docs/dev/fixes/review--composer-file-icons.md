---
status: review
created: 2026-11-19
updated: 2026-11-19
scope: Composer project file icons
owner: Yv
related: []
---

# Match composer file icons to Preview

Use Preview’s icon colors when choosing a project file or folder in a chat or room.

- [?] **Share the icon treatment** — `src/components/ProjectFileIcon.tsx:1`. Use the same folder and previewable file icons in both pickers. Give video, archive, and Affinity files distinctive icons in the composer.
- [?] **Verify folder selection** — `src/components/Composer.tsx:556`. Check the colors and verify that **Use this folder** still inserts the selected path. Studio Preview showed the expected icons and inserted the reference to `./Exports`.
