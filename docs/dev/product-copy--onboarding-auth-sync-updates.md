# Product Copy Specification: Auth-First Onboarding, Local Fallback, Cloud Sync, and System Updates

**Document Version**: 1.0.0  
**Author**: Marty (Lead Marketer & Brand Strategist)  
**Task ID**: `79d6fe04-6149-4f81-9be1-7d3c23e7aa16`  
**Target Audience**: Developers (@SoSo) and UI/UX Designers (@Z)  
**Status**: Archived proposal for a later release


> The internal alpha uses local profiles, engine checks, and a workspace setup flow. See the [alpha launch plan](plans/implementation--internal-alpha-launch.md) for current scope.

---

## Executive Summary & Value Proposition Guidelines

Gerer Build Studio operates on a **Local-First, Cloud-Enhanced** paradigm. The copy must consistently reflect two core tenets:
1. **Cloud Account & Sync**: Optional, enabling seamless cross-device synchronization of agent fleet definitions, model preferences, and app configurations.
2. **Local Privacy & Fallback**: 100% non-coercive. Users who skip sign-in retain total app functionality, keeping all chat logs, prompt histories, and code diffs strictly on their local machine.

---

## 1. Onboarding Flow (`src/components/Onboarding.tsx`)

### Step 0A: Auth-First Account Sign-In / Registration

* **Header Title**: `Welcome to Gerer Build Studio`
* **Header Subtitle**: `Connect your account to synchronize your AI bot fleet, agent configurations, and provider settings across all your devices.`
* **Email Field Label**: `Account Email`
* **Email Field Placeholder**: `you@example.com`
* **Passcode Field Label**: `One-Time Passcode`
* **Passcode Field Placeholder**: `Enter 6-digit passcode`
* **Primary Button CTA**: `Sign In / Create Account`
* **Secondary / Fallback CTA**: `Continue with Local-Only Profile`
* **Footer Privacy Note**: `100% Local-First: Your chat history, prompt logs, and project code stay strictly on this machine.`

---

### Step 0B: Local Fallback (Name-Only Profile Setup)

*Triggered when the user selects "Continue with Local-Only Profile"*

* **Header Title**: `Set Up Your Local Profile`
* **Header Subtitle**: `Enter a display name to identify your local session. No account or email required—your work remains strictly local.`
* **Name Input Label**: `Display Name`
* **Name Input Placeholder**: `e.g. Alex Doe`
* **Primary Button CTA**: `Start Working Locally`
* **Back Button CTA**: `← Return to Account Sign-In`

---

### Step 1: Engine Diagnostics (`Your Engines`)

* **Header Title**: `Local Engine Diagnostics`
* **Header Subtitle**: `Gerer Build Studio harnesses the AI engines already installed on your system. Here is what we found:`
* **Status Card Copy**:
  * **Claude Code**:
    * *Available & Authenticated*: `Installed and signed in · Ready to power autonomous agents.`
    * *Available & Unauthenticated*: `Installed. Run 'claude' in Terminal to complete sign-in.`
    * *Not Found*: `Not detected. Optional. Install via: npm i -g @anthropic-ai/claude-code`
  * **Codex CLI**:
    * *Available*: `Installed · Ready to power Codex agents.`
    * *Not Found*: `Not detected. Optional. Install via: npm i -g @openai/codex`
  * **Grok Build**:
    * *Available & Authenticated*: `Installed and signed in · Ready for Grok agent execution.`
    * *Available & Unauthenticated*: `Installed. Run 'grok login' in Terminal to sign in.`
    * *Not Found*: `Not detected. Optional. Install via: curl -fsSL https://x.ai/cli/install.sh | bash`
  * **Antigravity / ACP**:
    * *Available*: `Installed · Ready for Agent Control Protocol drivers.`
    * *Not Found*: `Not detected. Optional. Visit antigravity.google/docs/cli`
* **Primary Button CTA**: `Continue`
* **Secondary Button CTA**: `Skip Engine Setup`

---

### Step 2: System Permissions (`Permissions`)

* **Header Title**: `System Permissions`
* **Header Subtitle**: `Optional system access requested only when you explicitly invoke voice or local computer features.`
* **Microphone Row**:
  * **Title**: `Microphone & Voice Dictation`
  * **Description**: `Enables voice dictation in the prompt composer, transcribed on-device.`
  * **Button States**: `Enable Access` | `Open System Settings` | `Granted ✓`
* **Primary Button CTA**: `Launch Gerer Build Studio`

---

## 2. Settings: Account & Cloud Sync (`src/components/SettingsScreen.tsx` - Sync Tab)

### Hero Status Card

* **Connected State**:
  * **Headline**: `Cloud Sync Active`
  * **Badge Text**: `● Connected to Convex`
  * **Body Text**: `Syncing agent configurations, fleet definitions, and provider settings with your account (user@example.com).`
  * **Button CTA**: `Sync Now` *(Loading state: `Syncing…`)*
* **Disconnected / Local-Only State**:
  * **Headline**: `Local Storage Only (Sync Off)`
  * **Badge Text**: `○ Unsynced / Offline`
  * **Body Text**: `Your workspace is operating strictly in local mode. Sign in to synchronize your bot fleet across devices.`
  * **Button CTA**: `Sign In to Sync`

---

### Privacy Guarantee Notice Box

* **Box Title**: `100% Local Chat Privacy Guarantee`
* **Box Content**: `Your chat transcripts, prompt histories, code diffs, and message logs remain strictly local on this machine and are NEVER uploaded or synchronized to cloud servers. Only agent definitions and non-sensitive app configurations are synced.`

---

### Encryption Passphrase & Security

* **Card Title**: `End-to-End Encryption Passphrase`
* **Card Subtitle**: `API keys and provider secrets are encrypted locally using AES-GCM before transmission. Convex servers only store opaque ciphertext.`
* **Passphrase Input Label**: `Sync Passphrase`
* **Passphrase Input Placeholder**: `Enter secret passphrase to decrypt keys`
* **Passphrase Helper / Warning**: `Important: Your sync passphrase is derived client-side and never sent to our servers. If you lose your passphrase, synced API keys cannot be decrypted on a new device and must be re-entered locally.`

---

### Per-Agent Fleet Sync Indicators

* **Section Title**: `Agent Fleet Sync Status`
* **Section Subtitle**: `Real-time synchronization status per configured bot agent.`
* **Status Badges**:
  * *Synced*: `● Synced to Cloud`
  * *Local Only*: `○ Local Only`
  * *Error / Stalled*: `▲ Sync Stalled`

---

## 3. System & Updates (`Settings > System & Updates`)

### Application Updates Panel

* **Section Title**: `Application Updates`
* **Status Microcopy**:
  * *Up-to-Date*: `Gerer Build Studio v0.1.14 is up to date.`
  * *Checking*: `Checking for application updates…`
  * *Available*: `Version {version} is available for download.`
  * *Downloading*: `Downloading update ({percent}% complete)…`
  * *Downloaded / Ready*: `Version {version} is downloaded and ready to install.`
  * *Error State*: `Unable to check for updates. Please verify network connectivity.`
  * *Browser Web Notice*: `Automatic app updates are supported in the Desktop app. You are currently using the Web interface.`
* **Action Buttons**:
  * `Check for Updates` *(Disabled/Loading state: `Checking…`)*
  * `Download Update`
  * `Restart & Apply Update`

---

## 4. Error & Recovery Microcopy

| Scenario | User-Facing Message | Actionable Guidance |
| :--- | :--- | :--- |
| **Auth - Invalid Passcode** | `Invalid passcode entered.` | `Please verify the passcode sent to your email and try again.` |
| **Auth - Rate Limited** | `Too many sign-in attempts.` | `Please wait a few minutes before trying again.` |
| **Sync - Passphrase Mismatch** | `Incorrect encryption passphrase.` | `Check your passphrase. Synced agent structures are active, but API keys require the correct passphrase to decrypt.` |
| **Sync - Network Drop** | `Cloud sync paused (Offline).` | `Your edits are saved locally. Sync will resume automatically when internet connectivity returns.` |
| **Updates - Download Failure** | `Update download interrupted.` | `Click 'Check for Updates' to retry downloading the latest release.` |

---

## 5. Integration Notes for Developers (@SoSo) & Designers (@Z)

1. **Typography & Spacing**: Maintain standard Tailwind utility styling in `SettingsScreen.tsx` (`text-[13px]`, `text-ink`, `text-ink-secondary`).
2. **Icons**: Use existing `lucide-react` icon pairings (`Cloud`, `CloudOff`, `Lock`, `ShieldCheck`, `RefreshCw`, `Download`, `RotateCw`).
3. **Accessibility**: All buttons and toggle inputs must carry proper `aria-label` and `accessibilityRole` tags.
