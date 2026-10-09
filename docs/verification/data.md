# Data viewer with real DuckDB

Launch the full app with a disposable server, home, browser session and real
DuckDB database:

```sh
node --experimental-strip-types scripts/verify-data.ts
```

The fixture generates 100,000 synthetic orders, Unicode and null-value JSON,
a derived regional summary, two charts, and 20 results. It loads and shows them
through the bot's capability-protected Data tools. No real provider, account,
credentials, user files or external datasets are used. The script asserts
loading, describing, SQL, chart creation, page boundaries, filtering, sorting,
CSV export and persistence across a server restart before printing its handle.

Open the printed `previewUrl` for manual computer-use checks. Select **Data
review** and the **Data** tab if needed. The printed `ui` path also works with
the shared [chat UI controls](chat-ui.md):

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
pnpm control:omb ui snapshot --ui "$H" --interactive
pnpm control:omb ui click --ui "$H" --name History
pnpm control:omb ui snapshot --ui "$H" --interactive
# Use the snapshot's menuitemradio reference for "Revenue by region":
pnpm control:omb ui click --ui "$H" --ref @eN
pnpm control:omb ui click --ui "$H" --name Table
pnpm control:omb ui click --ui "$H" --name Chart
pnpm control:omb ui click --ui "$H" --name "Enter fullscreen"
pnpm control:omb ui screenshot --ui "$H" --out .omb-scratch/data-fullscreen.png
pnpm control:omb ui click --ui "$H" --name "Exit fullscreen"
```

Expected: one active result fills the viewer without a title/header above it.
The row/column count and **Export**, **History**, and fullscreen controls share
its footer; chart results also put **Chart**/**Table** there. **History** selects
an earlier result, and **Latest result** resumes following arriving results. A prefilled
SQL box stays in a bottom dock, with plain table names and row counts nearby.
CodeMirror colours SQL keywords (including DuckDB clauses), strings and numbers
without adding an editor toolbar, Run button or typing delay.
Drag the separator above SQL up or down to resize it, or focus the separator
and use the arrow keys. The result fills the remaining space above it; resizing
keeps the draft and does not execute SQL. **Enter fullscreen** expands the
same workspace, and **Exit fullscreen** restores its panel width and query. Every edit
updates the selected result immediately, without a Run button; an incomplete
or invalid query keeps the last good preview visible. Chart results can
switch between **Chart** and **Table** without mounting the rest of history.

## Automated renderer regression

```sh
node --experimental-strip-types scripts/verify-data.ts --check
pnpm exec vitest run server/data/data.e2e.test.ts scripts/testing/verification-docs.test.ts
```

The asserted browser run uses the same pinned agent-browser and Chrome as
`control-omb ui`; on the first run it may install them into the checkout's
ignored verification-tools directory. It checks a bounded table DOM before and
after scrolling to row 100,000, one mounted result despite 20 history entries,
history selection and unclipped menu bounds, Chart/Table switching, always-visible
SQL docked below the result, the shared counts/control footer, table fill,
chart proportions and visible axes, native fullscreen
expansion and restoration, and a new result delivered through the real event
stream. It also opens an older
chart through its persisted in-chat result receipt and checks that a consumed
receipt does not override a later Browser selection after closing and reopening
the panel. The receipt expands to show the bot's recorded SQL, collapses again,
and keeps that original SQL after the viewer query is edited.

Resize checks use real pointer drags and keyboard arrows with tables and charts,
including minimum/maximum bounds, a narrow 360px panel in a short window, and
fullscreen. They assert that the SQL draft is unchanged, resizing sends no SQL
requests, table rows remain virtualized, chart axes fit, footer menus remain
inside the output, and wrapped table references do not clip the SQL input.

AG Grid checks add a 100,000-row, 120-column result with punctuation in column
names, a BIGINT beyond JavaScript's exact integer range, nulls, booleans, and
Unicode. They verify native column resizing, server-side ascending/descending
sort and global/column-scoped filtering, empty results and recovery from one injected page
response failure, and bounded row and column DOM after scrolling to the bottom
right corner. Keyboard copy captures a selected row as TSV; the existing
**Export → Copy page as Markdown** action copies visible rows. Clipboard writes
are captured inside the disposable browser, never sent to the user's clipboard.
There is no extra copy button above the grid. A compact **Filter** button opens
a searchable column list, then a Contains field; **All columns** retains global
search. The fixture checks searching that list, Escape/focus restoration, a
numeric-column match on the last row, and that one column cannot match another.

Chat checks select an older result, manually change its SQL, then send natural
language requests through the real composer. An isolated loopback provider calls
the actual `data_describe` and `data_show` tools to filter that result in place.
A second request repairs an unfinished SQL draft. Both assert the selected
result, its SQL editor and rows update together without adding a new card or
showing internal context in the transcript. This tests the complete chat/tool
transport with scripted responses, not a live model's reasoning. Evidence is
saved as `.data-chat.json` and `.data-chat.png` beside the server log.

Live SQL checks type into the real CodeMirror textbox: invalid-to-valid SQL preserves the
last good preview without moving or resizing the SQL box, a single character
changes the row count, a newer edit wins while an older error response is held,
and editing a chart keeps its chart type
and correct reduced rows. The delayed-response check controls HTTP delivery
order; server tests cover stale SQL materialization. A second response gate
keeps every replacement chart page pending, including intermediate valid queries
while typing: the old rendered chart must remain
visible and the SQL box must keep its position, then the plot must change when
the new rows are released. Deliberate invalid queries
may produce HTTP 400/404/409/422 console entries; other browser errors fail the check.
JSON measurements and screenshots stay beside the printed server log, outside
the disposable home.

Ctrl-C stops a manual fixture. The automated run closes itself. Both stop only
their owned browser and servers and remove their temporary synthetic data;
the server log and automated evidence remain.

This proves the full web renderer and real local DuckDB workflows. It does not
prove native Electron packaging, third-party database credentials, remote URL
availability, or production query capacity. The row-count check measures DOM
virtualization, not an end-to-end performance benchmark.

## Current limits

The legacy companion connection does not expose the Data routes; its chat
receipt explains that the result must be opened in the workspace app.
**Export** writes to the workspace host, not a browser download. Workspace
backups currently omit the DuckDB database, so exports must be kept separately
if the loaded and derived data needs to survive a workspace restore.
