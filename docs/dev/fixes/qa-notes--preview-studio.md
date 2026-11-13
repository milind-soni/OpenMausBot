---
status: review
created: 2026-11-12
updated: 2026-11-13
scope: preview-studio-qa
owner: Dell
commit-tested: 0976b17
---

# Preview Studio QA — changes required

Tested the detached dell-qa worktree at 0976b17. Security checks passed; functional review failed on the issues below. No application code was changed. No install, branch switch, or commit was performed in this worktree, as requested. This report is deliberately written here per Yv's latest instruction, superseding the earlier main-checkout destination.

## Isolation and method

- Harness 127.0.0.1:8915, browser UI 127.0.0.1:5215, fixture server 127.0.0.1:8916. No live process was stopped, restarted, or rebound.
- GBS_DATA_DIR=$TMPDIR/gbs-qa-dell-preview and GBS_PROJECTS_FILE=$TMPDIR/gbs-qa-dell-preview/projects.json; a new disposable project registry, configuration, TEST bot, and TEST room. The real ~/.gbs was not read or edited.
- Throwaway Chrome profile controlled through playwright-core from the already installed gerertales dependencies. Browser requests, DOM properties, opaque-frame CDP network events, screenshots, and server SSE were inspected. No real bots received messages.
- For Share to chat, outgoing message POST requests were intercepted and recorded before reaching the harness. This verifies UI capture/payload generation, not a completed model response. Security-probe POST requests were allowed to reach the isolated guard and were refused.
- Electron was NOT TESTED: it cannot be isolated under the supplied constraints. No desktop screenshot/webview claim is made. No physical screen-reader session was run; accessibility findings use focus, roles, names, keyboard, and status DOM checks.

## Check matrix (PASS / FAIL with reproduction steps)

| Check | Result | Steps and observed result |
| --- | --- | --- |
| HTML script, quick panel | PASS | Choose attack.html; its script requests /api/bots, POSTs a probe to the TEST bot messages route, and requests an outside-project file. All fetches reject. CDP attached to the actual opaque iframe confirms 403, 403, 403. |
| HTML script, Preview page | PASS | Repeat in Single mode. Same rejected fetches and three actual 403 responses; no response data accessible. |
| HTML script, direct file tab | PASS | Open the harness file URL directly. Script-driven bot GET, bot-message POST, traversal GET, and symlink GET each return 403 in CDP. |
| SVG embedded script | PASS | Choose attack.svg in panel and page: it is rendered as an image, so embedded script does not execute. Open the same SVG file URL directly to exercise script execution: bot GET/POST and outside-file GETs all return 403. |
| No injected bot message/data | PASS | Read only the isolated fleet after the probes. Zero messages contain SECURITY PROBE. Fetch promises reject rather than exposing bot JSON or outside-file contents. |
| Traversal, both file-route forms | PASS | Request query path ../outside.html and path-route encoded %2e%2e%2foutside.html: 403. Absolute /etc/passwd: 403. Double-encoded traversal is treated as a missing literal path (404), never a leak. |
| Symlink containment | PASS | Create escape.html pointing to a sibling outside.html and escape-dir pointing outside the project. File symlink, directory symlink, and missing child under that directory are refused with 403. Repeat both query/path URL forms for existing escapes. |
| Unsupported type | PASS | Request unsupported.txt through the file route: 415, no content returned. Picker omits unsupported types. User-facing error recovery for an unsupported drag/drop was not exercised. |
| Panel size groups | PASS | In bot chat select all 8 presets: three phones, two tablets, Laptop, Desktop, Wide Desktop. Selected preset and iframe title/dimensions follow the choice. |
| Custom bounds | PASS | Choose Custom, enter width 100 and height 5000. UI clamps to 240 and 3840. |
| Rotate and zoom | PASS | Rotate Wide Desktop: title changes between 1920x1080 and 1080x1920. At 50/75/100%, scaled wrappers measure 960x540, 1440x810, 1920x1080; Fit computes an available-stage scale. |
| Room quick panel | PASS | Create TEST QA room, open panel, choose Desktop, rotate to 900x1440, cycle Fit/50/75/100, reload. Title/dimensions/zoom follow controls; reload appends its nonce. |
| Panel/page carry-over | PASS | From bot panel open project/index.html with Custom 240x3840, then Open in Preview page. Persisted page source, dimensions, rotation, and zoom match. |
| Narrow overlay placement | PASS | At 1024px the visible drawer is right-aligned (x=604, width=420). It closes using its close control. State continuity and hidden frames FAIL separately. |
| Responsive state continuity | FAIL | Wide panel Laptop becomes iPhone 15/16 after resize to 1024px; 2 iframe elements remain mounted. See responsive bug below. |
| Browser Back/Forward | FAIL | Open local fixture, follow Second inside the iframe. Frame URL changes to /second but Back and Forward remain disabled. Reload works. |
| Single sizes/shortcuts | PASS | Select a size; focus a non-input control and press ] then R then [. Next/previous preset and rotation change. Type r[] in the source input: preset and rotation stay unchanged. |
| Single layout | PASS | Inspect and screenshot 1024, 1280, 1920px widths. No document horizontal overflow; source controls, size choices, rotate, and zoom remain available. Toolbar wraps to more rows than the spec illustration. |
| Loaded status pill/announcement | FAIL | Load a successful HTML/Markdown source: no Preview loaded status is exposed; frameStatus only drives the reload spinner. Included in accessibility bug. |
| Canvas Single/Canvas switch | PASS | Switch using the tabs; selected state and rendered mode change. Focus the per-artboard Single control and press Enter: Single mode opens. |
| Canvas zoom/fit/pan | PASS | Use +/- buttons, 100%, Fit all, Ctrl+scroll, Space-drag. Transform changes by 1.25/0.8, reaches k=1, fits all, zooms at pointer, and pans by the drag delta. |
| Canvas 6-frame cap | PASS | All sizes selects 8 artboards. DOM contains exactly 6 iframe elements and 2 snapshot/placeholder cards. Hover a placeholder: still 6 iframe elements. |
| Canvas labels/navigation at fit | FAIL | At 1280px/8 sizes/Fit all, header bars retain 12px text but overlap each other, obscuring names and controls. Mouse activation of an obscured Single control fails; keyboard activation succeeds. |
| Public and local sources | PASS | example.com embeds in a browser frame; a separate-port local fixture loads after the Local or private address / Load preview confirmation. Local fixture body is readable after confirmation. |
| Site denying embedding | FAIL | Fixture with X-Frame-Options: DENY leaves a blank frame after >15 seconds; no blocked-site copy, Open in new tab, or Retry. |
| Standalone Markdown/PNG/SVG | PASS | Picker loads sample.md as formatted content, sample.png with naturalWidth=1, sample.svg with naturalWidth=100. |
| HTML relative assets | FAIL | index.html with relative CSS/image shows neither; ORB blocks the subresource requests, CSS route also rejects its type. |
| PDF | FAIL | Valid PDF renders in a direct file tab with text and page 1/1, but the browser preview iframe shows a broken-document icon. |
| Auto-refresh enabled/disabled | PASS | Edit sample.md with refresh on: a new file GET with reload nonce appears and marker becomes visible. Disable refresh, append another marker: no reload request and new marker stays absent. |
| Watcher release on close | PASS | Observe /api/events. Editing second.html while room preview is open emits one preview.reload. Close panel, edit again: zero preview.reload events. Disabled watcher requests also appear on panel/page unmount. |
| Share image/Markdown transport | PASS | Send current-size PNG/Markdown shares to TEST target with message route intercepted. Each produces an image/png data-URL attachment and a caption naming the source. No model turn started. |
| Share fidelity/fallback | FAIL | Browser HTML share lacks desktop fallback banner and generates a placeholder PNG, not the visible page. Markdown capture paints raw source syntax. See share bug. |
| Keyboard/modal basics | FAIL | File picker and Share dialog keep focus on the underlying trigger and ignore Escape; Preview page Escape does not return to chat. Names on key toolbar controls and Single/Canvas tabs exist. |
| Plain words/readable surfaces | FAIL | Relative-file errors include technical "Symlink" wording at the API layer; blocked errors are not presented at all, and the size dropdown is transparent over content. Main buttons generally use plain action labels. The unsupported-drag error surface was not tested. |
| Typecheck | PASS | pnpm typecheck, exit 0. |
| Tests | PASS | pnpm test: 43 files, 341 tests passed. |
| Production build | PASS | pnpm build, exit 0. Existing >500kB chunk advisory remains. |

## Necessary fixes and shared bugs

### High: Project HTML cannot load relative CSS or images

- Result: FAIL. Shared bug: e5be992f-9150-443f-a2c1-198304a0a985; tags gererbuildstudio, severity-high.
- Reproduction / expected fix: Register a disposable project containing index.html with <link rel="stylesheet" href="style.css"> and <img src="sample.png">. Open index.html in quick preview or Single mode. Expected: styled page and image. Actual: stylesheet and image requests fail with ERR_BLOCKED_BY_ORB; computed background stays transparent and image.naturalWidth is 0. The direct trusted CSS route also returns 415. Standalone PNG preview works. Preserve opaque-origin security while enabling safe project subresources.

### High: PDF previews fail inside browser frames

- Result: FAIL. Shared bug: 547ac215-8ffb-4eac-be1e-9db3410ae22a; tags gererbuildstudio, severity-high.
- Reproduction / expected fix: Choose a valid one-page sample.pdf from the project picker. Actual: gray broken-document frame; iframe has sandbox="allow-scripts allow-forms". Open the exact file route directly in a tab: the PDF viewer renders its text and page 1/1 correctly. Expected: PDFs also render in panel/Single mode after the security fix. Do not restore same-origin access for scriptable HTML/SVG to solve this.

### High: Browser sharing sends fabricated page screenshots without fallback notice

- Result: FAIL. Shared bug: b0a8734e-3e1d-42b0-a42b-a810f8bf7b5c; tags gererbuildstudio, severity-high.
- Reproduction / expected fix: In Single mode preview second.html containing <h1>Second page</h1>, open Share to chat, and send to a TEST bot. Actual: no desktop-app fallback banner. The outgoing PNG contains a dark template saying "Preview snapshot — project/second.html", with no page content. Markdown sharing similarly paints raw # and ** syntax instead of the rendered document. PNG/Markdown payload creation succeeds, but these are not faithful screenshots. Expected: truthful link/note fallback for browser page captures and faithful image/Markdown sharing. Reproduced with outgoing message requests intercepted before any model turn.

### Medium: Embedding denial leaves a blank frame without recovery actions

- Result: FAIL. Shared bug: 08c270e2-2b36-4949-8661-598bb4ac52f0; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: Serve a local HTML page on a separate port with X-Frame-Options: DENY. Enter its address, confirm with Load preview, and wait more than 15 seconds. Actual: blank blocked browser frame, no explanatory blocked state, Open in new tab, or Retry action. Expected: the specified plain-language blocked-site state and both recovery actions.

### Medium: Quick preview loses size state across the drawer breakpoint and mounts hidden frames

- Result: FAIL. Shared bug: fae0fe45-78da-4b27-b197-3b894aafdd83; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: At 1280px open a bot preview with attack.html and choose Laptop (1280x800). Resize to 1024px. Actual: visible drawer returns to iPhone 15/16 (393x852); two live iframe elements remain mounted, including the CSS-hidden panel. Inline and drawer instances have separate state and compete under the same quick-preview-panel watcher clientId. Expected: one coherent source/size/zoom state across 1180px and no unnecessary hidden live preview.

### Medium: Canvas labels overlap and hide controls when fitted

- Result: FAIL. Shared bug: 2be95016-d1cd-4707-ad21-c70ed917f353; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: Open an HTML file, switch to Canvas, choose All sizes, then Fit all at 1280px. Actual: fixed-screen-size label bars overlap neighboring boards so labels are truncated/covered and focus controls are obscured. A forced mouse click on the iPhone focus control did not open Single mode; focusing that control and pressing Enter did. Expected: readable labels and usable artboard-to-Single navigation at fit zoom. Six-frame cap still passes.

### Medium: Preview dialogs ignore Escape and leave focus outside; loaded status is missing

- Result: FAIL. Shared bug: abe7fe48-c452-46f9-8255-36bb06b1485d; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: Open the project-file picker from Preview. Actual focus remains on the underlying choose-file trigger; Escape leaves the aria-modal dialog open. Share to chat also leaves focus outside and ignores Escape. With dialogs closed, Escape does not return from Preview to chat. After a successful load, no Preview loaded status pill/announcement appears (only the Canvas frame-count status exists). Expected: focus entry/trap/return, Escape handling per spec section 8, and meaningful loading/loaded/error announcements.

### Medium: Browser preview Back and Forward stay disabled after navigation

- Result: FAIL. Shared bug: 8387c080-5615-4b26-a224-763c1b616648; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: Preview a local HTML site containing a link to /second. Click the link inside the browser iframe, confirming its URL changes to /second. Actual: Back and Forward remain disabled; browser handlers only implement Electron webview navigation. Expected: usable browser history controls, or an explicit supported alternative. Reload works.

### Medium: Quick preview size menu has a transparent background and becomes unreadable

- Result: FAIL. Shared bug: e3c9e7ce-f084-47fa-a3e3-cc3ea8e66b03; tags gererbuildstudio, severity-medium.
- Reproduction / expected fix: In bot chat or room preview, load a white HTML page and open Choose preview size. Actual: computed dropdown background is rgba(0,0,0,0); white page content shows through and nearly erases the pale size labels. The same bg-surface token is used on modal surfaces. Expected: opaque menu/dialog surfaces with readable contrast.

## Repeatable fixture recipe

Register a disposable folder containing index.html, second.html, style.css, sample.png, sample.svg, sample.md, sample.pdf, and unsupported.txt. index.html should link style.css and sample.png by relative path. sample.md should include a heading and bold text. Use a known-valid one-page PDF; verify it also opens directly. Place outside.html next to the project folder with an unmistakable test-only marker. Add a file symlink and a directory symlink pointing outside the project.

For attack.html, run fetch('/api/bots'), a text/plain POST containing JSON {text:'SECURITY PROBE MUST NEVER SEND'} to /api/bots/TEST_BOT_ID/messages, and fetches to both outside-file route variants. Wrap promises with catches to observe refusal. Repeat the script inside SVG CDATA. Use only the disposable bot ID. In the SVG image renderer scripts should stay inert; direct SVG navigation is essential to exercise the server CSP.

Both file URL forms were exercised: /api/preview/file?projectId=ID&path=PATH and /api/preview/file/ID/PATH. Inspect actual HTTP 403s through CDP on the opaque iframe target; normal page response events omit CORS-denied responses.

## Cleanup and limits

All QA-owned browser, fixture-server, Vite, and harness processes are to be stopped and the throwaway directory removed after recording the result. Only this report is retained in the worktree. No code fixes, installation, branch changes, commits, pushes, or real-bot messages. Electron remains unverified. Share transport was intercepted, so no completed provider turn is claimed. Security PASS applies to the exercised routes and browser attacks, not a proof against every possible sandbox escape.


## Retest at c1cc144

**Verdict: CHANGES REQUIRED.** Seven original findings pass the browser retest; two remain partial (Markdown heading fidelity and dialog focus return). An additional all-eight-size sharing failure is filed. Security smoke passes. This is a browser verdict, not native Electron approval.

### Scope and isolation

- Tested source: c1cc144c8c5d3fb3263aa4df474de27e6392ef34 in this detached dell-preview-final checkout. Prior broader browser work in this same review was performed on November 12; a fresh full nine-finding browser/HTTP confirmation ran November 13 after temporary processes/data had disappeared.
- Fresh harness/UI/blocked-site fixture ports: 8927 / 5227 / 8928. Throwaway Chrome persistent profile, explicit GBS_DATA_DIR and GBS_PROJECTS_FILE, inert unknown driver. Prior run used 8925 / 5225 / 8926 / 9325. No main/active worktree changes, real bot messages, paid model turns, merges or pushes.
- Message POSTs were intercepted only to inspect sharing payloads. That route interception was explicitly removed before final security POST checks. An initial mocked 200 was identified as a test-harness artifact and was not accepted as security evidence; the final real guard produced two 403s.

### All nine original findings

| Finding | Result | Actual evidence |
| --- | --- | --- |
| e5be992f | PASS | Relative CSS, image and module load in an opaque HTML frame: background rgb(1,123,77), image width 64, module marker present. |
| 547ac215 | PASS | Valid one-page PDF visibly renders text and native controls in the browser preview; PDF alone omits iframe sandbox. HTML/SVG isolation remains. |
| b0a8734e | PARTIAL | Page/PDF shares show the desktop notice and send honest links with zero fabricated attachments. PNG capture pixels and bold/table Markdown capture pass; heading styling is still lost. Residual bug 9d4f135b-b093-4c2f-8b97-6b1d4fde1826. |
| 08c270e2 | PASS | X-Frame-Options DENY fixture exposes persistent recovery; Preview blank? opens stable recovery with Open in new tab / Retry. Retry remains usable. |
| fae0fe45 | PASS | Bot panel preserves source/size/rotation/zoom across 1024/1179/1180/1280/1920 with one frame. Room resize/rotate/zoom also pass. |
| 2be95016 | PASS | Eight Canvas header rectangles do not overlap; labels remain at 12px. Real mouse click opens the requested Single view. Six-live-frame cap and promotion pass. |
| abe7fe48 | PARTIAL | Focus entry, Tab/Shift+Tab traps, Escape dismissal, Preview-page Escape and loaded status pass. Both picker and Share close onto BODY instead of restoring the trigger. |
| 8387c080 | PASS (browser alternative) | Dead browser Back/Forward buttons are replaced by visible "History needs the desktop app" wording; Reload and Open in new tab remain. Native history is unverified. |
| e3c9e7ce | PASS | Size menu and modal surfaces are opaque rgb(17,17,17), readable over white HTML. |

### Remaining fixes and reproduction

1. **Medium — dialog focus return, original abe7fe48 (returned to doing).** Explicitly focus Choose a file from a project, open the picker, press Escape, wait for its removal, then inspect activeElement: BODY. Repeat with Share to chat: same result. Entry, trapping and dismissal now work; return-to-trigger does not. Both controls use autoFocus before the effect records previousFocus, which appears to capture the newly mounted modal child rather than its invoker. Fix the trigger restoration for both dialogs.
2. **Medium — Markdown heading fidelity, new 9d4f135b-b093-4c2f-8b97-6b1d4fde1826; b0a8734e remains partial.** Residual of b0a8734e at c1cc144. Preview sample.md containing # Markdown Heading, a paragraph with **bold**, and a table. Share the current size and inspect its PNG. Actual: bold/table render, but the heading becomes plain normal-weight text. Live heading is a DIV with font-semibold (computed 600); the exported SVG/raster has the same class without its stylesheet, so it renders at weight 400. captureMarkdown adds h1/h2 CSS but ChatMarkdown emits DIVs for headings. Current Nov 13 PNG visually reconfirms normal-weight heading; the prior same-hash SVG computed-style check measured 600 -> 400. Expected: retain rendered heading hierarchy/weight in the real capture. No fabricated page screenshot remains; HTML/PDF link fallback now passes.
3. **Medium — eight-size image/Markdown sharing, new 8fc3c43f-7d06-47d0-9c46-0068df5550b3.** At c1cc144 in browser Preview Studio, choose a project Markdown or PNG file, switch to Canvas, choose All sizes (8), and open Share to chat. Select All selected sizes (8 screenshots) and a TEST target, then Send. Actual: no message is sent and the modal reports "Page screenshots need the desktop app. Share the preview link instead." Current Nov 13 confirmation reproduces Markdown; prior same-hash browser run also reproduces PNG. Single-size captures work. Six artboards are live and the other two are placeholders; the capture loop calls unloaded/non-live frame handles without promoting them. Expected: capture all selected sizes while respecting the six-live-frame cap, or explicitly disable unsupported capture with accurate guidance before submit. This is not a page/PDF capture and the desktop-only page error is misleading.

### Security smoke

- **PASS:** actual opaque HTML-frame GET /api/bots and text/plain POST /api/bots/TEST_ID/messages both reject; CDP on the actual opaque frame records **403, 403**. No SECURITY_PROBE message is appended. Prior same-hash panel/direct HTML checks also passed.
- **PASS:** directly opened SVG executes its embedded GET probes to /api/bots and /api/config; both produce 403. SVGs rendered as images remain inert.
- **PASS, direct harness and actual Vite proxy:** raw HTTP preserves literal .., %2e%2e, .%2E and %2e. segments under a capability asset prefix. Four-level traversal normalizing to /api/bots is refused with 403. This checks the ab0f162 regression without fetch pre-normalization.
- **PASS, both endpoints:** file symlink, directory symlink and encoded outside-project traversal are refused with 403. Valid opaque capability CSS reads still return 200. Prior same-hash tests additionally refused wrong capabilities, asset writes, hostile Host values and normal cross-origin API reads.
- HTML/SVG retain CSP sandbox without allow-same-origin; PDF remains the native-viewer exception. Security PASS applies to these exercised routes/attacks, not a universal sandbox guarantee.

### Additional regressions and validation

- Bot/room controls, all eight presets, Custom bounds 240–3840, rotate, Fit/50/75/100, panel-to-page carry-over, Single shortcuts with typing guard, and 1024/1280/1920 layouts pass.
- Canvas fit/zoom, Ctrl-scroll, Space-drag, six-frame cap and placeholder promotion pass. Staggered headers have zero pairwise overlap; the UI may still need panning at extreme zoom/size combinations.
- Panel link staging preserves the existing composer draft and labels the link honestly. Single-size image pixels match the fixture. Formatted Markdown bold/table content passes; heading failure is recorded above.
- Public site, local-page confirmation, auto-refresh on/off and watcher release on close pass in the broader same-hash run.
- **November 13 focused checks:** 18 tests pass in 4 discovered files (request guard, dev proxy guard, preview sizes and preview sharing). A supplied nonexistent previewFiles test path did not add a test file; no coverage from that path is claimed.
- **November 12 at the same exact source:** typecheck, full suite **349/349 tests in 45 files**, and production build pass, with the existing large-chunk advisory. No application changes were made between those checks and this confirmation.

### Desktop limits and cleanup

Actual Electron was not launched: native isolation from the live app/profile was not established. Native webview capture/history, Electron window integration and OS-specific behavior remain unverified; browser PDF native-viewer rendering is not an Electron test. Focus/roles/labels were inspected in Chrome; no physical screen reader was run.

Both disposable environments have stopped. Fresh-run finally cleanup closed Chrome and owned harness/Vite/fixture processes and deleted the profile/project directory; port checks verify cleanup before delivery. Only this notes file is retained in this checkout; temporary screenshots and test scripts were removed after inspection. The notes-only local commit does not change application code.

## Final gate at 2528492

Independent Dell retest, 2026-11-13. **PASS / GO for the requested browser merge gate.** Tested exact detached `2528492` in `dell-preview-final`, including Z's `7492797` and SoSo's `8a994c6` / `776b9f0`. No product code changed. No new bugs found.

### Isolation and method

- Disposable harness/Vite listeners allocated by the OS, fresh headless real Chrome contexts, temporary project registry, `GBS_DATA_DIR`, and throwaway host-home fixture. `os.homedir()` was overridden in a child-only preload; no real home configuration was read or changed. No install, paid model turns, main checkout changes, merges or pushes.
- Ran the retained `scripts/testing/preview-share-regression.mjs` logic through a temporary QA copy with the isolated-home adjustment. Independently added focus, single-image, link-only, actual opaque-origin, raw-path security and decoded-pixel assertions. Outgoing sharing POSTs were intercepted before delivery; this verifies payload/capture generation rather than a model response. Removed all browser route mocks before actual security requests.
- Used the source Markdown heading, subheading, bold paragraph and four-cell table. Extended the image fixture to a known 160x120 green/red pattern for pixel validation, beyond the retained one-pixel fixture. This avoids mistaking a tiny, naturally centered source image for an empty capture.

### Per-item results and reproduction

| Item | Verdict | Steps and actual evidence |
|---|---|---|
| abe7fe48 — picker focus | PASS | In Preview Single, explicitly focus Choose a file from a project and open it. Focus enters Filter project files. Tab from the last control and Shift+Tab from the first remain inside the dialog. Close once with Escape, reopen and close with Close file picker. Both closures restore activeElement to the original choose-file trigger. |
| abe7fe48 — Share focus and status | PASS | Explicitly focus Share to chat, open it: focus enters Send to. Repeat both trap directions. Escape and Close modal each restore the Share trigger, rather than BODY. The loaded preview still exposes a role=status containing Loaded. |
| 9d4f135b and b0a8734e residual — Markdown fidelity | PASS | Preview sample.md in Single; share current size. The standalone export heading has the same computed 600 weight and 16px size as the live heading. Bold remains at least 600; all four table cells are present; neither raw # heading nor **bold** syntax appears. Decoded PNG was visually inspected: heading/subheading, bold paragraph and table are rendered. All eight source-based Markdown exports also contain the rendered heading/bold text and real text pixels. |
| 8fc3c43f — eight Markdown sizes | PASS | Canvas, all eight presets, Share to chat, All selected sizes. One intercepted send contains exactly eight PNG attachments in preset order with correct bounded dimensions and size labels. Each PNG decodes and contains real text pixels; each exported SVG contains rendered Markdown. DOM mutation observation records at most six live artboard cards, no iframe/webview additions, and no retained temporary capture stages. |
| 8fc3c43f — eight PNG sizes | PASS | Repeat with the known green/red PNG. One intercepted send contains eight correctly sized PNGs. Every decoded capture contains the colored source pixels (19,200 colored pixels for the first seven; 13,400 after bounded scaling on the eighth). Maximum six live cards; zero additional iframe/webviews and zero retained stages. |
| 8fc3c43f — accurate atomic failure | PASS | Independently for Markdown and PNG, make canvas.toDataURL throw on the eighth capture, after seven successful captures. Modal remains open, error names the eighth preset and the underlying QA failure, and no send occurs. No misleading desktop-only advice and no partial attachment dispatch. Temporary stages are released. |
| Single-size capture regression | PASS | Single Markdown produces one real PNG with preserved typography; Single PNG produces one PNG attachment. |
| HTML/PDF browser sharing regression | PASS | Open project HTML, then project PDF, and Share to chat. Both show the desktop-app notice and send a source link with zero screenshot attachments. This is a link-sharing check; native PDF rendering was not requalified in this gate. |
| Actual opaque-origin API smoke | PASS | Directly navigate fresh Chrome tabs to scripted project HTML on the isolated harness and Vite origins. CSP creates an opaque origin. Script fetches GET /api/bots and text/plain POST /api/bots/TEST_ID/messages. CDP response extra-info records actual 403/403 on each origin; JavaScript receives only rejected fetches. Test bot state contains no SECURITY_PROBE message. No route mocks are installed for these requests. |
| Encoded dot-segment bypass and valid asset | PASS | Against both direct harness and actual Vite proxy, raw HTTP requests preserve four parent segments under a valid capability asset prefix, using literal .., %2e%2e, .%2E and %2e. variants, normalizing toward /api/bots. With Origin:null and Sec-Fetch-Site:cross-site, all eight requests return 403. A valid capability PNG asset still returns 200 from each endpoint. Security smoke used ports 50930/50931. |

### Validation, limits and cleanup

- **PASS:** `pnpm typecheck`; `pnpm test` — **424/424 tests across 51 files**; `pnpm build`. Existing >500KB chunk advisory remains.
- An initial security observer used Network.responseReceived, which does not expose these CORS-refused responses; it timed out and was not accepted as evidence. The separate successful security run used Network.responseReceivedExtraInfo to verify the real HTTP status codes.
- Actual native Electron was not launched because safe isolation from the running desktop app has not been established. Native webview capture, OS integration and a physical screen reader remain unverified. This gate approves the requested browser repairs and security smoke; it does not claim new native coverage or re-run every original Preview scenario.
- All owned Chrome/harness/Vite processes exited; temporary profiles, fixtures, scripts and screenshots were removed. No live app data was touched. Notes only are committed locally; nothing pushed.
