# Files: lent folders on My Cloud, get your bots' work

Files is a top-level page in the desktop app, for people with a MausBot Cloud ("My Cloud"). It does two jobs:

- **Lent folders, even while this computer sleeps.** Every folder lent to My Cloud (each moved bot's project folder, a folder added here) also gets a copy on My Cloud, kept up to date while this computer is on. The home folder, which this computer lends My Cloud by itself (`docs/cloud-pro.md`, "This computer works for your Clouds"), is too broad for a copy and stays live only. While it is away, bots read that copy, and a change to a folder lent with editing waits on My Cloud and lands here when the computer is back. Nobody chooses anything: what fits is copied, the rest stays live only.
- **Your bots' work.** What Cloud bots make comes down to `Documents/MausBot/<bot>/<conversation>` on this computer.

It never merges two sides. Nothing on this computer is deleted because of something that happened on My Cloud, and a bot changes the person's files only in a folder lent with editing, by the same rules whether the computer is on or away.

## What the person does

Nothing new. Lending a folder is what it was; the copy happens behind it. There is no setting, size picker or list of changes.

- **Add a folder** on the Files page lends it, read only. The folder picker opens. The app checks the folder, then asks: "Share “Clients” with My Cloud? 1,240 files · 3.2 GB." Choose **Share** or **Cancel**. When it can't be lent (before this computer is signed in to My Cloud, or a change of what is lent overtook it), Files copies it on its own, as before.
- **Stop sharing**, from the ⋯ menu. The folder is no longer lent (lending stops when it was all that was lent), and My Cloud's copy moves to its trash for 30 days. Nothing on this computer changes.
- **The Files page lists every folder My Cloud has a copy of.** A lent folder whose copy is too big shows only where lending shows its folders.
- **After a move to My Cloud**, the folders that stayed on this computer are offered: **Share them with My Cloud**.
- **The bots' work switch.** It is on by default. Only conversations active since the switch was turned on come down, so old history doesn't flood Documents.

## Lent folders while the computer is away

`electron/lent-folders.mjs` (which folders get a copy), `electron/lent-staged.mjs` (bots' changes landing here), `server/lent-copies.ts` (My Cloud's side).

- **Which folders get a copy.** Each folder lent to My Cloud, when Files may share it (the refusals below hold, so the home folder lent read only stays live only) and it holds at most 3 GB, counted in full in a moment (`COPY_MAX_BYTES`; a folder too big or with too many files to count stays live only). New copies take the room left on My Cloud's disk, which grows by itself up to the plan's size (20 GB on Starter and Personal, 100 GB on Pro, Max and Team), less what My Cloud keeps free for itself (`cloudReserveBytes`): smallest first. A folder copied already keeps its copy. A folder lent without a copy is counted again every 6 hours. A folder added on the Files page is copied whatever its size, as before.
- **What My Cloud is told.** After each pass the desktop says what it lends (`POST /api/sync/lent`): each folder's id, name, whether it is lent with editing, and its copy (a Files folder) or why it has none. A pass in step with this computer says how fresh that copy is (`POST /api/sync/folders/<id>/synced`).
- **While the computer is on**, bots use the folder live, as before.
- **While it is away** (asleep, off, the app closed, its Cloud sign-in waiting), `shared_computer`'s folder actions are answered from the copy instead of failing, for the owner's own conversations only. `list_shared_computers` lists the away computer under `away_computers`, each folder with how fresh its copy is ("from 2 h ago") or `copy: null` when it is kept only on the computer. Every read says it comes from the copy and how fresh it is.
- **A file that isn't in the copy** (skipped, like `node_modules`, new since, or in a folder kept only on the computer): the bot says so in a few words, "that one is only on your Mac; I'll get it when it's on".
- **Writing while away.** A write to a folder lent with editing is checked as a live write is (inside the folder, never through a link or into `.git`, at most 256 KiB, `expected_sha256` to overwrite) and waits on My Cloud (`sync/staged/`), never in the copy itself. The bot reads its own change back, and says "saved; it'll reach your Mac when it's on". A second change to the same file replaces the first and keeps what the computer had as its base. At most 500 changes or 64 MB wait; a change waits 30 days.
- **When the computer is back**, the next pass applies what waited before it copies the folder up again: a file the person didn't touch since the bot read it takes the bot's version, and the one it replaces goes to the Recycle Bin first; a new file is created. A file the person changed, or removed, meanwhile keeps theirs, and the bot's version lands beside it, named the way bots' work is in a clash, "todo (new from My Cloud, 27 Oct 2026).md". That is the only thing said: the folder's line on the Files page reads "Kept both versions of “todo.md”: yours, and the bot's as “todo (new from My Cloud, 27 Oct 2026).md”." for a week. Changes that land without a clash are silent.
- **This computer stays the authority.** Each change is checked again here as a live write is (a folder still lent with editing, no link, no `.git`, no protected place); a folder no longer lent with editing keeps its changes waiting. The copy on My Cloud still follows this computer, so a bot's change reaches the copy only by landing here first.
- **Apps and screen, and the terminal,** still need the computer on. Queuing them for when it is back is a follow-up.
- **A folder stops being lent** (Stop sharing here, or the folder gone from this computer): its copy goes to My Cloud's trash, as Stop sharing does. **Pause** in the menu bar keeps every copy and keeps it in step; bots' changes made on My Cloud then wait there until **Resume**, as they do while the computer is away.
- **A Cloud from before lent copies** (its `GET /api/sync` has no `lentCopies: true`) gets no copies of lent folders: there they would sit where every bot reads them, so lending stays live only until that Cloud is updated.

## Git repositories

`electron/lent-git.mjs` (which lent folders are GitHub repositories), `server/lent-clone.ts` (the clone).

- **A lent folder that is a GitHub repository** (its own `.git` folder, with an `origin` on github.com) says so to My Cloud: its `owner/name`, branch and commit, read from `.git`'s own files. A user name or token in the remote is never sent.
- **Its copy starts as a clone.** When My Cloud registers a new copy of one, it clones `https://github.com/<owner>/<name>.git` there in the background, history without file contents (`--filter=blob:none`), at the computer's commit on its branch; a commit GitHub doesn't have yet falls back to the branch as GitHub has it. git there never asks for a sign-in: it uses whatever git on My Cloud already signs in with (a public repository needs none), with no hooks. Until it is done, the desktop leaves that copy alone (`cloning`); then Files sends only what differs on the computer: changes not pushed yet, and files git ignores that Files carries, such as `.env`. The size and room rules are the same as for any lent folder.
- **No clone** (a private repository My Cloud can't sign in to, no network, a copy Files had started meanwhile): the copy is Files' as for any other folder, and the clone is tried again a day later for a copy still empty. A Cloud restarted mid-clone hands it to Files.
- **Bots return code work as branches and pull requests.** While the computer is away, `list_shared_computers` shows such a folder with `github` and `branch`, and bots are told to return code changes as a new branch and a pull request with their GitHub tools (a connected GitHub app) when they have them, not as writes to the folder. Without GitHub tools, a write waits for the computer like any other.
- The person chooses nothing: there is no move, list of files to tick or sign-in step.

## Folders the Files page shared before

Folders shared from the Files page before lent folders keep working. Once this computer lends itself to My Cloud, each joins what is lent, read only, and keeps its copy and its records: nothing is sent again, and nobody redoes anything. From then on it is a lent folder like any other. Until then, it stays a copy as before. Its copy stays in `/data/Synced`, where bots read it as before.

## Shared folders (this computer → My Cloud)

`electron/cloud-sync-plan.mjs` `planShare`, `electron/cloud-sync-engine.mjs` `shareFolder`.

- **The computer decides what is shared.** The desktop keeps its own list (`settings.json` `shared`) and syncs only folders it registered itself. A folder My Cloud lists for this computer is never read or written on that basis.
- **Folders that are never shared:**
  - the home folder or anything above it;
  - a drive root or a mount point;
  - MausBot's own folders: its data folder and `Documents/MausBot`;
  - folders of keys and settings: `.ssh`, `.aws`, `.gnupg`, `.config`, `Library`, `AppData` and similar;
  - a folder inside, or around, one already shared.
- **This computer's version always wins.** A file new or changed here is uploaded. If a bot edits the copy anyway, the next pass puts this computer's version back, and the bot's version stays in My Cloud's trash. Files a bot adds to the copy stay on My Cloud and never come down.
- **On My Cloud, the copy is read-only** (files `0444`). The bots' prompt names the shared folders, says the copies are read-only, that a change to a folder lent with editing goes through `shared_computer` (it reaches this computer), and tells bots to save their other work in their own folder.
- **Deletes:**
  - A file gone from this computer is removed from My Cloud, into its trash, only when the base proves it was there.
  - If 10 or more files go at once and they are at least a fifth of the folder, or the folder is now empty, the folder waits: "{n} files were removed from this folder here. Remove them from My Cloud too?" The person chooses **Remove from My Cloud** or **Keep them**.
  - A folder that is gone from this computer (moved, renamed, a drive unplugged) is "missing". Nothing changes on My Cloud, and the person chooses **Find it** (the picker) or **Stop sharing**.
  - A file that is still being written, a link, a hard-linked file, or anything under a linked folder is "kept": it is not carried, and it never reads as deleted.
- **Full.** My Cloud always keeps max(2 GB, 15% of its disk) free (`cloudReserveBytes`). Files that don't fit wait, smallest first, and Files shows **Get more space**. The disk grows by itself, 10 GB at a time, up to the plan's size; past that, files keep waiting.

## Bots' work (My Cloud → this computer)

`planOutputs`, `fetchOutputs`.

- **What comes down:** each bot conversation folder (`task-workspaces/<bot>/<thread>`) that changed since the switch was turned on (`newestMs`). It lands in `Documents/MausBot/<bot name>/<conversation title>`, with names made safe for Windows and macOS.
- **Never deleted here.** A file removed on My Cloud stays on this computer. A file the person removed here comes back only when My Cloud has a newer version.
- **The person's edit is kept.** When the file here changed since it came down, My Cloud's newer version lands beside it, as "report (new from My Cloud, 15 Oct 2026).md". A file that was not edited is replaced, and the old copy goes to the Recycle Bin first.
- **Never brought down:**
  - an agent's or a tool's config: `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.codex/`, `.cursor/`, `.vscode/`, `.idea/`, `.github/`, `.envrc`, `*.code-workspace`, matched case-insensitively;
  - anything sync skips, such as `.git` and `node_modules`;
  - a name with a direction override character;
  - on Windows, a name Windows can't hold.
- **Every download** is checked against its sha256, then marked as downloaded from the internet, the way a browser marks a download: Mark of the Web on Windows, the quarantine flag on macOS.

## On My Cloud

`server/cloud-sync.ts`, `server/routes/cloud-sync.ts`.

- **Access.** `/api/sync/*` answers only on a Cloud home, and only to the owner's admin session.
- **Where things live:**
  - Shared copies are under `/data/Synced/<computer>/<folder>`, outside the data folder, so workspace backups and Move to Cloud don't carry them, and bots read them there.
  - Copies of lent folders are under `/data/.openmausbot/sync/lent/<computer>/<folder>` (`lentRoot`): in the data folder, which no bot's box shows, so only `shared_computer`, with lending's own rules (the owner's own conversations and routines, never a webhook or a guest), reaches them, and the prompt never names them. A folder shared from the Files page before it was lent keeps its copy in `/data/Synced`, where it was.
  - Both are on My Cloud's disk, in its daily backups.
  - Sync's own records (`sync/`) are left out of backups: `sync/lent.json` (what each computer lends and how fresh each copy is) and `sync/staged/` (bots' changes waiting for their computer) included.
- **Changes.** Nothing watches the disk. When a bot's turn ends, `index.ts` tells the sync service (`noteSyncBotTurn`), which wakes the desktop's long poll for that conversation's folder. The desktop also runs a full pass every 5 minutes.
- **Downloads** are served with `content-disposition: attachment`, `nosniff`, and `content-security-policy: sandbox`.

## The desktop's channels

The calls are listed in `electron/cloud-sync.d.mts` (`CloudFilesBridge`).

- **Who can call them.** The channels answer this computer's own window only (`localWorkspaceOnly`). The My Cloud page gets no Files bridge.
- **How a folder is shared.** A folder reaches `share` only as a token for one the person picked in the native dialog, or one the app suggested and checked. A token is used once, and expires after 30 minutes.

## Not in v1
- Queuing apps and screen, and terminal steps, for when the computer is back: they still need it on.
- Two-way folders beyond a bot's changes through `shared_computer` to a folder lent with editing.
- Phones.
- Connecting OneDrive, Google Drive or Dropbox to My Cloud. That's probably the better route for documents already in those services.
