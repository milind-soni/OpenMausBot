# Team files

One shared folder per Team Cloud, for every teammate and every bot: payroll records, client lists, templates, brand
assets. It is the team's (audience `team`, [team-cloud.md](team-cloud.md#team-files)): everyone on the team reads it,
whichever chat they are in.

## For people

**Team files** in the Tools menu (and the sidebar's tools) opens it, only on a Team Cloud. The page lists one folder at
a time with breadcrumbs back up, and for each file its size and its last change: *"Uploaded by Ben · 5 min ago"*,
*"Changed by Mira with Payroll · 2 hr ago"* (Payroll changed it in a turn Mira asked for). Under the title it shows the
space used of 5 GB.

- **Upload** with the button or by dropping files on the list: at most 100 MB a file, 5 GB in all. An upload that does not
  fit is refused and says why; a file with the same name is replaced only by whoever uploaded it, or an admin.
- **New folder**, **Download**, **Rename** and **Delete**. An Owner or Admin renames and deletes anything; a member what
  they uploaded (and a folder of theirs only when everything in it is theirs too).
- **Preview** of text, Markdown, CSV and JSON (up to 1 MB) and of PNG, JPEG, GIF and WebP pictures; anything else downloads.

The desktop app and the browser show the same page. The routes (`/api/team-files/*`, below) are a member's, so the phone app
may list and download from them; it has no page of its own.

## For bots

Every turn of every bot on a Team Cloud has the folder at **`/team-files`** in its bot box, read-only, and its system
prompt says so in one line (*"Team files, the folder everyone at Acme shares: /team-files. It is read-only for you."*).
An admin turns on **Can edit team files** in the bot's settings (Access) to let it add and change files there from any
chat, members' private chats included: that is how a record from a private chat lands where the team keeps it. Nothing of
a conversation goes there by itself; the bot writes only what it is asked to.

When the folder is full the box has it read-only for every bot, and the line says so. A process an engine keeps between
turns (Claude Code's, an ACP engine's) is started again when a bot's access changes, so turning the switch off takes effect
at its next turn.

## Who changed what

`team-files-activity.json` beside the folder records each change with its time, path, action, the person and the bot:
uploads, new folders, renames and deletes from the page as they happen, and a bot's writes after each turn that could
write (a bot that may edit, or any bot where no box keeps the folder read-only), found by comparing each file's size and
time before and after. A folder of more than 20,000 entries is not compared, so its changes go unrecorded. A change the
page or another turn made meanwhile is never put on the turn.

## Routes

| Route | What |
|---|---|
| `GET /api/team-files?path=<folder>` | the folder's entries with their last change, the space used and the caps |
| `GET /api/team-files/file?path=<file>` | the file; `&download=1` as an attachment |
| `PUT /api/team-files/file?path=<folder>&name=<name>` | an upload, the body as is |
| `POST /api/team-files/folder` `{path}` | a new folder |
| `POST /api/team-files/rename` `{from, to}` | |
| `POST /api/team-files/delete` `{path}` | |

Off a Team Cloud they answer 404. Every path is relative to the folder, with no `..` part, and nothing in the folder is
reached through a link (a bot could leave one there).
