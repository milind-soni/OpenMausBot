# Sharing a bot or a department

A bot or a whole department can be shared as a **template**: a small folder anyone can add to their own MausBot.

- **A bot.** Ask it in chat ("publish yourself to GitHub", "export yourself"), or use **Share → Share as template**.
  The app sends the bot "Create a public template of yourself that I can share with somebody else"; the bot makes the
  folder, takes personal details out of it, and shows one card with **Publish** and **Details**.
- **A department.** The department's **…** → **Share** shows its card at once, with **Publish to community** and
  **Save folder…**. A Chief can also be asked in chat to share its department.
- **Adding one.** **+** → **Import…**: paste a GitHub link or choose a folder, look at what it brings, then **Add**.
  A bot can also add one when you paste the link or folder path in your own message ("import <link>"). A link to a
  private repository works once GitHub is connected in Apps (below).

## What the folder holds

```
<name>/
  bot.md or team.md          the bots, their instructions, group chats, the Chief, routines and apps by name
  skills/<name>/SKILL.md     every skill, as standard Agent Skills
  skills/<name>/<path>       the scripts and other text files beside a skill, named in bot.md's skillFiles
  avatars/<key>.webp         pictures, at most 64 KB each
```

`bot.md` and `team.md` are BotMRR Markdown v2: YAML frontmatter with the template's fields, and a readable body any AI
agent can follow when the file is pasted in. Older files (BotMRR v1 Markdown, `team.mausteam.json`, package JSON) still
import.

Never in a template: chats, memory, keys, passwords, tokens, connection addresses, models, approval levels, folders,
computers or who may see a bot. Every text is checked for key- and password-shaped values, which are replaced; the card
says how many. Routines always arrive paused, and each app is connected with the new owner's own account.

**A skill's scripts travel with it** (`shared/skill-files.ts`): the files that came in with the skill, only those its
record lists and only while they are unchanged, never anything a run left beside it. Text files only, at most 30 per
skill, 128 KB each and 512 KB together, six folders deep. Left out, and named on the card under "Left out": hidden files
and folders, `node_modules`, `__pycache__` and `venv`, pictures and other binaries, files named like keys (`.env`,
`*.pem`, `*.key`, `id_rsa`, `credentials.json`, `secrets.*`…) and any file holding a key's shape (a provider's key, a
private key block). A script's code is never rewritten to hide a value: a file with one stays home instead. Reading a
folder applies the same rules, so a template whose named file breaks one is refused with the file's name. Scripts
arrive with the skill switched off, as every imported skill does, and without execute bits; a bot runs them through
their interpreter (`python3 scripts/report.py`). Older apps ignore the extra files and read the rest.

## Publishing

**Publish** sends the folder to the MausBot Admin, which opens a pull request on the community repository
(`milind-soni/openmausbot-teams`); nobody needs a GitHub account. The card then has **Copy link**, a GitHub folder link
that **Import…** accepts, and **View on GitHub**. Publishing needs a MausBot sign-in; without one, the card offers
**Save folder…** and **Upload on GitHub**, the repository's own upload page. The community repository takes each skill's
SKILL.md alone for now, so a published template leaves its scripts out; the other targets keep them.

### Your own GitHub repository

**Your GitHub repo…** (in the card's **…**, and beside **Publish to community** in a department's Share) publishes to a
repository the GitHub connection in Apps can write to: `owner/repo`, an optional folder, and the template goes in
`<folder>/<slug>/` as one commit on a new branch `mausbot-<slug>-<6 hex>` with a pull request, or straight on the default
branch with **Commit directly to the default branch**. Files already in that folder under other names stay. Without a
GitHub connection it says **Connect GitHub in Apps first** with **Open Apps**. On a Team Cloud it uses the team's GitHub,
or the person's own when the team has each person connect GitHub; the team's Rules apply as to any app call.

**Import…** reads a link GitHub doesn't serve publicly (a private `github.com/<owner>/<repo>/tree/<ref>/<path>`, a
`blob/…/bot.md`, a repository) through the same connection, only after the public read found nothing, with the public
reader's caps (1 MB for bot.md or team.md, 4 MB and 300 files in all, only the files it names). Without a connection,
the not-found sentence adds "If the repository is private, connect GitHub in Apps first."

Both go from the server through the connected-apps service (Composio's GitHub tools, `server/share-github-repo.ts`): the
token never reaches the app or a model. The tool names and answer shapes follow Composio's documentation and are
checked against a fake in tests, not yet against the live service.

## A team's own templates

On a Team Cloud, its owner and admins get **Add to {team}'s templates** (the card's **…**, and a department's Share).
It saves the template folder as it is now in the team's files, `team-files/templates/<slug>/` under the server's data
folder; adding one with the same slug again replaces it and keeps the one it replaced as `<slug>.previous/`. **Import…**
then lists **From {team}'s templates**, each with its name, whether it is a bot or a department, who added it and when;
opening one previews it like any other, and **Add** adds it. The trash button removes one from the list, and its folder
stays as `<slug>.previous/`. Templates, like packages and backups, are an admin's on a Team Cloud: members don't see the
list and the routes refuse them. Who added each and when is kept in `share/team-library.json`, outside the team's files;
a folder there is read through the folder reader and checked again at every import, like any other.

| Route | Who | |
|---|---|---|
| `GET /api/share/library` | owner, admin | `{ team, templates: [{ slug, name, scope, tagline, addedBy?, addedAt }] }`; 404 off a Team Cloud |
| `POST /api/share/<id>/library` | owner, admin | `{ template, replaced }` |
| `DELETE /api/share/library/<slug>` | owner, admin | `{ ok: true }` |
| `POST /api/share/import` `{ library: "<slug>" }` | owner, admin | as any import; `?preview=1` previews |
| `GET /api/share/github` | as Share | `{ connected, reason?, error? }` |
| `POST /api/share/<id>/publish-repo` `{ repo, folder?, direct? }` | as Share | `{ kind: "pull_request" \| "commit", url, link, branch }`; 409 `github_not_connected` |

## In chat

The `share` tool has the same actions: `export`, `publish`, `publish_to_repo` (`repo` as owner/repo, `path` its folder,
`direct`), `add_to_team_library`, `import`, `list_team_library` and `import_from_team_library` (`slug`). `import` and
`publish_to_repo` need the link or the `owner/repo` in the person's own message that started the turn. The team's
library actions and `publish_to_repo` need a person's own request on a Team Cloud from its owner or an admin, read from
the server's records of who the turn acts for, never from what the model says.

Backups are separate: Settings → Backup saves everything, chats included.
