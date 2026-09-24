# Issue 1706 — iOS bot messages render GFM tables and task lists

## Purpose

A bot reply on the phone should show a table as a table and a task item as a
checkbox. Today a pipe table mixed with prose stays source text, and a message
whose every non-empty line is a pipe row becomes the SQL result card. Task
markers stay brackets inside a bullet.

This is not a promise that the phone bubble matches the desktop bubble pixel
for pixel. Desktop table cells are start-aligned. The phone applies the
delimiter's alignment to the header and the body. Images, mentions, thread
links, syntax highlighting, spoilers, and raw HTML stay out.

## Scope

Settled bot and room text, the streaming bubble, and a Markdown file preview
all use `MarkdownText`. Room text uses the same `TextBubble` as a 1:1 bot
chat, so a whole-message table there is the same bubble table. There is no
switch that turns tables or tasks off for one of those surfaces.

In scope:

- Tables at the top level, indented by 0 to 3 spaces, with or without outer
  pipes on each row, including a header and delimiter with no body rows, and
  including a single column.
- A table immediately after prose on the next line, with no blank line.
- A one-line weld, only under the conditions in acceptance 6.
- A delimiter row shorter or longer than the header. A delimiter row contains
  at least one `|`.
- Column alignment from the delimiter, the same on the header and the body.
  Plain dashes, including dashes synthesized to pad a short delimiter, are
  leading alignment. There is no separate "none".
- Task items on `-`, `*`, `+`, `1. `, and `1) `, including nested items. An
  ordered task keeps its number next to the checkbox.
- Walkie speech for the samples in acceptance 11. `speakable` may call
  `Markdown.blocks` or scan lines itself. The spoken strings are the contract.

## Non-scope

- The person's own messages stay literal, including pipe tables and task syntax.
- Images, mentions, thread-ref chips, syntax highlighting, spoilers, raw HTML.
- A table nested in a list item or a blockquote, and a task nested in a
  blockquote. Those lines stay visible as list text, quote text, or a
  paragraph. They are not dropped. A task indented under another list item
  is still a task.
- A pipe row indented by 4 or more spaces, or by a tab. It stays source text.
  That is an accepted loss relative to today's SQL card, which trims before it
  looks. A top-level row indented by 1 to 3 spaces is still a table.
- Tappable checkboxes. The marker is not a button.
- Copy and Select Text. They keep copying `attachedContent.text` (the source,
  minus transport tags), not the rendered label.
- Copy CSV, the "DATA TABLE" title, and the "N rows" caption. Losing them on
  a whole-message pipe table is accepted.
- Message-search snippets and the held-send preview. They stay raw source.
- The roster line. It may show the source of the newest message. That is not
  a failure of this issue.
- Desktop `repairMarkdownTables` and the desktop renderer. Where this document
  differs, the sentence here wins.
- Android behavior and Android tests. The same gap is #1707. Kotlin comments
  that cite `SQLResultTableView.swift` or describe that card as the live iOS
  behavior must be updated so they describe Android's own card and point at
  #1707. That includes `Transcript.kt`, `TranscriptTest.kt`,
  `ExecutionFeedbackTest.kt`, `TableReadingOrderTest.kt`, and
  `TranscriptCardViews.kt`, and any other Kotlin comment that names
  `SQLResultTableView.swift`.

## Acceptance

1. **Prose around a table.** Both of these show `Lead-in prose`, header cells
   `A` and `B`, body cells `1` and `2`, then `After`. `Lead-in prose` is not
   a cell.

   - `Lead-in prose\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter`
   - `Lead-in prose\n| A | B | |---|---| | 1 | 2 |\n\nAfter`

2. **Not the SQL card.** A bot message that is only the pipe table below is
   that table inside the normal bubble. It does not show `DATA TABLE`,
   `Copy CSV`, or a label containing `rows`. Deleting `parsedTable`, `tableCells`,
   `isTableSeparator`, and `SQLResultTableView` is required, and it is not
   the test. The preview UI test below fails if that branch is put back.
   `swift test` does not compile `ios/App`.

   ```text
   | Alpha | Beta |
   | --- | --- |
   | one | WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW |
   ```

3. **Empty cells, a short tail, and an extra cell.**

   - `| A | B | |---|---| | | 2 | | | 4 |` is two columns and two body rows:
     empty / `2`, and empty / `4`. The empty segment that only joins two
     welded rows is the row break.
   - `| A | B | |---|---| | 1 |` is one body row: `1` and an empty second cell.
   - Multiline extra cell: `| A | B |\n| --- | --- |\n| 1 | 2 | 3 |` is three
     columns. The third header is empty. The one body row is `1`, `2`, `3`.
   - Welded extra cell: `| A | B | |---|---| | 1 | 2 | 3 |` keeps the header
     width. The body is `1` / `2`, then `3` / empty. The `3` is shown. It is
     not a third column.

4. **Delimiter width and alignment words.** These alignments are `leading`,
   `trailing`, and `center`. A padded cell is leading, because plain dashes
   are leading.

   - `| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |` is three columns, the third
     leading.
   - `| A | B | C |\n| :--- | ---: |\n| 1 | 2 | 3 |` is leading, trailing, and
     leading, on both header and body.
   - `| A |\n| :---: |\n| mid |` is one column, center, on the header and the
     body.
   - `| A | B |\n| --- | --- | --- | --- |\n| 1 | 2 |` is two columns. Extra
     delimiter cells are dropped.
   - Fitting still happens when a cell contains an escape or a code span:
     `| a \| b | c | d |\n| --- | --- |\n| 1 | 2 | 3 |` is three columns
     (`a | b`, `c`, `d`), the third leading.
     `` | `a|b` | c | `` followed by `` | --- | --- | `` is two cells:
     `` `a|b` `` and `c`.

5. **Outer pipes are optional on each edge of each row. One hyphen is enough.**
   A delimiter row contains at least one `|`.

   - `A | B | C\n--- | ---\n1 | 2 | 3` is three columns.
   - `| A | B\n--- | ---\n1 | 2 |` is two columns. The missing edge pipes are
     not empty cells.
   - `| A | B |\n| - | - |\n| 1 | 2 |` is a table.
   - `| A |\n| --- |\n| 1 |` is one column.
   - `Pros | Cons\n---` is a paragraph plus a rule.
   - `Pros | Cons\n-` is one paragraph, `Pros | Cons -`, because a lone `-`
     is not a bullet and not a rule, and a soft break joins the lines. It is
     not a table.

6. **What is not a table, and when a weld runs.** A weld runs only when all of
   these hold: the line, after at most 3 leading spaces, starts with `|`; it
   contains no backtick and no backslash; the header has at least two cells
   and ends with `|`; the remainder is empty or starts with `|`; the next line
   is not itself a delimiter row.

   These stay text, characters included:

   - `Example: | A | B | |---|---| | 1 | 2 |`
   - `| A | B | |---|---| then prose`
   - `| Step | --- | Done |`
   - `| A \| B | C | |---|---| | 1 | 2 |` (backslash: not welded; the same
     cells on their own lines are a table, per acceptance 4)

   Also:

   - Pipes and task markers inside a fence stay code, including while the
     fence is open. The closed fence whose body is `- [x] literal` is one code
     block with that text. An unclosed fence that starts the same way is code
     through the end.
   - A pipe line with no delimiter row after it stays a paragraph.
   - A blank line ends a table. `| A | B |\n| --- | --- |\n\n| 1 | 2 |` is a
     header-only table, then a paragraph `| 1 | 2 |`.
   - A following line that is not a pipe row also ends the table, with no
     blank line required. `| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter` is the
     table, then a paragraph `After`.
     `| A | B |\n| --- | --- |\n| 1 | 2 |\n- [x] done` is the table, then a
     completed task `done`.
   - Four spaces or a tab: `    | A | B |\n    | --- | --- |\n    | 1 | 2 |`
     stays text.
   - Under a list item: `- intro\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |`
     stays a list item plus text. The pipes remain visible.
   - A quote stays a quote: `> | A | B |\n> | --- | --- |\n> | 1 | 2 |` and
     `> - [x] done`. The words remain visible.
   - A line with an odd number of unescaped backticks is not a table row.
   - Top-level indent of 1 to 3 spaces does not block a table.

7. **Inline markdown in cells.** The splitter leaves markers in the cell
   string. Drawing uses the same inline renderer as a paragraph, so the
   asterisks of `**Quant** baskets` are not in the visible label. The visible
   label is exactly `Quant baskets`.

8. **Alignment drawing.** `leading`, `trailing`, and `center` from acceptance
   4 apply to the header and the body of that column. Each column has one
   width shared by its header cell and its body cells.

9. **Task items.** The marker is not a button. The accessibility label is the
   exact string in the last column. An ordered task shows its number.

   | Source | Visible number | Label |
   |---|---|---|
   | `- [ ] open` | none | `not completed, open` |
   | `* [x] done` | none | `completed, done` |
   | `+ [X] done` | none | `completed, done` |
   | `1. [ ] open` | `1.` | `not completed, open` |
   | `1) [ ] open` | `1.` | `not completed, open` |
   | `  - [x] nested` | none, one level in | `completed, nested` |
   | `- [ ] parent\n  - [x] child` | the child is one level in | `not completed, parent` and `completed, child` |
   | `- [ ]` | none | `not completed` |

   `- [x]no-space` stays a bullet whose text still begins with `[x]`.
   `[  ]` (two spaces) and `[ x ]` are not checkboxes. English labels use
   `completed` and `not completed`. Brazilian Portuguese uses `concluído` and
   `não concluído`. The UI test runs in English. A search for the exact label
   `completed` does not match `not completed`. Each task is one accessibility
   element, not a button, and it has no child whose label contains `[x]` or
   `[ ]`.

10. **Streaming, measured on `Markdown.blocks`, not on drawn glyphs.** For
    every prefix of the sources in acceptances 1 through 9, and of
    `| -5% | 12:30 | $3 | x |\n| --- | --- | --- | --- |\n| a | b | c | d |`,
    concatenate every block's text in order: paragraph, heading, the ordered
    number, task or bullet text, each cell, quote text, and code text. Drop
    only the characters the parser consumed as structure at that position:
    cell-boundary `|`, a whole delimiter row, list markers, a checkbox token,
    the backslash of `\|`, heading hashes, a quote marker, a thematic-rule
    line, and fence markers. What remains equals the same drop applied to the
    prefix. Equality, not "the source characters occur somewhere in order".
    The characters of `-5%`, `12:30`, `$3`, and `x` stay in their cells.
    Drawing may hide `*` from `**bold**`. That is acceptance 7, not a
    streaming failure.

11. **Walkie.** These spoken strings are exact.

    ```text
    | Name | Status |
    | --- | --- |
    | Ada | ok |
    | x | stays |

    - [x] shipped
    - [ ] waiting
    - [X] closed
    ```

    `Name, Status. Ada, ok. x, stays. shipped. waiting. closed.`

    ```text
    | A | B | |---|---| | 1 | 2 |

    | :--- | ---: |

    | - | - |

    --- | ---

    * [x] star
    + [X] plus
    1. [ ] first
      - [x] nested
    The separator |---|---| is what GFM calls a delimiter row.
    ```

    `A, B. 1, 2. star. plus. first. nested. The separator, ---, ---, is what GFM calls a delimiter row.`

    Blank lines keep the welded line from seeing a delimiter as its next line,
    and keep the delimiter-shaped lines from becoming a table with each other.
    Speech still drops a line whose cells are all delimiter cells, even when
    that line is only a paragraph. The prose sentence is spoken. The cell `x`
    is spoken. No checkbox token is spoken. The existing length cap is
    unchanged. Both samples are under it.

12. **The person's own message.** A user message whose text is exactly the
    following shows that source, including the delimiter and the brackets.

    ```text
    | A | B |
    | --- | --- |
    | 1 | 2 |
    - [x] done
    ```

13. **Package tests.** `cd ios && swift test` covers the split and both spoken
    strings. It does not prove pixels. Mutations before commit, each one
    failing the test that names it:

    | Mutation | Fails |
    |---|---|
    | Do not emit a table block | A table assertion from acceptance 1 |
    | Do not emit a task block | The `+ [X]` row and the nested row |
    | Treat `Pros \| Cons` followed by `-` as a table | Acceptance 5's negative |
    | Split the pipe inside `` `a|b` `` | Acceptance 4's code-span cell |
    | Leave a delimiter row or a checkbox `x` in the spoken string | Acceptance 11's first exact string |
    | Treat `:---:` as leading | Acceptance 4's center column |
    | Grow a third column on the welded extra cell | Acceptance 3's welded wrap |

14. **Preview.** The UI test launches with `-store-preview -threads-preview`
    and without `-images-preview`. It does not edit `ImagePreview.json`.
    On Pepper's launch thread in `ThreadPreview.json` (it already contains
    `I’m reviewing Gmail here`), insert three messages and re-parent the
    existing reply. `activeLeafId` stays `preview-gmail-reply`. The parent
    chain is `preview-gmail-user` → `preview-gmail-grid` →
    `preview-gmail-tasks` → `preview-gmail-user-md` → `preview-gmail-reply`.
    Existing `ThreadNavigationUITests` and `ComposerReturnUITests` still pass.

    Each transcript message exposes accessibility identifier `message-<id>`
    on a container whose children stay separate elements. Queries in this
    acceptance are inside that element, not a search of the whole screen.

    - `preview-gmail-grid` is exactly the pipe table in acceptance 2. Inside
      it, the cell labels in order are `Alpha`, `Beta`, `one`, and `W`
      repeated 80 times. `Alpha` and `Beta` share a horizontal center line.
      `one` and the long token share a later one. `Alpha`'s width matches
      `one`'s width, and `Beta`'s width matches the long token's width, within
      one point. The long token's height matches `one`'s height within one
      point. Those cells sit in a horizontal scroll view identified
      `message-preview-gmail-grid-scroll`. A left swipe inside that scroll
      view moves the long token. No label inside the message contains
      `DATA TABLE`, `Copy CSV`, `rows`, or `| --- | --- |`. VoiceOver order of
      those four labels is that same row order.
    - `preview-gmail-tasks` is exactly:

      ```text
      | Name | Status |
      | :--- | ---: |
      | **Quant** baskets | shipped

      - [x] Ship the notes
      1. [ ] waiting
      ```

      Inside it, a label equals `Quant baskets`, a label equals `1.`, a label
      equals `completed, Ship the notes`, and a label equals
      `not completed, waiting`. The element labeled `completed, Ship the notes`
      is not a button. No label contains `**` or `[x] Ship the notes`.
    - `preview-gmail-user-md` is the user message from acceptance 12. Inside
      it, the label contains `| --- | --- |` and `[x] done`.

    The test attaches a screenshot of this thread. Putting the `parsedTable`
    branch back makes the grid assertions fail. The app target builds for the
    simulator.

15. **Wide rows.** Acceptance 14's grid is the check. The 80-character token
    does not wrap, and a sideways swipe moves it.

16. **One renderer.** `StreamingBubble` and the Markdown branch of file preview
    call `MarkdownText` with the text they already had. They do not grow a
    second splitter and they do not consult `parsedTable`. File preview keeps
    its existing truncation. The streaming caret sits on the last cell or the
    last task line, not on its own line.

## Constraints

- The split stays in `CompanionCore`. `Walkie.speakable` stays there too.
- Drawing stays in the app target.
- Checks use `swift test` and the offline thread preview. They do not pair
  with a live desktop or change a real conversation.
