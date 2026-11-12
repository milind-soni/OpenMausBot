# Plain-Language Glossary: Gerer Build Studio

Gerer Build Studio is designed for everyone—authors, designers, editors, researchers, marketers, and analysts, as well as developers. 

To ensure the studio remains welcoming and intuitive, our interface avoids engineering jargon and internal tooling terminology in all primary screens, dialogs, empty states, and notification banners. 

Use this glossary when writing UI copy, error messages, user guides, or starter prompts.

---

## 1. Core Vocabulary Table

| Technical Term | Plain Replacement | When the Technical Term May Still Appear | Why We Avoid It |
|---|---|---|---|
| **engine / driver / harness** | **AI app**, **AI model**, or **AI tool** | Only in deep developer logs, CLI setup troubleshooting, or developer extension docs. Never in user-facing UI. | "Engine" sounds like internal machinery or a game engine. Non-technical users think in terms of tools or apps they use (Claude, OpenAI, Grok). |
| **repository / repo / clone** | **project folder**, **project**, or **copy from GitHub** | Under an "Advanced" toggle on the Add Project screen when configuring Git SSH keys or remote URLs. | "Repository" is Git jargon. Non-programmers create, open, and organize "projects" or "folders". |
| **path / directory** | **folder location**, **folder**, or **saved location** | In file selector breadcrumbs or read-only info boxes displaying exact disk locations (e.g., `~/.gbs`). | "Path" is UNIX/system terminology. Users look for folders on their computer. |
| **token / API key** | **access key**, **connection key**, or **account key** | On developer integration pages (e.g., Composio API key or xAI API key docs). Always paired with a plain description. | "Token" confuses authentication secrets with LLM text generation tokens. "Access key" clearly communicates permission to connect. |
| **MCP / tools** | **connected tools**, **apps & tools**, or **bot actions** | Under Developer Settings or when authoring custom Model Context Protocol servers in configuration files. | "MCP" is an internal protocol name. Non-developers understand "connected tools" (e.g., GitHub, Google Docs, Figma). |
| **localhost / private address / 127.0.0.1** | **this computer**, **running locally**, or **local connection** | Inside System Diagnostics (`Settings → System → Advanced Diagnostics`) for network debugging. | IP addresses and loopback URLs look like broken code or security alerts to non-engineers. |
| **rate limit / quota / credits / tokens** | **usage left**, **usage allowance**, or **usage refresh** | In small technical explanatory footnotes (e.g., *"Some AI apps call this a rate limit or usage quota"*). | Users don't care about rate windows; they want to know how much work they have left and when they can work again. |
| **commit / branch** | **save version**, **version**, or **alternate version** | In Git-backed project settings or developer documentation. In chat, say *"Switch to earlier version"* or *"Edit and create new branch"*. | Version control concepts should feel like familiar "undo", "version history", or "alternate draft" features. |
| **model** | **AI model** or the specific name (**Claude**, **GPT-5**, **Grok**) | Standard in the AI space, but always paired with the brand name or framed as *"Which AI model powers this bot"*. | "Model" alone can sound abstract (3D model, financial model, fashion model). Brand names ground the concept. |
| **prompt** | **message**, **instructions**, or **request** | Acceptable in bot configuration ("Bot instructions"), but chat composers should invite users to *"Send a message"* or *"Ask anything"*. | "Prompt" can feel intimidating like command-line programming. "Instructions" or "message" feels natural. |
| **permissions / approval / TCC** | **approval**, **allow action**, or **confirm access** | Only in macOS system dialog references (e.g., Microphone permission). | "TCC" and "permission gates" sound bureaucratic. "Ask before making changes" is plain and reassuring. |
| **sandbox** | **isolated workspace**, **safe test space**, or **preview window** | Advanced technical architecture guides. | "Sandbox" is vague outside software engineering. Users prefer knowing their files are safe and isolated. |
| **terminal commands (npm, curl, bash)** | **installation guide** or **setup command** | Behind a collapsed **"Show command"** toggle with a one-click copy button. Never raw in body text. | Monospaced shell commands (`npm i -g ...`) scare non-developers and cause immediate onboarding drop-off. |
| **CLI / shell / terminal** | **command line** or **terminal app** | In setup guides when explaining where a manual command may optionally be run. | Most creative users never open a terminal. Lead with automated setup or app installers whenever available. |
| **thread / threadId / conversationId** | **conversation**, **chat**, or **discussion** | Only in context menu item: *"Copy conversation ID"* (used when reporting an issue to support). | "Thread" sounds like message board forums or threading processes. "Chat" or "conversation" is universal. |
| **JSON / JSON-RPC / IPC** | **internal connection** or **data exchange** | Strictly restricted to System Diagnostics under Advanced Settings. | Pure developer transport terminology with zero relevance to end-user workflow. |
| **PR / Pull Request** | **proposed changes** or **review request** | When discussing GitHub-specific features or syncing code reviews. | In design, writing, or analysis workflows, work is "submitted for review" or shared as a "draft". |
| **auto-handoff / dispatcher** | **automatic team replies** or **team coordination** | Feature settings in multi-bot rooms. | "Dispatcher" sounds like 911 or taxi dispatch. "Automatic team replies" describes what actually happens. |
| **diff / git status** | **changes made** or **review edits** | In file activity chips and Preview Studio diff inspection panels. | "Diff" is technical slang. "See what changed" is instantly understood by editors and writers. |
| **system prompt / persona prompt** | **bot role & instructions** or **how this bot works** | Settings panel header: "Role & Instructions". | Explains function without making users learn prompt engineering theory. |

---

## 2. Writing Principles for Studio Copy

### Principle 1: Speak the User's Goal, Not the Software's Plumbing
- **Avoid:** *"Failed to spawn subprocess because Claude CLI is missing from PATH."*
- **Write:** *"Claude isn't installed on this computer yet. [See how to install it →]"*

### Principle 2: Calm, Non-Alarmist Status Messages
- **Avoid:** *"CRITICAL: Rate limit 429 exceeded! Quota exhausted until reset timestamp."*
- **Write:** *"Claude's usage ran out. I'll pick this up at 3:42 PM."*

### Principle 3: Progressive Disclosure for Technical Details
- Everyday users see a friendly, high-level summary with clear actions.
- Power users and developers can expand a **"Details"** or **"Show command"** disclosure to inspect raw inputs, paths, CLI commands, or stack traces.

### Principle 4: Consistent Personality Across Bots
- Gerer Build Studio bots are energetic, capable team members. 
- When an interruption occurs, bots communicate accountability and present a proactive next step:
  - *"I'm ready to keep going—do you want to switch to GPT-5 or wait until 3:40 PM?"*

---

## 3. Screen-by-Screen Copy Checklist

When authoring or updating any screen, verify against this quick checklist:

- [ ] Does this screen contain raw shell commands (`npm`, `brew`, `curl`, `pip`)? If yes, wrap them in a **"Show command"** toggle.
- [ ] Are paths displayed as full UNIX paths without context? Add a friendly label like *"Saved in your Documents folder"* or truncate with an "Open folder" icon.
- [ ] Does any button say "Clone"? Change to *"Add from GitHub"* or *"Copy project"*.
- [ ] Does any error display a raw error code (`ECONNREFUSED`, `404`, `429`)? Map to a plain sentence explaining what happened and what to do next.
- [ ] Are technical configuration sections grouped under an **"Advanced"** or **"System Details"** disclosure?
