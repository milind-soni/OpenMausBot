# Chat attachments into a Local VM

The built-in agents tools `list_chat_attachments` and `get_chat_attachment` reverse `attach_file`. They use the existing turn capability and Local VM gate; callers cannot supply a bot, conversation or VM identity.

`list_chat_attachments {}` returns the current conversation's structured attachment records, user text attachment tags (including calendar attachments), and current-turn parked generated images, including images not yet posted to the chat. References are the complete stored filenames, with extension. It does not enumerate the global attachment store or accept arbitrary source paths.

```json
{"attachment_ref":"<stored-filename>.png","destination_dir":"attachment-work/files"}
```

`destination_dir` is optional and relative to `/home/cua/workspace`. Without it the destination is `attachments/inbox/<bot_id>/<thread_id>`. A successful get returns `attachment_ref`, `local_path`, `name`, `mime`, `size`, and `reused`. It requires the current turn to own a Local VM, and the current implementation requires a Linux host (directory descriptors through `/proc/self/fd`). It neither claims an unrelated VM nor falls back to the shared desktop.

Copies are separate files. Reads, writes and hashing use asynchronous file handles with 256 KiB buffers, bounded by the source size observed at the start. Ownership is rechecked after asynchronous operations and before publication; a copy published during revocation is removed without deleting a replaced destination. Identical destination bytes are reused; edited files and other existing entries are never overwritten. The new copy is published atomically without replacement and made readable by the VM. Symlink sources and directory components, absolute destinations and traversal are rejected. Shared-VM directories organize files; they are not per-bot operating-system isolation. Copies remain until the bot/user cleans its workspace; deleting a copy does not delete the chat original.

Validation:

```sh
pnpm exec vitest run server/chat-attachment-fetch.test.ts server/drivers/agents-tool-groups.test.ts
pnpm exec vitest run server/image-generation.e2e.test.ts scripts/testing/verification-docs.test.ts
```

The end-to-end test launches an isolated fixture with a fake image provider and fake engine. It verifies the tools are callable while a generated image is still parked, a different conversation cannot list it, and export without a Local VM fails. Filesystem tests cover successful copies, original-file independence, permissions, repeat reuse, edited-copy preservation, traversal, symlinks, size limits and default conversation separation. No user's running desktop or live chat is modified by these checks.

Regression checks include long-name collisions (including a concurrent destination appearing during publication), text-tag PDF/image discovery and export, retained audio/generated attachments, and rejection of files outside the attachment store. The calendar-style text-tag case also runs through the isolated server tool route.

Async export tests verify event-loop progress during bulk reads, bounded read sizes, ownership revocation, and cleanup after publication loses ownership.
