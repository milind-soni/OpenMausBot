---
name: data-dashboards
description: "Build a fast, good-looking page: a data dashboard, or any page made with show_html (a landing page, a pricing page, a tool), in this chat or at a public link with publish_page. Use when the person asks for a dashboard, charts or KPIs on a page, a page or mock-up to look at, or a data page to share or keep up to date."
---

# Data dashboards and pages

A page made with `show_html` shows in the chat as one card. The person watches it appear, steps back through
its versions, opens it full screen, shares it at a public link, and points at a part to change: their next
message then says what they pointed at (a tag, its text, a CSS selector and a bit of its HTML). Change exactly
that with `update_html`; the same card refreshes.

## Pick the right home

| The person wants | Build |
|---|---|
| A quick answer or one chart | No page. Use the Data tools (`data_sql`, `data_show`) or a markdown table. |
| A small summary to look at here | A chat page (`show_html`) with pre-aggregated rows embedded as CSV. |
| To explore bigger data, or a link to share | Query with the Data tools, export the slice with `data_export` (`format: "parquet"`) into a folder beside `index.html`, show the folder in the chat with `show_html` `path`, and `publish_page` it when the person wants a link: the same card gains it. |
| "Keep it up to date" | The shared page, plus a schedule (`create_trigger`, `when=schedule`) whose instructions re-run the export, set `CONFIG.updated`, and publish the same folder again. Publishing the same path keeps the same link. |

Publish only when the person asks to share. A published page is public: never put secrets, personal details or rows they didn't ask to share in it.

## Start from the template

`dashboard.html` sits next to this guide, in the folder named by this skill's `root`. It is tested in the chat
sandbox and on published pages, in light and dark, at phone and desktop widths. Copy it to your working folder as
`index.html` (a small chat page sends its text as `html`; a folder page is shown with `path`) and change only what the
data needs:

1. `CONFIG`: `dataFile` (`data.parquet` or `data.csv`), `source`, `updated` (when the data was refreshed, ISO time), `currency`.
2. `QUERIES` and the `render…` functions: your columns and your questions. The sample has `date`, `region`, `category`, `product`, `units`, `revenue`.
3. Headings, notes and KPI labels in the HTML.
4. For a chat page, paste the CSV between the `embedded-data` tags.

Keep the rest: the pinned versions (DuckDB-WASM 1.32.0, ECharts 6.1.0, both from cdn.jsdelivr.net; never `@latest`),
the single-threaded DuckDB set up through a blob worker (it needs no special headers, so it runs in the chat sandbox),
the colour tokens, `Intl` formatting, loading and error states, aria labels and the "Show the numbers" tables.
Cut cards rather than adding a fifth chart.

## Data

- **Aggregate first.** Ship the smallest table that answers the questions: one row per day and dimension, not raw events. Do the heavy work with the Data tools, then export.
- **Size.** Keep data at or under about 5 MB (a published page holds 5 MB in all). A chat page is at most 256 KB including the template (about 28 KB), so embed at most about 200 KB of CSV.
- **A page sent as `html` reads embedded CSV only.** A folder page (`show_html` `path`) loads the files beside its
  index.html, Parquet included, so it shows inline exactly as it will publish.
- **Published pages:** prefer Parquet. It is often 10 to 20 times smaller than CSV; DuckDB fetches its Parquet reader (about 0.5 MB) on first load. CSV works too.
- **Types.** Dates as DATE (Parquet) or `YYYY-MM-DD` (CSV). Cast sums and counts to DOUBLE in SQL so they arrive as plain numbers.
- Put filter values into SQL only through the template's `quote()`.
- Check one or two numbers on the page against a direct query before you show it.

## Design

**Charts**
- One question per chart. Make the heading the question ("Which regions sell the most?") and the note under it the answer, computed from the data.
- Pick the form by the job: compare categories with a bar (horizontal and sorted when labels are long); show change over time with a line; show part-to-whole with a stacked bar. A single number is a KPI tile, not a chart. Many categories belong in a table.
- Never: 3D, two y-axes (use two charts, or index both series to 100), pies with more than 3 slices, rainbow colour scales, a number on every point.
- Bars start at zero. Don't cut an axis to make a change look bigger.
- Label directly: values at bar tips, series names at line ends. Use a legend only when direct labels collide.
- Annotate the key point (the peak, a target, the change that matters) on the chart itself.
- Emphasis beats colour: one accent for what matters, grey for the rest (the template greys every region but the selected one).

**Colour**
- One accent colour for the page. The template's 6 categorical colours (separate light and dark sets) were checked for colour-blind separation and at least 3:1 contrast; use them in order.
- Give each category a fixed colour, so filtering never repaints the survivors. Fold anything past 6 into "Other".
- Magnitude: one hue from light to dark. Above/below a baseline: two hues with a grey middle.
- Green and red mean good and bad only, always with ▲ ▼ and words, never colour alone.
- Text uses the ink colours, never a series colour.

**Layout and type**
- Order: title and filters, then 3 to 5 KPI tiles, the main chart full width, 1 or 2 supporting charts, a detail table, and the source line.
- Space on a 4, 8, 12, 16, 24, 32 px scale; align to the grid; hairline grid lines; let whitespace separate cards.
- System font. Tabular numbers in tables and axes; KPI numbers stay proportional.
- Format every number and date with `Intl`: compact for KPIs and axes ($1.2M), full in tables and tooltips.
- Say where the data came from, the dates it covers and when it was refreshed, at the bottom.

**Interaction and access**
- One or two filters, in one row above everything; every KPI, chart and table follows them.
- Tooltips add detail but never hold the only copy of a number: each chart has its table.
- Each chart has an `aria-label` that states what it shows and the takeaway. Native `select` and `details` keep the keyboard working; keep visible focus and text contrast of at least 4.5:1.
- It must work at 360 px wide: one column, nothing scrolls sideways except a wide table inside its own box.
- Show a loading line at start, a plain error if a file or library fails, and dim (don't blank) the cards while filters apply.

## Chat pages

- The chat shows about 640 px of height before scrolling: keep to KPIs, two charts and a short table.
- The chat sets the light or dark theme on the page; the template follows it.
- The template tells you which filters the person picked (`mausbot.setContext`), so a follow-up like "why did it drop?" has context.

## Before you hand it over

- Look at it, light and dark, wide and narrow: labels must not collide or clip.
- First load takes 1 to 3 seconds (DuckDB is about 7 MB, cached afterwards). Never chart more than about 10,000 marks; aggregate in SQL.
- For a shared page, give the link and say how it stays current (the schedule, if any).

## Make a page

**Pick the format**
- `jsx` for anything with state, several sections or repeated parts: a landing or pricing page, a form-like
  tool, a mock-up to iterate on. One file, a default export of the page component.
- `html` for a quick static page, or when you start from `dashboard.html`.

**Building blocks a `jsx` file can import**, nothing else (pinned, loaded from cdn.jsdelivr.net):
- `react` (19.3): hooks and all; `react-dom` for portals.
- `lucide-react` icons: `import { Check, ArrowRight } from "lucide-react"`, sized with `size={16}`.
- `echarts` (6.1), or `import { Chart, useTheme } from "mausbot"`: `<Chart option={…} height={280} label="…" />`
  follows the light or dark theme; `useTheme()` returns `"light"` or `"dark"`.
- `mausbot` also has `send(text)`, `open(url)` and `setContext(text)`, as in the tool's description.
- Tailwind classes (4.3) need no import. `dark:` follows the chat's theme.
TypeScript types are fine. A file that doesn't read, or imports anything else, comes back as an error with the
line: fix it and send the whole file again. Errors while it runs show on the page and reach you with the next message.

**Design**
- Space on 4, 8, 12, 16, 24, 32 and 48 px (Tailwind 1, 2, 3, 4, 6, 8, 12). One container, `max-w-5xl mx-auto px-4`.
- Type: one family; sizes 12, 14, 16, 20, 24, 30, 36; headings `font-semibold tracking-tight`, body `leading-relaxed`.
- Colour: neutral greys (`zinc`) for text and surfaces, one accent for actions and what matters. Give every
  surface and text colour a `dark:` partner (`bg-white dark:bg-zinc-900`, `text-zinc-900 dark:text-zinc-100`).
- Cards: `rounded-2xl border border-zinc-200 dark:border-zinc-800`, a soft shadow at most. Buttons at least 36 px tall.
- It must work at 360 px wide: stack columns (`grid gap-4 sm:grid-cols-3`), nothing scrolls sideways.
- Real words, not lorem ipsum. Give each section a `data-name` and each repeated item a `key`, so a point at it
  names it clearly.
- Keep it under 256 KB: embed data, not libraries.
