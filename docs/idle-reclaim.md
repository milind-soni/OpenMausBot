# Dependency folders on a Cloud: why we reclaim them, not share them

The problem was measured on a real customer's Cloud (sizes and types only):
- 68 GB in 3.5 million files, nearly all written in three weeks.
- 49 GB is the bots' working folders:
  - one bot's own folder (`workspaces/<bot>`) is about 31 GB;
  - the per-conversation folders (`task-workspaces/<bot>/<thread>`) hold about 13 GB, spread over 253+ folders for one bot.
- Across all of it:
  - 15.5 GB of `.js` in 1.2 M files;
  - 11.4 GB inside `node_modules`;
  - 2.5 GB of native `.node` binaries;
  - 2.7 GB of git packs.
- Every conversation installs its own copy of the same dependencies. Tool caches (`~/.npm` etc.) are only about 2 GB.

**The owner's requirement:** things happen automatically, without interruptions. Nobody is asked, nothing is shown, and no setting has to be touched. What a bot's commands do does not change, nobody can lose or corrupt work, and one conversation can never change another's files.

**The owner's decision on 2026-11-23:** "then let's do like others do". We do not build a shared package store. We reclaim the installs of idle conversations, as the agent harnesses we surveyed do.

## Recommendation, in ten lines
1. Do not share installs between conversations. Inside the bot box, hard links cannot reach across conversations (measured below). Where they can, they are shared writable state, and an edit in one conversation changes another.
2. When the volume passes 70% used, shed the rebuildable installs of conversations idle at least 3 days, idle longest first, until it is at 60% (`server/host/idle-reclaim.ts`).
3. "Rebuildable" means what #7136 already counts as an install, with four more conditions:
   - there is a lockfile or manifest beside it;
   - git ignores it, where it is inside a checkout;
   - no checkout is inside it;
   - no process works in it, holds a file of it open, or has one of its files mapped.
4. A conversation folder's own pnpm store goes with its node_modules, never apart from them.
5. It goes through #7136's checked mover: one rename into `.removing` with a device and inode check, paced removal, and a pause during backup, restore and the move freeze.
6. The bot's next turn in that conversation carries one line: what went, and to reinstall from the lockfile. Nothing is shown to the person.
7. The switch is `OMB_IDLE_RECLAIM`, default off. `report` changes nothing and logs what a pass would shed. `remove` sheds. It runs on Cloud homes only.
8. #7068, already in train C3, should not ship as it is (see "#7068").
9. On the measured Cloud this frees at most about 6–9 GB and about half a million files (estimate below). It cannot reach 60% there, because the 31 GB bot folder is out of its scope.
10. Next steps: turn it on in `report` on the measured Cloud, then `remove`. Show "freed automatically" in Storage. Then decide the bot's own folder (owner).

## 1. What the bot box does to package-manager stores (measured)

**The box layout.**
- The box binds HOME (`/data`) read-write, and hides the data folder behind a tmpfs (`server/bot-box/plan.ts` `planBox`).
- It then binds the turn's conversation folder back on its own (`rw(cwd)`).
- Each conversation folder is therefore a separate mount, even though everything is on one ext4 volume.
- `link(2)` returns `EXDEV` across two mounts even of the same filesystem ("link() does not work across different mount points, even if the same filesystem is mounted on both", https://man7.org/linux/man-pages/man2/link.2.html).

**How it was measured.**
- Real tools, in a throwaway Linux sandbox. Its kernel was gVisor, on tmpfs, not Fly's or Hetzner's kernel on ext4; the EXDEV rule itself is the man page's.
- Tools: pnpm 10.33.0 (the image's), uv 0.13.4 (the image's), bun 1.3.3, npm 11.19.
- The table combines two runs:
  - **Run A** (rows 1 and 2, and the 21.5/33.1 MB): `unshare -m` with `mount --bind` of each conversation folder onto itself. Each conversation installed `lodash`, `zod` and `chalk` with each Node manager, and `requests` with uv.
  - **Run B** (the row-2 pnpm and uv figures, and row 3): real bubblewrap 0.9.0 with the box's layout (HOME bound, a tmpfs over the data folder, the conversation bound back). Each conversation installed `lodash` and `zod` with pnpm, and `requests` with uv.
- The count is files hard-linked in the second conversation.

| Layout | npm | pnpm | bun | uv |
|---|---|---|---|---|
| Store and project on one mount | 0 / 1119 | 1116 / 1121, into `~/.local/share/pnpm/store` | 1116 / 1118 | 109 / 140 |
| Box layout: each conversation its own bind | 0 / 1119 | 1104 / 1105, but into **`<conversation>/.pnpm-store/v10`**, one store per conversation | **0** (silent copy) | **0**, with "warning: Failed to hardlink files; falling back to full copy" on every install |
| `botThreads` box: the whole `task-workspaces/<bot>` bound | (not run) | into **`task-workspaces/<bot>/.pnpm-store`**, shared by the bot's conversations: `nlink` 3 on a file used by two of them | (not run) | 0 |

Two conversations took 21.5 MB on one mount and 33.1 MB in the box layout (`du`, each link once).

**What follows from the table.**
- **npm never links.** It extracts tarballs from its `_cacache` into every `node_modules` (measured in run A; https://docs.npmjs.com/cli/v11/using-npm/config).
  - `install-strategy=linked` installs into `node_modules/.store` of that project only. It is not a cross-project store.
  - So no store setting saves anything for npm, which is what most bots run.
- **pnpm.**
  - It falls back to a per-conversation store when it cannot link to the one under HOME. On this Mac, a real `pnpm install --store-dir` made `v10/files`, `v10/index` and `v10/projects`, the layout the reclaim checks for.
  - pnpm's docs: "The store should be always on the same disk on which installation is happening, so there will be one store per disk" (https://pnpm.io/settings/store).
  - With `storeDir` set, it copies instead ("packages will be copied, not linked", https://pnpm.io/faq). Its `auto` import method on Linux is hardlink, then clone, then copy (https://pnpm.io/settings/node-modules).
  - **Consequence for the reclaim:** shedding a pnpm `node_modules` alone frees nothing while `<conversation>/.pnpm-store` holds the same inodes. The two go together.
- **bun** hard-links by default on Linux (https://bun.sh/docs/install/cache) and copies inside the box.
- **uv.**
  - Its docs say the default link mode is `clone` on Linux (https://docs.astral.sh/uv/reference/settings/#link-mode).
  - On tmpfs, which cannot clone, it fell back to hard links.
  - In the box it copies and warns. The cache "must fall back to slower copy operations" when on another filesystem (https://docs.astral.sh/uv/concepts/cache/).
- **pip** has no linking. **yarn**'s `nmMode` defaults to `classic` (copies). `hardlinks-global` is opt-in per project, and PnP is a different install layout (https://yarnpkg.com/configuration/yarnrc).

**Step 6, the cache root (open PR #7134).**
- It points npm, pip, uv, bun and others at `<box HOME>/cache`, on the HOME mount.
- That does not change the table: the conversation folder is still another mount, so nothing links either way. It neither makes linking work nor breaks it.
- It deliberately leaves pnpm's store alone (`ERR_PNPM_UNEXPECTED_STORE`, and npm warns on `npm_config_store_dir`).

## 2. Considered and not doing, because

| Option | What it would save here | Why not |
|---|---|---|
| (a) Package-manager stores shared per Cloud and linked | **npm: 0.** For pnpm, bun and uv, 0 inside today's box. | Links cannot cross the box's per-conversation mounts. Making them work means binding a parent that holds the store and the conversation folders, with siblings hidden by tmpfs. That is a deny-list, which is not safe by construction. A hard-linked store is also shared writable state: an in-place edit (patch-package, a postinstall writing into its own package, a hand edit) changes every project linking that file, and pnpm's docs say so. That breaks "one conversation never changes another's files". |
| (b1) Reflinks (copy-on-write) | npm: 0 at install time (it extracts, never copies). pnpm, bun and uv: their duplicate files. | **ext4 has no reflink, and cannot be converted in place to XFS.** `btrfs-convert` exists but runs offline and is not a route we would take on customer disks. New Hetzner volumes could be XFS. The Admin creates them with `format: "ext4"` (`server/cloud-provider-hetzner.ts`). Hetzner's own guide and its client libraries (Ansible, hcloud-go) list xfs and ext4 at creation; the API reference page itself was not read. Fly volumes were ext4 only per an older staff reply (https://community.fly.io/t/xfs-file-system/6043), not checked against current docs. Since Linux 5.18, reflink works across mounts of the same superblock (commit 9f5710bbfd30, https://lore.kernel.org/all/20220218131910.GT12643@twin.jikos.cz/t/), so a box would not block it. Dropped by the owner's decision, and it only helps tools that copy. |
| (b2) Hard-linking identical files after the fact (jdupes, rdfind, `hardlink(1)`) | Up to the duplicate share of 11.4 GB | **Unsafe.** Anything that edits a file in place edits it in every project: patch-package, postinstall scripts, `npm rebuild` and native rebuilds, bundler caches writing beside sources. On a Team Cloud, a link shared between two members' private folders lets one member's write change the other's file, and lets them learn that it exists. Disqualified. |
| (b3) FUSE or overlay dedup layer; btrfs or ZFS dedup | Duplicates, at a high CPU and memory cost | FUSE adds a daemon on every file access of every bot, and a crash takes every project with it. ZFS dedup needs large RAM tables, and neither btrfs nor ZFS is offered for Fly volumes. Out of proportion for a 2-vCPU Cloud. |
| (c) A per-Cloud install cache keyed by lockfile hash, mounted read-only through an overlay | Duplicates of identical lockfiles | The image's bubblewrap is Debian bookworm's 0.8.0. `--overlay` arrived in 0.11.0 and is unavailable when bwrap is setuid (https://github.com/containers/bubblewrap/blob/main/NEWS.md). The app outside the box would see only the upper folder, not the install. The shared lower copy is produced by a bot's install, including its postinstall scripts, so one conversation could plant code in another's dependencies. Directory renames across layers (npm moves package folders) need overlayfs `redirect_dir`, otherwise EXDEV. Kernel support for unprivileged overlay on Fly's Firecracker guest is not verified. |
| (d) Not storing them: remove from idle conversations, reinstall on demand | **This is the build** | A separate research pass (not repeated here) found no agent harness that shares installs across conversations; they reinstall per worktree. |

**Cross-bot caches today.**
- HOME is writable from every box on a personal Cloud. That includes `~/.npm`, `~/.cache/uv`, `~/.bun`, `~/.bashrc`, `~/.npmrc` and `~/.gitconfig`.
- So one conversation can already influence another's next install or shell. Whether npm's, uv's and bun's caches re-verify what they hold on use was not checked here; the uv docs say "it's never safe to modify the cache directly".
- This is the same person's bots, so it is not a privacy issue. It is an integrity gap that predates Step 6, and Step 6 neither adds to it nor fixes it.
- On a Team Cloud, each audience has its own box HOME (`engine-homes/<audience>`), so nothing crosses between members.
- Closing the gap means a read-only HOME with writable cache folders per bot. That is an owner decision, not part of this change.

## 3. What is built: `server/host/idle-reclaim.ts`

**Model.**
- A disk budget for stopped conversations: past a fraction of the filesystem it sheds the git-ignored folders of stopped conversations, least recently active first.
  - It finds them with `git ls-files --others --ignored --exclude-standard --directory`, with `core.fsmonitor=false`.
  - It skips an ignored folder that holds a checkout, three levels down.
  - It moves through a same-filesystem trash, and a resumed conversation reinstalls.

**Ours, on top of #7136/#7138's checked mover.**
- **When.**
  - Every 30 minutes, starting 15 minutes after boot.
  - Nothing happens below 70% used. Once at or above 70%, passes shed until the volume is at 60%. A `report` pass never starts that run.
  - All the numbers are in `IDLE_RECLAIM`; none is a setting.
- **Which conversations.**
  - Only per-conversation folders `task-workspaces/<bot>/<thread>` whose conversation is registered.
  - Idle at least 3 days, judged by three things:
    - its newest message, close or archive;
    - its folder's own change time;
    - each install's own change time.
  - Idle longest first.
  - Never one whose conversation is busy, whose bot runs a turn anywhere, or which is handed off.
  - Never while frozen after a move, or while a backup is being made or restored.
- **Which folders.**
  - Everything `conversation-folder-cleanup.ts` requires:
    - a node_modules with a package manager's record and a `package.json` beside it, not tracked by git;
    - a venv holding only a venv's entries;
    - no link from the bot's other folders into it;
    - no other conversation working in, inside or above it;
    - the saved definitions and other conversations' messages do not name it.
  - Plus:
    - a lockfile (node) or manifest (Python) beside it;
    - git ignores it and tracks nothing inside it, where it is inside a checkout. This is `git check-ignore` and `git ls-files --cached` on that one folder, with no system or global config, fsmonitor off and no prompt. It replaces a full `ls-files --others --ignored` listing.
    - no `.git` within three levels inside it;
    - no process has it as cwd, holds a file of it open, or has a file of it mapped (`/proc/*/cwd`, `fd`, `maps`). If `/proc` cannot be read, nothing goes.
  - A pnpm store at the conversation's top (`.pnpm-store/v<N>/files`) goes with its node_modules, and only when every node_modules of that folder goes. While it must stay, the pnpm installs stay too.
  - Build output is never shed, ignored or not. It can be the deliverable, and Files brings it to the person.
- **How.**
  - The records are checked again just before each move, and so is "still idle": no new message, no turn, not handed off, not paused.
  - Then comes #7136's rename into `.removing`, checked by device and inode before and after. Removal is paced.
  - A conversation that wakes mid-pass keeps what was not moved yet.
- **Kept, and why.** Each pass's report counts why folders stayed, by kind of reason, never with a path or a name from the disk.
  - One of #7136's guards matters on the measured Cloud. Before an install goes, it looks for links into the folder from the bot's own folder and from all its conversation folders. Past 50,000 entries it gives up and keeps the folder.
  - A bot with a 31 GB own folder very likely passes that limit, so its conversations would all be kept. The `report` run will show it as "the bot's other folders hold too many entries to check for links into it".
  - That guard is #7136's to change, not this one's.
- **Cost.**
  - One view per pass: the live folders resolved once, each bot's links scanned once, the saved definitions read once, and the transcripts queried once for every candidate.
  - Then, per candidate: #7136's walk of the conversation folder, at most two git calls per install, and a three-level look for `.git` inside it. `/proc` is read once per pass.
  - A pass runs only above 70% used. A `remove` pass that finds nothing it may shed waits six hours, unless the volume fills by five more points.
- **The bot is told.**
  - `idleReclaimNote` adds one bracketed line to the bot's next turn in that conversation, in the same place as the existing `@devs` note (`index.ts`, the 1:1 and room turn texts). It says what went and how to reinstall.
  - It is given again for ten minutes after its first turn, so a turn started again (a recovery) still carries it. Then it is dropped.
  - Nothing reaches the person.
- **Numbers.**
  - `idle-reclaim.json` in the data folder keeps the last pass, the totals freed and the pending notes. It is hidden from the box and left out of exports.
  - `idleReclaimSummary()` is what the Storage view reads. The one-line wiring into the storage report (#7118) is owed once this stack carries main.

**#7068 (in train C3).**
- It prunes `node_modules`, venvs and Cargo `target` from threads idle 14 days.
- It is always on, desktops included. On a desktop, `task-workspaces` can be a project the person also works in.
- It has no package-manager marker check, no `package.json`, git-tracked or lockfile check, no process check and no pause during backups. It runs a plain `rm` with no device and inode check.
- It removes Rust `target`, which #7136's review ruled out.
- It does not handle the per-conversation pnpm store, so for pnpm it frees nothing.
- It would duplicate this mechanism with weaker guards. **Recommendation:** take #7068 out of train C3, with thanks to its author, and point them here (owner decision).

## 4. Estimated saving on the measured Cloud

**Inputs.**
- Per-conversation folders hold about 13 GB, of which node_modules is the larger part. Take 8–11 GB of installs, including any per-conversation `.pnpm-store`.
- The Cloud is three weeks old. If conversations were spread evenly, about 85% of them are idle 3 days or more.

**The estimate.**
- That makes **at most about 6–9 GB**. It is an upper bound: the link-scan limit above may keep a large bot's conversations whole.
- The file count was not measured for node_modules alone (1.2 M is the count of all `.js` files, 15.5 GB). If node_modules files average the same size, it is roughly **0.5–0.7 M files**. Fewer small files also shortens a full-disk backup.
- The budget alone would want more. At 68 GB used of 80 GB (85%), reaching 60% means freeing 20 GB. The reclaim sheds every eligible install and stops at about 74–77%.
- **It does not shrink the 31 GB bot folder.**
  - That folder is the bot's own ongoing project, and no idle rule describes it.
  - Options for later, owner decisions:
    - the same rules for `workspaces/<bot>` installs, keyed on the bot's last turn, with a longer idle time (14 days);
    - `git gc` of its 2.7 GB of packs;
    - asking why one bot's folder grew to 31 GB, which the Storage view (#7141) will show.

**Restore, move and backup.**
- Shed installs are not in later backups.
- A restore brings back what a backup held.
- The Hetzner backup is GNU tar, which stores hard links once.
- The app's export already omits `node_modules`. It copies files one by one, so it expands any links.


## 5. Plan (small steps)
1. **This PR.** `OMB_IDLE_RECLAIM=report` on the measured Cloud for a day. Read the log line "would shed N install folder(s) … GB".
2. Set `remove` on that Cloud. Check that the volume drops, and that a woken conversation's bot reinstalls.
3. Wire `idleReclaimSummary` into the storage report, so the Storage view says "freed automatically: N GB".
4. Default `remove` on every Cloud home (an image release).
5. Owner decisions: the bot's own folder; build output; a read-only HOME with per-bot cache folders; XFS for new Hetzner volumes (dropped for now).

## Verified versus read
- **Measured with real tools:**
  - the table in section 1 (runs A and B);
  - pnpm's store layout;
  - the full reinstall path with real npm (`server/host/idle-reclaim-reinstall.test.ts`);
  - `git check-ignore` and a force-added file (`server/host/idle-reclaim.test.ts`).
- **Read in docs:** everything cited by URL above.
- **Not verified:**
  - the same table on Fly's and Hetzner's real kernels with ext4;
  - unprivileged overlay on Fly;
  - whether npm's, uv's and bun's caches re-verify on read;
  - the research pass's survey of other harnesses;
  - Hetzner's API reference for the volume format, and Fly's current volume filesystem;
  - the 8–11 GB split of the 13 GB, which the storage report's per-bot `packages` figure will give.
