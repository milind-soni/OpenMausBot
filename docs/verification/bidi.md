# Right-to-left message content

Launch the real renderer and server with only an offline provider and a
disposable data directory:

```sh
node --experimental-strip-types scripts/verify-bidi.ts
```

Open the printed `previewUrl`. The fixture seeds Probe with one thread holding
a multi-line user turn that mixes Arabic and English lines, an Arabic reply
covering every block a bot answer can contain, and an English reply that ends
on an Arabic paragraph.

Message text is written in the user's or the model's language, which is
independent of the UI language: the app chrome stays left-to-right throughout
these checks. What is being verified is content direction, per block.

## Check the real UI

1. The sent bubble must resolve **per line**: the Arabic and Hebrew lines sit
   right, the English line between them sits left. One line must not decide
   for the rest. The inner element holding the text must have `chat-text`:
   `unicode-bidi` does not inherit from the outer bubble.
2. In the Arabic reply, the heading, paragraphs, list and quote all read
   right-to-left — bullets on the right, the quote's rule on the right.
3. Its table's columns run right-to-left, and every header sits over its own
   data. A header drifting to the opposite edge from its column means cells
   are resolving individually instead of inheriting the table.
4. Its fenced block and inline spans stay left-to-right inside the RTL
   paragraphs, and `buildIndex()` does not reorder the sentence holding it.
5. The English paragraph closing that same Arabic reply reads left-to-right on
   its own. In the second reply the relationship inverts: an English answer
   ends on an Arabic paragraph that must align right.
6. Type both scripts in the composer. The field follows what is being written,
   so a message reads the same while typed as after it is sent.

Direction is resolved from each block's own text rather than delegated to
HTML's `dir="auto"`, which ignores any descendant carrying its own `dir` — a
quote or a table whose children each resolved their own direction would find
no text left to judge and fall back to the app's LTR. Checks 2 and 3 are what
catch that regression.

## Permanent regression checks

```sh
pnpm exec vitest run src/components/ChatMarkdown.test.ts src/components/ChatView.controls.test.ts
```

These cover first-strong-character resolution, per-block direction, the
table's single direction, logical box properties, and code pinned
left-to-right and isolated.

Stop the foreground launcher with Ctrl-C. It closes only its own UI/server and
deletes its disposable home; the printed server log remains available.
