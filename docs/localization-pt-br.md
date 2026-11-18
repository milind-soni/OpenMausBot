# Brazilian Portuguese (pt-BR) style guide and glossary

This guide sets the voice, mechanics and terminology for OpenMausBot in
Brazilian Portuguese. It extends [`localization.md`](localization.md), which
covers the catalog workflow and checks. When this guide and the English source
disagree about meaning, English wins. When they disagree about wording, this
guide wins.

## Purpose and scope

The guide covers every string a person reads in pt-BR:

- the interface catalog, `src/locales/pt-br.json`;
- text in the Electron shell that appears outside the window: the menu bar,
  the tray, dialogs and system notifications;
- server messages people see: `errorKey` and `textCode` messages carry
  parameters and an English fallback for client translation; `serverLine`
  messages arrive already localized for the person or conversation and must not
  be translated again by the client.

It does not cover bot or system prompts, tool descriptions written for models,
logs, developer or CLI errors, emails sent by the control plane, the docs site
(`apps/docs`), `companion/` or `enterprise/`. Those stay in English.

## Voice and tone

- **Speak to the person as `você`.** Never use `tu`, `o senhor` or `a
  senhora`. The app does not speak as `a gente`. When the company speaks
  about itself, which is rare, it uses `nós` and `nosso`, as in
  “Nosso provedor de hospedagem está reiniciando a máquina”.
- **Be friendly and professional.** Write the way a calm, competent colleague
  talks. Avoid slang (`pra`, `tá`, `beleza`), exclamation marks, and
  marketing excitement. Neither catalog uses exclamation marks.
- **No gerundismo.** Write “Vamos enviar o arquivo” or “O arquivo será
  enviado”, never “Vamos estar enviando”. Use the gerund only for actions in
  progress: “Enviando…”, “{name} está trabalhando…”.
- **Keep sentences short.** Split long English sentences when Portuguese needs
  more words. Keep one idea per sentence and lead with the action or the
  outcome.
- **Drop possessives Portuguese doesn't need.** Keep `seu` and `sua` when
  ownership matters (“Sua chave fica neste computador”) and drop them when
  context already says whose it is (“Escolha um plano” rather than “Escolha o
  seu plano”).
- **Avoid verbs built from English.** Write `excluir`, not `deletar`;
  `redefinir`, not `resetar`; `entrar` or `fazer login`, not `logar`;
  `definir`, not `setar`. Loanwords that Brazilians use every day are fine:
  `app`, `backup`, `chat`, `link`, `login` (as a noun), `download` (as a noun).
- **Errors say what happened and what to do.** Use the established pattern
  “Não foi possível {verbo}…”, followed by the next step. Don't
  write “Falha ao…” or “Erro ao…” in everyday copy.

## Mechanics

### Actions and labels

- **Buttons, menu items, toggles and action tooltips use the infinitive:**
  “Conectar ao servidor”, “Criar código de pareamento”, “Tentar novamente”.
- **Instructions in sentences use the imperative with `você`:** “Abra o
  Terminal e rode o comando.” Titles that invite the person to a step may use
  it too (“Escolha um plano”). Never use the imperative on a button.
- **Use sentence case everywhere,** including titles, tabs and menus.
  Capitalize only the first word and proper names: “Modo avançado”, “Mapa da
  equipe”, “Desktops dos bots”.
- **Use lower case for months and weekdays** (`outubro`, `segunda-feira`) and
  for languages and nationalities inside sentences.
- **Name controls exactly as they are labelled.** Copy that points at a
  control, page or menu uses the control's pt-BR label verbatim, the same rule
  `vocabulary.test.ts` enforces for English. Put a single label in curly
  quotes: Clique em “Entrar novamente”. Write a path with arrows and no
  quotes: Abra Configurações → Logins. When the target UI isn't localized, such
  as the Admin console, keep its English label (“Admin → Packages”). Don't
  leave a pt-BR control's English label behind: escolha “Add a Cloud” should
  be escolha “Adicionar um Cloud”.

### Punctuation

- **Quotes:** use typographic double quotes “ ”, and ‘ ’ inside them. Keep
  straight `"` only inside code, JSON and commands.
- **Ellipsis:** use the single character `…`, never `...`, with no space
  before it. Use it where English does: progress labels
  (“Carregando…”), menu items that open a dialog (“Adicionar um Cloud…”) and
  truncated examples.
- **Em dash:** use it only where English does, with spaces on both sides.
  Prefer a comma, colon or full stop when the dash only joins two clauses. The
  welcome flow (`onboarding.*`) never uses em dashes, which mirrors
  `words.test.ts`.
- **After a colon,** continue in lower case unless a proper name or a full
  quoted label follows.
- **Keep the Unicode arrow →** in navigation paths, the middle dot `·` in
  compact metadata, and `⌘`, `⇧` and key names (`Enter`, `Shift`, `Esc`)
  unchanged.

### Numbers, dates and units

- **Decimals take a comma and thousands take a point:** `1,5 s`, `8.000
  caracteres`, `1.440`. Version numbers, IP addresses and code keep their dots
  (`Ubuntu 24.04`, `1.0.41`). If an input field only accepts a dot, don't
  show a format it rejects; flag the field instead.
- **Put a space between a number and its unit** (`10 MB`, `5 min`, `1,5 s`),
  but not before `%` (`{percent}%`).
- **Dates and times come preformatted** in placeholders such as `{date}` and
  `{time}`. Never assemble them by hand. Write the surrounding words for the
  24-hour clock and Brazilian order: “às {time}”, “em {date}”, “até {date}”.
  If a placeholder shows an English date or an AM/PM time in the pt-BR app,
  report a formatting bug; don't work around it in the catalog.
- **Prices come preformatted in `{price}`.** Don't add `R$` or `US$`. Write
  “{price}/mês, mais impostos”.
- **Prefer “24 horas por dia” in sentences;** `24/7` is fine in tight labels.

### Placeholders

- **Keep every `{placeholder}` exactly, including repeats.** `pnpm
  i18n:check` rejects any change. Never translate the name inside the braces.
- **Put no article before a bot's or a person's name:** “Diga oi a {name}”,
  “as habilidades de {name}”, not “ao {name}” or “do {name}”. A bot can have
  any name, and `o Ana` is wrong.
- **Products with a fixed gender take their article:** “o Claude”, “o
  Codex”, “o OpenMausBot”, “o Cloud”. Use an article before `{engine}`,
  `{app}` or `{provider}` only when every possible value takes it.
  Otherwise, rephrase with `de`: “a conta de {provider}”, “o limite de
  {engine}”.
- **Keep gendered words away from a placeholder that names a bot.** Write
  “{name} já pode trabalhar” or “Tudo pronto com {name}” instead of “{name}
  está pronto”. When agreement can't be avoided, agree with the noun `bot`:
  “O bot {name} está pronto”.
- **Write sentences that survive an English value.** Some parameters, such as
  `{reason}`, `{error}` and `{status}`, can reach the client in English. Set
  them apart (“Motivo: {reason}”) instead of weaving them into a sentence.

### Grammatical gender of product nouns

Masculine: `o bot`, `o app`, `o Cloud`, `o MausBot Cloud`, `o desktop`, `o
navegador`, `o backup`, `o login`, `o webhook`, `o playbook`, `o plugin`, `o
Marketplace`, `o gatilho`, `o modelo`, `o provedor`, `o plano`, `o
servidor`.

Feminine: `a IA`, `a conversa`, `a habilidade`, `a rotina`, `a automação`, `a
equipe`, `a instalação`, `a VM local`, `a chave de API`, `a conta`, `a
ferramenta`, `a memória`, `a predefinição`, `a chamada`, `a sessão`.

Pronouns for a bot follow `o bot`: “ele”, “dele”, “as conversas dele”.

## Plain words, mirrored from English

English copy follows plain-words rules enforced by `everyday-words.test.ts`,
`welcome-words.test.ts`, `words.test.ts` and `vocabulary.test.ts`. No test
checks pt-BR words yet, so reviewers must check them by hand. Wherever the
English avoids an internal word, the Portuguese avoids it too:

| The English avoids | So pt-BR never writes | Write instead |
|---|---|---|
| engine | `motor`, `mecanismo`, `engine` | `IA` |
| instance | `instância` | `conta de IA` |
| server (on everyday screens) | `servidor` | `o app`, or `o Cloud` when it is hosted. `servidor MCP` and Discord or Slack servers keep the word. |
| Composio | `Composio` | `apps conectados` |
| cloud computer | `computador na nuvem` | `desktop na nuvem` |
| VPS | `VPS` | `sua própria máquina` |
| Local VM (on everyday screens) | `VM local` | `desktop privado` |
| workspace | `espaço de trabalho`, `workspace` | `instalação`, or leave it out |

Everyday screens are the key prefixes listed in `everyday-words.test.ts`:
chat, composer, approvals, sign-in, Today, notifications, the sidebar, the bot
panel, the Screen panel, MausBot Cloud flows, routines and automations, the
team map, Apps, and the Settings pages that Simple mode shows. On technical
screens, translate faithfully whatever the English says. For example,
`servidor` and `VM local` are correct there.

Three English words are scheduled to retire (they are `it.todo` in
`everyday-words.test.ts`). The pt-BR copy can already use the replacements
when it doesn't point at a control labelled with the old word:

- “This computer” → “este Mac” or “este PC” where the platform is known;
- “My Cloud” → “o Cloud”;
- “lend”, “lent” and “lending” → `compartilhar` or “deixar … usar”. Never
  write `emprestar`.

On the welcome screens (`onboarding.*` and `cloudWelcome.*`), `computador`
means only the person's own device (“este computador”, “seu computador”).

## Names kept as they are

These stay unchanged in every pt-BR string.

| Name | Why |
|---|---|
| OpenMausBot, MausBot | Product names. Never write `OMB` or `T3` (`vocabulary.test.ts`). |
| MausBot Cloud | Product name. `vocabulary.test.ts` requires it verbatim in every translation whose English contains it. Never write `OpenMausBot Cloud` or `MausBot Pro`. Treat it as masculine: “o MausBot Cloud”. |
| Cloud (short for MausBot Cloud) | Product name, masculine: “o Cloud”, “no Cloud”. The generic sky-and-servers cloud is `nuvem`: “desktop na nuvem”. |
| Boat | Name of a third-party provider. Write it only where the English says Boat; the test fails otherwise. |
| Jev, Maus, Grok Bot | Names of product features or characters. |
| Claude, Claude Code, ChatGPT, Codex, Grok, Gemini, Cursor, OpenCode, Antigravity, OpenAI, Anthropic, xAI, OpenRouter, Ollama, Groq, Cerebras | Third-party product and company names. |
| Slack, Discord, Telegram, WhatsApp, Gmail, Notion, GitHub, Chrome, Tailscale, Cloudflare Tunnel, Docker, Podman, Whop, Product Hunt | Third-party product names. |
| Admin, and labels inside the Admin console | The Admin console is not localized, so pointers keep its English labels. |
| `SKILL.md`, `MEMORY.md`, `config.toml`, `.ombbackup`, commands, paths, URLs, environment variables, keyboard keys | Code and file names. |
| MCP, API, CLI, URL, HTTPS, DNS, SSH, USB, ID, CSV, PNG, JPEG | Standard abbreviations. Use `IA` for AI, never `AI`. |
| Apps, Logins, Webhooks, Playbooks, Plugins, Marketplace, Backups | Section names that are also everyday Brazilian loanwords. Lower case inside sentences: “seus apps”, “um webhook”. |

Names of macOS and Windows settings follow Apple's and Microsoft's own pt-BR
wording. Examples: “Ajustes do Sistema → Privacidade e Segurança”, “Gravação
de Tela”, “Acessibilidade”, “Teclado”, “Finder”, “Terminal” on macOS;
“Configurações” and “Explorador de Arquivos” on Windows.

## Glossary

Change a term only after agreement with the pt-BR reviewers, and then update
the whole catalog in the same change.

| English | pt-BR | Notes |
|---|---|---|
| account | conta | “conta de IA” replaces “instance”. |
| Advanced mode | Modo avançado | Simple mode, if it is ever labelled: “Modo simples”. |
| agent | agente | Only where the English says agent. A bot is always `bot`. |
| AI | IA | Feminine: “a IA”, “as IAs”, “IA local”. Never `AI`, even if a draft tool keeps it. |
| API key | chave de API | Not “API key”. |
| app, apps | app, apps | Masculine. Not `aplicativo`. “Connected apps” → “Apps conectados”. |
| approval, approve | aprovação, aprovar | “Ask for approval” → “Pedir aprovação”; “approval level” → “nível de aprovação”. |
| Auto (mode) | Auto | Chip and room mode. “Automatic” in full → “Automático”. |
| automation | automação | Plural `automações`. Distinct from routine. |
| backup | backup | Masculine. “Restore” → “restaurar”. Not “cópia de segurança”. |
| bot | bot | Masculine. Never `robô` or `agente`. |
| brief | resumo | A bot's brief: “Brief” → “Resumo”. |
| browser | navegador | |
| call (voice) | chamada | “tool call” → “chamada de ferramenta”. Not “ligação”. |
| chat (the screen) | chat | The chat surface: “no chat”, “Abrir o chat”. A single thread is a `conversa`. |
| Chief of Staff | chefe de gabinete | Role label: “Chefe de gabinete”; “Make Chief of Staff” → “Tornar chefe de gabinete”. |
| Cloud (MausBot Cloud) | Cloud | Masculine: “o Cloud”. Generic cloud → `nuvem`. |
| cloud desktop | desktop na nuvem | Never “computador na nuvem”. |
| company | empresa | Organization → `organização`. |
| computer | computador | “This computer” (place) → “Este computador”; “this Mac” → “este Mac”. |
| connect, disconnect | conectar, desconectar | For apps, servers and devices. Signing in to an account is `entrar`. |
| conversation | conversa | Same word as thread. |
| delete | excluir | Destroys something. Different from remove. Never `deletar`. |
| department | equipe | Same word as team. The sidebar's groups of bots: “New department…” → “Nova equipe…”. |
| desktop (a bot's desktop) | desktop | Masculine. “Bot desktops” → “Desktops dos bots”. |
| desktop app | app para computador | Avoids a clash with the bot's desktop. The OS Desktop folder keeps the platform name: “Mesa” on macOS, “Área de Trabalho” on Windows. |
| device | dispositivo | “paired device” → “dispositivo pareado”. |
| download | baixar (verb), download (noun) | “Baixe o original”; “o download terminou”. |
| email | e-mail | With a hyphen. |
| enable, disable | ativar, desativar | Follow the English verb. See also turn on. |
| engine | IA | Never `motor` or `mecanismo`. “fallback engine” → “IA reserva”. |
| file, folder | arquivo, pasta | Never `ficheiro`. |
| installation | instalação | Replaces “workspace”. |
| instructions | instruções | “standing instructions” → “instruções permanentes”. |
| Live | Ao vivo | |
| Local VM | VM local | Technical screens only. Everyday screens: “desktop privado”. |
| Logins (saved site logins) | Logins | A single one is `login`. “Settings → Logins” → “Configurações → Logins”. |
| Marketplace | Marketplace | Masculine. |
| model | modelo | AI model. Template is also `modelo` (see template). |
| model provider | provedor de modelos | “provider” alone → `provedor`. |
| My Cloud | My Cloud | A place name, masculine (“o My Cloud”). It must match the Electron menu label. Prefer “o Cloud” in copy that doesn't point at the control. |
| On, Off | Ligado, Desligado | Toggle states. |
| pair, pairing | parear, pareamento | Never `emparelhar`. “pairing link” → “link de pareamento”. |
| passkey | chave de acesso | Google's pt-BR term. |
| phone | celular | The person's phone. `telefone` only for phone numbers. |
| plan | plano | “Plan page” → “página do Plano”. |
| playbook | playbook | Masculine. |
| plugin | plugin | Masculine. |
| preset | predefinição | “preset bot” → “bot predefinido”. Never `modelo`. |
| preview | prévia | “View” as a button → `Ver`. |
| private desktop | desktop privado | |
| Quit (app menu, tray) | Sair do OpenMausBot | The same label on every platform. Menus use sentence case, like the rest of the app. |
| remove | remover | Takes something out without destroying it. |
| retry, try again | Tentar novamente | Use “novamente” in labels and prose. If it would repeat in one sentence, use “de novo” for the first occurrence. |
| room | grupo | “group chat” → “chat em grupo”. Not `sala`. |
| routine | rotina | Scheduled work. Distinct from automation. |
| run | rodar or executar | Bots and routines `rodam`; commands, code and tools are `executados`; the noun “a run” → “execução”. |
| Screen (panel) | Tela | “the Screen panel” → “o painel Tela”. |
| search | buscar, busca | Labels: “Buscar…”. |
| server | servidor | Technical screens only (see plain words). “MCP server” → “servidor MCP”. |
| Settings (this app) | Configurações | The macOS app menu item “Preferences…” → “Configurações…” too. |
| share | compartilhar | Never `partilhar`. |
| sign in | entrar | Buttons: “Entrar”, “Entrar no Cloud”. In prose, use “fazer login” where `entrar` could mean going into a place. |
| sign-in (noun) | login | “browser sign-ins” → “logins do navegador”. |
| sign-in code | código de login | Not “código de acesso”, which sounds like passkey (“chave de acesso”). |
| sign out | sair | “Sign out of the Cloud” → “Sair do Cloud”. |
| skill | habilidade | Plural `habilidades`. `SKILL.md` and command names stay. |
| Soul (bot setting) | Essência | |
| System Settings (macOS) | Ajustes do Sistema | Apple's name. Windows Settings → “Configurações”. |
| tab | aba | Not `guia`. |
| team | equipe | Not `time`. “teammate” → `colega`. |
| Team map | Mapa da equipe | |
| template | modelo | “Templates” section → “Modelos”. Say “modelo de IA” if a sentence mentions both. |
| thread | conversa | Not `thread` or `tópico`. |
| trace (usage) | rastreamento | “View trace” → “Ver rastreamento”. |
| trial | teste | “free trial” → “teste grátis”; “trial credit” → “crédito do teste”. |
| trigger | gatilho | |
| turn (a bot's turn) | sessão | Feminine. Use “sessão de trabalho” only when the sentence also mentions a browser, sign-in or provider session. For calls, use “Um de cada vez” as the mode label and “falas alternadas” when describing it. |
| turn on, turn off | ligar, desligar | Follow the English verb. |
| upload | enviar | Never `upload` or `carregar`. |
| Vault (Settings section) | Cofre | “Settings → Vault” → “Configurações → Cofre”. A saved key there is a `segredo`. |
| wake, asleep | acordar, dormindo | Used for desktops and computers. |
| webhook | webhook | Masculine. |
| workspace | (do not use) | Say `instalação`, or leave it out. |

## Plurals

`t()` has no plural support. It replaces `{count}` and nothing else.

- **Key pairs.** English splits singular and plural into two keys, such as
  `…One` and `…Many`, and the code picks `One` only when the count is exactly
  1. Translate each key with its own grammar: “1 automação roda antes disso” /
  “{count} automações rodam antes disso”.
- **Zero uses the plural key,** which is natural in Brazilian Portuguese (“0
  bots”). When the English has a separate empty-state key, write it with
  `Nenhum`/`Nenhuma` or `Ainda não`: “Nenhum modelo encontrado”, “Nada
  agendado ainda”.
- **One key for any count.** Some English values use `(s)`. Don't copy `(s)`
  into Portuguese, where agreement spreads it across the phrase (“{count}
  bot(s) arquivado(s) continuarão arquivados”). Rephrase as a label and a
  number, which reads correctly for any count:
  - “{count} bot(s)” → “Bots: {count}”
  - “{count} paused routine(s)” → “Rotinas pausadas: {count}”
  - “{count} archived bot(s) will remain archived.” → “Bots que continuam
    arquivados: {count}.”
  - “{bots} bot(s) · {conversations} conversation(s)” → “Bots: {bots} ·
    Conversas: {conversations}”

  If a sentence really needs a number in the middle, ask for a singular and
  plural key pair in the English source rather than writing `(s)`.

## How to edit the pt-BR catalog

1. Edit `src/locales/pt-br.json` by hand. Keep every key identical to an
   English key and every placeholder unchanged. Don't add keys that English
   doesn't have.
2. Re-accept the edited values against their current English source:

   ```sh
   node scripts/generate-locale.mjs pt-br --accept
   pnpm i18n:check
   ```

3. Run the locale guards and the component tests that pin pt-BR values:

   ```sh
   pnpm exec vitest run src/locales src/lib/i18n.test.ts \
     src/components/ApprovalModeSelector.i18n.test.ts \
     src/components/ComputerPanel.i18n.test.ts \
     src/components/PluginsPanel.i18n.test.ts \
     src/components/SettingsModal.i18n.test.ts \
     src/components/Sidebar.i18n.test.ts \
     src/lib/chat-copy.i18n.test.ts
   ```

   If a value you changed on purpose is pinned in one of these tests, update
   the test with it.
4. Check the screens you changed in pt-BR on an isolated test instance, never
   your own app or data. See [`verification/README.md`](verification/README.md).
5. Commit `src/locales/source-hashes.json` together with the catalog.
6. A Brazilian Portuguese speaker reviews the change before it merges, as
   `CONTRIBUTING.md` requires. Model drafts are drafts, not authorities: check
   each one against this guide.

When English copy changes, `pnpm i18n:check` marks the old translation stale.
Re-translate it from the new English instead of re-accepting it unchanged.

Like every other pack, pt-BR may lag behind English: a missing key reads in
English until it is translated, and `pnpm i18n:check` doesn't fail on it. To
catch up, `node scripts/generate-locale.mjs pt-br` drafts missing and stale
keys; translate or review them and accept them as above. Drafts for pt-BR ask
the model for `IA` and the core terms of this glossary, but still check each
one against it.
