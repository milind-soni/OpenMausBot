# Sharing a bot or a department

A bot or a whole department can be shared as a **template**: a small folder anyone can add to their own MausBot.

- **A bot.** Ask it in chat ("publish yourself to GitHub", "export yourself"), or use **Share → Share as template**.
  The app sends the bot "Create a public template of yourself that I can share with somebody else"; the bot makes the
  folder, takes personal details out of it, and shows one card with **Publish** and **Details**.
- **A department.** The department's **…** → **Share** shows its card at once, with **Publish to community** and
  **Save folder…**. A Chief can also be asked in chat to share its department.
- **Adding one.** **+** → **Import…**: paste a GitHub link or choose a folder, look at what it brings, then **Add**.
  A bot can also add one when you paste the link or folder path in your own message ("import <link>").

## What the folder holds

```
<name>/
  bot.md or team.md          the bots, their instructions, group chats, the Chief, routines and apps by name
  skills/<name>/SKILL.md     every skill, as standard Agent Skills
  avatars/<key>.webp         pictures, at most 64 KB each
```

`bot.md` and `team.md` are BotMRR Markdown v2: YAML frontmatter with the template's fields, and a readable body any AI
agent can follow when the file is pasted in. Older files (BotMRR v1 Markdown, `team.mausteam.json`, package JSON) still
import.

Never in a template: chats, memory, keys, passwords, tokens, connection addresses, models, approval levels, folders,
computers or who may see a bot. Every text is checked for key- and password-shaped values, which are replaced; the card
says how many. Routines always arrive paused, and each app is connected with the new owner's own account.

## Publishing

**Publish** sends the folder to the MausBot Admin, which opens a pull request on the community repository
(`milind-soni/openmausbot-teams`); nobody needs a GitHub account. The card then has **Copy link**, a GitHub folder link
that **Import…** accepts, and **View on GitHub**. Publishing needs a MausBot sign-in; without one, the card offers
**Save folder…** and **Upload on GitHub**, the repository's own upload page.

Backups are separate: Settings → Backup saves everything, chats included.
