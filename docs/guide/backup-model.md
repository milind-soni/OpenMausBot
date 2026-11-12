# Backup Models: Never Get Interrupted When Usage Runs Out

Every AI provider—whether Anthropic (Claude), OpenAI (Codex/GPT), or xAI (Grok)—has limits on how much work you can run in a given hour or week. 

In most tools, hitting a limit means your work abruptly fails with a cryptic error code. In Gerer Build Studio, your bot simply hands the baton to a **Backup Model** and keeps right on working.

---

## 1. What Is a Backup Model?

A backup model is a secondary AI model you designate for a bot. If the bot's primary model runs out of usage allowance while working on a project, the bot switches to the backup model automatically and finishes the task without making you wait.

### Best Practice: Pair Different AI Apps
For the most reliable setup, we recommend choosing a backup model from a different AI app than your primary model:
- **Primary:** Claude 3.5 Sonnet / Claude Opus → **Backup:** OpenAI Codex / GPT-5
- **Primary:** OpenAI GPT-5 → **Backup:** Claude 3.5 Sonnet
- **Primary:** xAI Grok Build → **Backup:** Claude 3.5 Sonnet

Because Claude and OpenAI track usage on completely separate services, Claude running out will never affect your OpenAI allowance!

---

## 2. How to Set a Backup Model

You can add a backup model to any bot in seconds:

1. Click on the bot in the left sidebar to open its chat.
2. Click the **Settings icon** in the top right header (or right-click the bot in the sidebar and choose **Edit Profile**).
3. Scroll to the **AI Model** section.
4. Under **Backup model**, pick an alternate model from the dropdown.
5. Choose what should happen under **When usage runs out**:
   - **Switch to backup model (Recommended):** The bot will switch immediately and finish the current task.
   - **Wait and continue:** The bot will automatically schedule itself to resume as soon as your main model's allowance refreshes.
   - **Stop and tell me:** The bot will pause and post a message letting you choose your next move.
6. Your settings save automatically!

---

## 3. How Auto-Switching Works in Practice

When your bot encounters a usage limit:

1. **Seamless transition:** The bot detects the out-of-credit status and hands off the current conversation to your backup model.
2. **Clear notice in the chat:** The bot posts a friendly line:
   > *"Switched to GPT-5 because Claude's usage ran out. Continuing your task…"*
3. **"Using backup" badge:** A compact indicator appears beside the model picker in the header so you always know which model is speaking.
4. **Automatic return:** When your primary model's usage refreshes (for example, at the top of the hour), the bot automatically switches back to your primary model for your next new message.

*(Coming soon: One-click option from the badge to permanently keep the backup model as your primary).*

---

## 4. What If I Don't Have a Backup Model Configured?

If you don't configure a backup model, your bot defaults to **Wait and continue**:

- The bot calculates when your AI app's usage resets (for example, at 3:42 PM).
- It creates an automatic scheduled run:
  > *"Claude's usage ran out. I'll pick this up automatically at 3:42 PM."*
- You can click **Resume now** at any time if you'd like to retry immediately, or **Cancel auto-resume** to clear the timer.

---

## 5. Keep an Eye on Your Usage

You don't have to wait for usage to run out to know where you stand. Check the **Usage Rings** in the top bar anytime to see your live remaining balance. 

Read our [Usage & Limits Guide](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/usage-and-limits.md) to learn how to read your usage rings and avoid surprises.
