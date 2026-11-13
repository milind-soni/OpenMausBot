# Gerer Build Studio: Copy Sweep & Plain-Language Implementation Spec

This document provides the exact string replacement table for **SoSo** to apply across the Gerer Build Studio codebase.

All changes follow the standards established in `docs/guide/glossary.md`. Technical jargon, internal developer names, and unexplained command-line syntax are replaced with clear, welcoming copy suitable for authors, designers, researchers, editors, and analysts.

---

## 1. Onboarding (`src/components/Onboarding.tsx`)

### 1.1 Friendly Install Commands Pattern

> [!IMPORTANT]
> Non-developers are frequently scared off by raw terminal commands like `npm i -g @anthropic-ai/claude-code`. 
> In the new design, each row leads with what the tool does. A collapsed **"Show command"** toggle exposes the command and a one-click copy button only when requested.

#### Recommended Component Helper for SoSo
```tsx
function InstallHelp({ command, docUrl }: { command?: string; docUrl?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-3">
        {command && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-[12px] font-medium text-accent hover:underline focus:outline-none"
          >
            {open ? "Hide command" : "Show install command"}
          </button>
        )}
        {docUrl && (
          <a
            href={docUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-ink-secondary hover:text-ink hover:underline"
          >
            Setup guide ↗
          </a>
        )}
      </div>
      {open && command && (
        <div className="mt-1.5 flex items-center justify-between rounded-lg bg-inset p-2 font-mono text-[11px] text-ink border border-hairline/40">
          <span className="truncate">{command}</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="ml-2 shrink-0 rounded bg-raised px-2 py-0.5 text-[10.5px] text-ink hover:bg-raised-hover"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
```

### 1.2 Exact String Replacement Table

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `Onboarding.tsx:136-137` | `Bots that do real work on their own computer. Tell us who you are and we’ll let you know when big things ship.` | `Bots that do real work on your computer. Tell us who you are to personalize your workspace.` | Focuses on user benefit rather than cloud computer abstractions. |
| `Onboarding.tsx:179` | `<h1 className="text-[18px] font-semibold text-ink">Your engines</h1>` | `<h1 className="text-[18px] font-semibold text-ink">Your AI apps</h1>` | "Engines" is replaced by "AI apps". |
| `Onboarding.tsx:181` | `Bots run on the AI tools already on {hostLabel} — here’s what we found.` | `Bots run on the AI apps already installed on {hostLabel} — here’s what we found.` | Natural phrasing. |
| `Onboarding.tsx:197-200` | `"Installed and signed in — ready to power bots."` / `"Installed. Run \`claude\` once in a terminal to sign in."` / `"Not found. Install: npm i -g @anthropic-ai/claude-code"` | Available & signed in: `"Installed and ready to power your bots."`<br>Signed out: `"Installed. Sign in to your Claude account to connect."`<br>Missing: `"Not installed yet. Claude gives your bots deep writing and reasoning capabilities."` | Command `npm i -g @anthropic-ai/claude-code` and sign-in `claude` move behind `<InstallHelp command="..." />`. |
| `Onboarding.tsx:208-210` | `"Installed — bots can run on Codex too."` / `"Optional. Install: npm i -g @openai/codex"` | Available: `"Installed — your bots can use OpenAI Codex models."`<br>Missing: `"Optional. Gives your bots access to OpenAI models."` | Command `npm i -g @openai/codex` moves behind `<InstallHelp command="..." />`. |
| `Onboarding.tsx:219-222` | `"Installed and signed in — bots can run on Grok too."` / `"Installed. Run \`grok login\` in a terminal to sign in."` / `"Optional. Install: curl -fsSL https://x.ai/cli/install.sh \| bash"` | Available & signed in: `"Installed and ready — your bots can use xAI Grok."`<br>Signed out: `"Installed. Sign in to your xAI account to connect."`<br>Missing: `"Optional. Gives your bots access to xAI Grok models."` | Command `curl -fsSL https://x.ai/cli/install.sh \| bash` moves behind `<InstallHelp command="..." />`. |
| `Onboarding.tsx:230-232` | `"Installed — bots can run on Antigravity too."` / `"Optional. Install: see antigravity.google/docs/cli"` | Available: `"Installed — your bots can use Google Antigravity."`<br>Missing: `"Optional. Advanced multi-agent models from Google."` | Link provided via `docUrl="https://antigravity.google/docs/cli"`. |
| `Onboarding.tsx:251` | `<h1 className="text-[18px] font-semibold text-ink">Permissions</h1>` | `<h1 className="text-[18px] font-semibold text-ink">Studio permissions</h1>` | Welcoming title. |
| `Onboarding.tsx:253` | `Optional, and only ever used when you ask for the feature.` | `Optional device access used only when you start the feature. You can change these anytime in Settings.` | Emphasizes optionality and user control without overstating local-only AI behavior. |
| `Onboarding.tsx:262-263` | `Voice dictation into the composer, transcribed on-device.` | `Speak your messages instead of typing. Speech is transcribed on your computer when on-device recognition is available, or may fall back to your system speech service when unavailable.` | Qualifies on-device recognition vs. system speech fallback truthfully. |

---

## 2. Projects Screen (`src/components/ProjectsScreen.tsx`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `ProjectsScreen.tsx:40` | `if (project.source === "github") return "GitHub clone";` | `if (project.source === "github") return "From GitHub";` | Removes "clone". |
| `ProjectsScreen.tsx:41` | `if (project.source === "created") return "Created here";` | `if (project.source === "created") return "New project folder";` | Clearer distinction. |
| `ProjectsScreen.tsx:42` | `return "Existing folder";` | `return "Folder on this computer";` | Grounded in user's physical machine. |
| `ProjectsScreen.tsx:91` | `title: "Choose an existing project folder",` | `title: "Choose a project folder on your computer",` | OS folder picker dialog title. |
| `ProjectsScreen.tsx:122` | `title: forClone ? "Choose where to clone the repository" : "Choose a parent folder",` | `title: forClone ? "Choose where to save this project" : "Choose where to create this folder",` | Eliminates "clone" and "repository". |
| `ProjectsScreen.tsx:159` | `{mode === "choose" ? "Add a project" : mode === "existing" ? "Add an existing folder" : mode === "create" ? "Create a project folder" : "Clone from GitHub"}` | `{mode === "choose" ? "Add a project" : mode === "existing" ? "Add a folder from your computer" : mode === "create" ? "Create a new project folder" : "Copy a project from GitHub"}` | Modal title header. |
| `ProjectsScreen.tsx:179-180` | `<div className="mt-3 text-[14px] font-medium text-ink">Existing folder</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Add a project already on this computer.</div>` | `<div className="mt-3 text-[14px] font-medium text-ink">Folder on your computer</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Pick an existing folder where your files live.</div>` | Plain card label. |
| `ProjectsScreen.tsx:187-188` | `<div className="mt-3 text-[14px] font-medium text-ink">New folder</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Create a clean project directory.</div>` | `<div className="mt-3 text-[14px] font-medium text-ink">New folder</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Create an empty folder for a new project.</div>` | "Directory" → "folder". |
| `ProjectsScreen.tsx:195-196` | `<div className="mt-3 text-[14px] font-medium text-ink">Clone GitHub</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Clone a repository into a chosen path.</div>` | `<div className="mt-3 text-[14px] font-medium text-ink">From GitHub</div>`<br>`<div className="mt-1 text-[12px] leading-5 text-ink-secondary">Copy a project from GitHub to your computer.</div>` | "Clone a repository into a path" → plain English. |
| `ProjectsScreen.tsx:202` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Folder path on the host machine</span>` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Folder location on your computer</span>` | "Path on the host machine" is jargon. |
| `ProjectsScreen.tsx:228` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Create inside</span>` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Where to create it</span>` | Friendly label. |
| `ProjectsScreen.tsx:252-258` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">GitHub repository</span>`<br>`placeholder="https://github.com/owner/repository"` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">GitHub web link</span>`<br>`placeholder="https://github.com/organization/project"` | Non-programmers understand links. |
| `ProjectsScreen.tsx:262` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Destination path</span>` | `<span className="mb-1.5 block text-[13px] font-medium text-ink">Where to save on your computer</span>` | Plain wording. |
| `ProjectsScreen.tsx:267` | `placeholder="Choose a location, then edit the final path"` | `placeholder="Choose a folder to save this project into"` | User-centric instruction. |
| `ProjectsScreen.tsx:273-275` | `Public repositories work immediately. Private repositories use the host machine's Git credential or SSH setup.` | `Public projects download right away. For private projects, your computer must already have permission to access them.` | Non-engineers don't know "SSH setup". |
| `ProjectsScreen.tsx:282` | `{busy ? "Cloning repository…" : "Clone project"}` | `{busy ? "Copying project…" : "Copy project"}` | Consistent "copy" terminology. |
| `ProjectsScreen.tsx:322` | `<p className="hidden truncate text-[12px] text-ink-secondary sm:block">Local workspaces for your bots and code.</p>` | `<p className="hidden truncate text-[12px] text-ink-secondary sm:block">Workspaces where your bots read, write, and create files.</p>` | Accommodates authors, researchers, and designers. |
| `ProjectsScreen.tsx:348` | `placeholder="Search projects or paths"` | `placeholder="Search projects or folder locations"` | Replaces "paths". |
| `ProjectsScreen.tsx:371-372` | `Add an existing folder, create a fresh workspace, or clone a repository from GitHub. Browser sessions use paths on the host machine.` | `Add a folder from your computer, create a new one, or copy a project from GitHub to give your bots a workspace.` | Empty state copy. |

---

## 3. Settings Screen (`src/components/SettingsScreen.tsx`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `SettingsScreen.tsx:89` | `Shown in the sidebar and attributed to your user actions.` | `Shown in the sidebar and attached to notes or tasks you create.` | Plain attribution note. |
| `SettingsScreen.tsx:141-142` | `Gerer Build Studio stores your profiles, bot threads, and configurations locally. Usage analytics is off until you enable it in System settings.` | `Gerer Build Studio stores your profiles, conversations, and project files locally on this computer. Usage analytics is off until you turn it on in System settings.` | Replaces "threads" and "configurations". |
| `SettingsScreen.tsx:223` | `<h2 className="text-[16px] font-semibold text-ink">API Keys & Integrations</h2>` | `<h2 className="text-[16px] font-semibold text-ink">Access Keys & Connected Tools</h2>` | "Access keys" and "Connected tools". |
| `SettingsScreen.tsx:225-226` | `Shared across all bots and workspaces. Stored locally in write-only storage; saving instantly hot-reloads provider drivers.` | `Shared across all bots and projects. Stored securely on your computer and never sent to outside servers.` | Removes "hot-reloads provider drivers". |
| `SettingsScreen.tsx:233-238` | `Composio Connect Key`<br>`Powers tool execution and web services like GitHub, Google, Slack, and Jira across your bots.` | `Composio Connection Key`<br>`Connects external tools and web services (Google Drive, Gmail, GitHub, Figma, Slack) so your bots can take action for you.` | Highlight creative tools (Drive, Figma). |
| `SettingsScreen.tsx:244-249` | `Composio API Key (Optional)`<br>`Required only if you wish to query the complete unbounded Composio catalog or use advanced developer action triggers.` | `Composio Advanced Key (Optional)`<br>`Only needed if you are building custom actions or require specialized developer toolsets.` | "Advanced developer action triggers" simplified. |
| `SettingsScreen.tsx:252-262` | `Box Cloud Token ...` | *(Omit — feature is being completely removed)* | As instructed by Yv. |
| `SettingsScreen.tsx:266-271` | `xAI API Key`<br>`Configures credentials for xAI Grok provider models and ACP drivers without requiring local CLI login.` | `xAI Access Key`<br>`Connects xAI Grok models directly to your bots without needing terminal commands.` | Replaces "ACP drivers" and "CLI login". |
| `SettingsScreen.tsx:288-290` | `Link registered projects to Trello boards from the Task Board to sync tasks both ways. The API key identifies this app; connecting authorizes it with your own Trello account and never leaves your machine.` | `Connect your projects to Trello boards to sync tasks in both directions. Your keys stay securely on this computer.` | Concise and non-technical. |
| `SettingsScreen.tsx:299-302` | `Write-Only Security Guarantee`<br>`All credentials entered here are persisted with restrictive filesystem permissions in ~/.gbs/config.json. The API never echoes secret keys back to the client.` | `Private & Secure Storage`<br>`All keys entered here are saved in your private computer settings and never sent to outside servers or shown again in plain text.` | Replaces UNIX permission jargon. |
| `SettingsScreen.tsx:345` | `<h2 className="text-[16px] font-semibold text-ink">Active Model Providers & CLIs</h2>` | `<h2 className="text-[16px] font-semibold text-ink">Connected AI Apps & Models</h2>` | User-friendly header. |
| `SettingsScreen.tsx:347` | `Live drivers detected by the local harness server on your machine.` | `AI apps and tools detected on this computer.` | Removes "live drivers" and "harness server". |
| `SettingsScreen.tsx:364-365` | `No providers registered yet`<br>`Make sure the harness server is running (pnpm dev:server).` | `No AI apps detected yet`<br>`Install an AI app such as Claude Code or connect an access key under Connections to power your bots.` | Actionable for non-developers. |
| `SettingsScreen.tsx:391` | `CLI version: <span className="font-mono">{inst.snapshot.version}</span>` | `Version: <span className="font-mono">{inst.snapshot.version}</span>` | Drops "CLI". |
| `SettingsScreen.tsx:422` | `{inst.autoApprove ? "Full auto" : "Ask before actions"}` | `{inst.autoApprove ? "Always allow actions" : "Ask before making changes"}` | Clear, reassuring permission language. |
| `SettingsScreen.tsx:425-427` | `{inst.autoApprove ? "Edits, commands, and tools run without asking." : "You'll be asked to approve edits, commands, and tools."}` | `{inst.autoApprove ? "The bot can edit files, run tools, and save work without waiting for confirmation." : "The bot will pause and ask for your confirmation before editing files or running external tools."}` | Explicit, plain explanation. |
| `SettingsScreen.tsx:474` | `Available Models` | `Available AI Models` | Consistent terminology. |
| `SettingsScreen.tsx:508-531` | `Provider CLI Setup Reference`<br>`Gerer Build Studio connects directly to your authorized local developer CLIs:` | Wrap in `<details>` disclosure:<br>**"Advanced: Command Line Setup Reference"**<br>`"For power users and developers: install and sign in to optional AI tools using these terminal commands:"` | Technical setup stays available but is tucked neatly away for power users. |
| `SettingsScreen.tsx:618-621` | `Auto-approve permission cards`<br>`Allow pending actions after no activity in the app, including file changes and commands. Questions always wait for your answer.` | `Automatic approvals when inactive`<br>`Automatically approve pending file edits and tool actions after a short pause. Important questions will always wait for your response.` | "Permission cards" → "Approvals". |
| `SettingsScreen.tsx:690-693` | `Automatic Agent Handoffs`<br>`Automatically dispatch messages to mentioned team bots across all multi-agent rooms. Enabled by default for all rooms.` | `Automatic Team Handoffs`<br>`When you mention another bot with @name in a room, let that bot reply automatically. Enabled by default.` | Replaces "dispatch" and "multi-agent rooms". |
| `SettingsScreen.tsx:791-794` | `System Diagnostics & Storage`<br>`Local services and data stores driving your bots and tasks.` | `System Details & Storage`<br>`Where your conversations, settings, and task data are stored.` | Replaces "data stores". |
| `SettingsScreen.tsx:801-803` | `Local Harness Server`<br>`Loopback IPC transport on 127.0.0.1:8899` | `Studio App Engine`<br>`Running locally on this computer (internal connection)` | Eliminates "Loopback IPC transport". |
| `SettingsScreen.tsx:820-822` | `Local Data Directory`<br>`~/.gbs (Threads, logs, configurations)` | `Storage Folder`<br>`~/.gbs (Conversations, settings, and task data)` | Friendly descriptions. |

---

## 4. Settings Panel (`src/components/SettingsPanel.tsx`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `SettingsPanel.tsx:138` | `placeholder="Describe what your agent does"` | `placeholder="Describe what this bot helps you with"` | "Agent" → "Bot". |
| `SettingsPanel.tsx:146` | `placeholder="What this agent is for — use # for its default project"` | `placeholder="What this bot does — use # to pick its default project folder"` | Clear instruction. |
| `SettingsPanel.tsx:154-157` | `<div className="text-[15px] font-medium text-ink">Model</div>`<br>`<div className="mt-0.5 text-[13px] text-ink-secondary">Which provider and model this bot runs on</div>` | `<div className="text-[15px] font-medium text-ink">AI Model</div>`<br>`<div className="mt-0.5 text-[13px] text-ink-secondary">Which AI app and version powers this bot</div>` | Brand and model clarity. |
| `SettingsPanel.tsx:162-184` | `Computer ... Where this bot's computer runs...` | *(Omit — feature is being completely removed)* | As instructed by Yv. |
| `SettingsPanel.tsx:192-193` | `Get notified when this agent finishes or needs input` | `Get notified when this bot finishes working or needs your input` | "Agent" → "Bot". |

---

## 5. Chat View (`src/components/ChatView.tsx`)

### 5.1 Activity Chips (`ActivityChip`)
Currently, `ActivityChip` displays raw tool names directly:
`<span className="max-w-[480px] truncate font-mono">{tool.name}</span>`

#### Recommended Friendly Mapping for SoSo
```tsx
function friendlyToolLabel(name: string): string {
  if (name === "read_file" || name === "read_multiple_files") return "Reading file";
  if (name === "write_file" || name === "edit_file") return "Updating file";
  if (name === "run_command" || name === "bash") return "Running task";
  if (name === "list_tasks" || name === "update_task" || name === "create_task") return "Checking task board";
  if (name === "list_bots" || name === "ask_bot") return "Consulting teammate";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const service = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : "Tool";
    const action = parts[2]?.replace(/_/g, " ") ?? "action";
    return `${service}: ${action}`;
  }
  return name.replace(/_/g, " ");
}
```

Display `friendlyToolLabel(tool.name)` as the primary text, keeping `{tool.name}` available on hover or secondary click.

### 5.2 Error Rows (`ErrorRow`)
Currently, `ErrorRow` prints the raw error message verbatim:
`<span className="min-w-0 break-words">{message}</span>`

#### Recommended Friendly Error Classifier for SoSo
```tsx
function friendlyErrorMessage(raw: string): { summary: string; technical?: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("rate_limit") || lower.includes("quota") || lower.includes("429") || lower.includes("usage limit")) {
    return {
      summary: "Usage limit reached for this AI app. You can switch to your backup model or wait for usage to refresh.",
      technical: raw,
    };
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused") || lower.includes("failed to fetch")) {
    return {
      summary: "Could not connect to the local AI app. Make sure it is installed and running on your computer.",
      technical: raw,
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      summary: "The AI app took too long to reply. Try clicking Retry.",
      technical: raw,
    };
  }
  return { summary: raw };
}
```

Render `summary` in normal weight text, and provide a small **"Details"** toggle button when `technical` is present.

### 5.3 Empty State (`ChatView.tsx:495`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `ChatView.tsx:495` | `{intro.summary ? <ProjectMentionText text={intro.summary} /> : "Send a message to start the conversation."}` | `{intro.summary ? <ProjectMentionText text={intro.summary} /> : "Send a message or pick an idea below to get started."}` | Proactive invitation. |

---

## 6. Task Board Screen (`src/components/TaskBoardScreen.tsx`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `TaskBoardScreen.tsx:243` | `<span className={label}>Acceptance criteria <span className="font-normal">· one per line</span></span>` | `<span className={label}>Definition of done <span className="font-normal">· checklist (one per line)</span></span>` | "Acceptance criteria" is agile jargon. "Definition of done" or "Checklist" is plain. |
| `TaskBoardScreen.tsx:247` | `<span className={label}>Agent</span>` | `<span className={label}>Assigned bot</span>` | "Agent" → "Bot". |
| `TaskBoardScreen.tsx:248` | `<option value="">No project</option>` | `<option value="">No project folder</option>` | Plain language. |
| `TaskBoardScreen.tsx:250` | `<span className={label}>Type</span>` | `<span className={label}>Category</span>` | "Category" feels natural for non-developers. |
| `TaskBoardScreen.tsx:254` | `<span className={label}>Tags <span className="font-normal">· comma separated</span></span>` | `<span className={label}>Labels <span className="font-normal">· comma separated</span></span>` | "Labels" aligns with design tools. |
| `TaskBoardScreen.tsx:591` | `<select ... aria-label="Filter by agent"><option value="">All agents</option><option value="unassigned">Unassigned</option>...` | `<select ... aria-label="Filter by bot"><option value="">All bots</option><option value="unassigned">Unassigned</option>...` | Replaces "agent" with "bot". |
| `TaskBoardScreen.tsx:618` | `{filterCount ? "No matching tasks" : "Drop a task here"}` | `{filterCount ? "No tasks match your filters" : "No tasks yet · click + to add one"}` | Friendly empty state. |

---

## 7. Sidebar (`src/components/Sidebar.tsx`)

| File & Line | Current Text | Proposed Plain Replacement | Notes / Context |
|---|---|---|---|
| `Sidebar.tsx:203` | `"Wait for the room's agents to finish before clearing"` | `"Wait for the bots to finish before clearing"` | "Agents" → "bots". |
| `Sidebar.tsx:219 & 408` | `"Copy conversation ID"` | `"Copy conversation ID"` | Keep exact text, but ensure tooltip states: `"Copy ID for support or reference"`. |
| `Sidebar.tsx:419` | `"Wait for the agent to finish before clearing"` | `"Wait for the bot to finish before clearing"` | "Agent" → "bot". |

---

## 8. Starter Suggestions for `src/lib/botIntro.ts`

To make Gerer Build Studio equally valuable to writers, editors, scientists, researchers, and business analysts, update the role matching patterns and provide specialized starters in `src/lib/botIntro.ts`.

### 8.1 Copy Deck for New Roles

#### 1. Writer & Editor
- **Role Match:** `writer`, `editor`, `copywriter`, `author`, `content`, `editorial`, `journalist`, `story`
- **Starters:**
  1. *"Draft an article or essay from my notes"*
  2. *"Edit and polish this text for clarity and tone"*
  3. *"Rewrite this draft for a specific audience"*

#### 2. Researcher & Scientist
- **Role Match:** `research`, `scientist`, `scholar`, `academic`, `biology`, `physics`, `data science`, `investigat`
- **Starters:**
  1. *"Summarize recent findings on a topic"*
  2. *"Extract key insights and citations from this paper"*
  3. *"Help me structure a research study or grant proposal"*

#### 3. Analyst & Strategist
- **Role Match:** `analyst`, `strategy`, `finance`, `operations`, `consultant`, `metrics`, `intelligence`
- **Starters:**
  1. *"Analyze trends and patterns in my notes"*
  2. *"Draft an executive summary and recommendations"*
  3. *"Compare two strategic options with pros and cons"*

#### 4. Role-Neutral Defaults
- **Replaces:** `["What can you help me with?", "Plan a small project", "Review some code"]`
- **New Neutral Starters:**
  1. *"Plan a project or upcoming goal"*
  2. *"Summarize a document or notes"*
  3. *"Draft something new for me"*

### 8.2 Drop-In Code Replacement for `src/lib/botIntro.ts`

```typescript
const STARTERS: Array<[RegExp, string[]]> = [
  [/\b(ceo|founder|manager|pm|lead project)\b/i, [
    "Plan a roadmap for my project",
    "Break a feature into tasks for the team",
    "Summarize where our open tasks stand",
  ]],
  [/\b(write|writer|author|editor|copywriter|editorial|content|journalist)\b/i, [
    "Draft an article or essay from my notes",
    "Edit and polish this text for clarity and tone",
    "Rewrite this draft for a specific audience",
  ]],
  [/\b(research|scientist|scholar|academic|biology|science|investigat)\b/i, [
    "Summarize recent findings on a topic",
    "Extract key insights and citations from this paper",
    "Help me structure a research study or grant proposal",
  ]],
  [/\b(analyst|analytics|strategy|finance|operations|consultant|metrics)\b/i, [
    "Analyze trends and patterns in my notes",
    "Draft an executive summary and recommendations",
    "Compare two strategic options with pros and cons",
  ]],
  [/\b(develop|engineer|programm|coder)/i, [
    "Review this project's architecture",
    "Find and fix a failing test",
    "Scaffold a new feature",
  ]],
  [/\bmarket|brand|growth/i, [
    "Draft a launch announcement",
    "Write social posts for our next release",
    "Outline a campaign plan",
  ]],
  [/\b(design|ui|ux)/i, [
    "Critique a screen's layout",
    "Map the onboarding user journey",
    "Propose a color and type system",
  ]],
  [/\b(test|qa|quality|review)/i, [
    "Test a feature and list the bugs",
    "Write a QA checklist for a release",
    "Review recent changes for flaws",
  ]],
];

const DEFAULT_STARTERS = [
  "Plan a project or upcoming goal",
  "Summarize a document or notes",
  "Draft something new for me",
];
```
