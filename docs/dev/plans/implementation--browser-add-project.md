# Browser Add Project flow

The browser Projects screen currently reads `/api/projects` but hides every add control because `window.gbs.projects` exists only in Electron. Add host-side project operations so the browser can register an existing absolute folder, create a child folder, or clone GitHub into an absolute destination. Keep Electron's native directory picker.

1. Reuse the validated `ProjectService` for HTTP mutations and store records in the same registry selected by `server/projects.ts`.
2. Adapt the modal for browser use: typed host paths replace native folder pickers. Keep errors visible and refresh the project list after success.
3. Test the HTTP routes against the isolated server harness, then run type-check, tests, and build. Commit the scoped fix locally.

The server already executes user-directed file and shell operations; these routes use its existing same-origin request guard. Path validation, duplicate detection, and GitHub URL validation remain in `ProjectService`.
