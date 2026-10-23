# Usage analytics

OpenMausBot can send anonymous product analytics to PostHog (US cloud, `us.i.posthog.com`), so its maintainers can see
which features people set up and use. This page lists every event and every property the app can send. Nothing else is
sent.

## What it is

- `posthog-js` loads only while the switch is on. With the switch off, the library is never downloaded and nothing is
  sent.
- Autocapture, pageviews, surveys and feature flags are off. Events come only from the calls listed on this page, and
  switching analytics back on sends no event of its own.
- Every event carries `app_version` (for example `0.1.112`) and `surface`: `local` for the desktop app's own window,
  `server` for a page a server serves (MausBot Cloud, a self-hosted server, or the app in a browser).
- PostHog adds its standard device facts to every event: operating system, browser and its version, device type,
  screen and window size, language and time zone. Like any server, PostHog sees the IP address a request comes from.
- Events are tied to a random id that PostHog keeps in the page's storage. If you shared your email on the first-run
  screen, your events are tied to that email from then on (`email_submitted`). If you are signed in to MausBot Cloud in
  the desktop app and choose the Cloud Pro popup's main button or Compare plans, your events on this computer's page are
  tied to your Cloud account's email from then on (`cloud_pro_popup`); My Cloud's Manage plan, and Continue on this
  computer on a server's page, are counted on that page as `continue` and finish on this computer's page, which counts
  what they open there. A server's page, My Cloud's included, is never told that email. While the desktop app has
  kept no analytics choice of its own yet, such a click on its page served on a port other than its first ties nothing,
  because an opt-out made before may be kept in the first port's storage. Nothing else identifies you.

## Turning it off

**Settings → General → Usage analytics.** When it is off, nothing loads and nothing is sent: no events, no daily
snapshot, and none of the snapshot's requests.

The desktop app keeps the switch for this computer's page itself, so it holds whichever port the app serves that page on
(it moves to another when its usual one is taken). It is read before anything loads, and before any email is tied to
your events. A switch turned off only in the page's storage, before the app kept it, does not hold on another port until
the app serves its page on that port again, which moves it to the app; while the app has kept no choice yet, its page on
a port other than its first ties no email to your events. Each server page (your MausBot Cloud, a self-hosted server,
each browser you use) keeps its own switch in that page's storage. With the switch off in the desktop app, a server page
that the app's window shows, My Cloud's included, starts with it off too once that server runs this version; turning it
on there lasts until that page reloads. In a browser, switch it off on each server's page.

## Never sent

- API keys, tokens or passwords, or anything derived from them: no length, prefix, hash or last characters.
- Names of bots, rooms, teams, people, routines, files, devices, models, presets or accounts.
- Emails, except the one you chose to share on the first-run screen, and your Cloud account's email once a click on the
  Cloud Pro popup's main button or Compare plans is counted on this computer's page while you are signed in to MausBot
  Cloud.
- URLs, hosts and addresses. PostHog's own `$current_url`, `$host`, `$pathname`, `$referrer`, `$referring_domain`,
  campaign parameters (`utm_*`, `gclid` and the like) and their `$initial_*` and `$session_entry_*` copies are removed
  before an event leaves the app.
- File paths, and ids of any kind: bot, room, conversation, instance, account or computer.
- Instructions, prompts, message content, model output and error messages.

## Allowed values

Properties are counts, `true` or `false`, or words from fixed lists in the app's code
(`src/lib/analytics-allowlist.ts`). A value that is not on its list is sent as `other`.

| List | Values |
| --- | --- |
| Key provider | `anthropic`, `openai`, `openrouter`, `openai_compat`, `xai`, `mistral`, `cerebras`, `groq`, `meta`, `boat`, `composio`, `opencode_go`, `custom_endpoint`, `elevenlabs`, `fish_audio`, `jev`, `openrouter_decider`, `openai_image`, `custom_image`, `openai_live`, `onepassword`, `treg` |
| Engine | `claude`, `codex`, `gemini`, `cursor`, `opencode`, `qwen`, `hermes`, `cline`, `custom_acp`, `pi`, `openai_compat`, `grok`, `grok_api`, `kimi`, `droid`, `antigravity`, `minimax`, `mistral`, `cerebras`, `groq`, `meta`, `muse_code` |
| App | The 24 apps Connected apps lists by default: `slack`, `github`, `gmail`, `googlecalendar`, `googlesheets`, `googledocs`, `googledrive`, `notion`, `linear`, `sentry`, `posthog`, `discord`, `twitter`, `reddit`, `zapier`, `hubspot`, `salesforce`, `jira`, `asana`, `trello`, `dropbox`, `airtable`, `figma`, `stripe`. Every other app is `other`. |
| Starting role | `assistant`, `inbox`, `research`, `coder`, `community`, `ops` |
| Cloud plan | `starter`, `personal`, `pro`, `max` |

An engine is named by the kind of engine it is, never by the account or endpoint it runs on: two Claude accounts both
report `claude`. A page that may not list the engines (a member's, a Cloud guest's or a paired device's) names the
engines the app ships with, and any engine account added later as `other`.

## The daily snapshot

`app_snapshot` is one count of what is set up, sent at most once a day. It answers questions such as how many people
use their own Boat key, and how many bots run on cloud computers, without sending what anything is called.

- Only the owner or an admin sends it. A member, a device paired without admin access and a Cloud guest never do.
- The app checks once it has loaded, then every hour, and sends at most once per UTC day for each app page.
- It counts what the app has already loaded. It also asks, once: this server for its signed-in devices (counted, never
  listed) and its connected-app inventory; on the desktop app, the app itself for the number of paired phones and the
  Cloud plan; and, when a Boat account is set, this server for the number of cloud computers. To answer that, the server
  lists the computers once at boat.dev with your Boat key, or at MausBot Cloud's relay for computers included with a
  plan. That listing only reads: it never changes a computer.
- When a source fails, its properties are left out and the rest is sent.

| Property | Type | Meaning |
| --- | --- | --- |
| `key_providers` | list of key providers | Providers with your own key saved: the model providers and an OpenAI-compatible key when set; `boat` for your own Boat key (not one included with a plan); `composio` for a self-hosted Composio project; `opencode_go`; `elevenlabs` or `fish_audio` for your own voice key; `jev` or `openrouter_decider` for your own decision-model key; `openai_image` or `custom_image` for your own avatar-image key (an xAI key counts once, as `xai`); `openai_live` for a separate Live call key |
| `key_count` | count | How many entries `key_providers` has |
| `has_boat_key` | true/false | Your own Boat key is saved |
| `cloud_computer_source` | `own_key`, `included`, `none` | Where cloud computers come from: your own Boat key (it wins when both exist), a Cloud plan, or nowhere |
| `cloud_computers` | count | Cloud computers this install manages for bots and team computers; `0` without a Boat account; left out while the Boat account is changing or when the provider could not be read |
| `team_computers` | count | Team computers |
| `bots` | count | Bots, not counting archived ones (no bot count below includes them) |
| `bots_cloud_boat`, `bots_cloud_vps` | count | Bots set to work on a cloud computer, on Boat or on your VPS |
| `bots_local_vm`, `bots_this_computer`, `bots_browser`, `bots_off`, `bots_auto` | count | Bots set to work on a Local VM, on this computer, in the browser only, nowhere, or left on Auto |
| `rooms` | count | Rooms |
| `bot_channels` | count | Channels bots opened with each other |
| `teams` | count | Teams |
| `routines`, `routines_enabled` | count | Routines, and how many are on; left out while routines are not loaded |
| `routines_cloud`, `routines_room_goal` | count | Routines that run on a cloud computer, and routines that pursue a room goal |
| `routines_once`, `routines_daily`, `routines_interval`, `routines_cron` | count | Routines by schedule type |
| `webhooks` | count | Webhook triggers; left out where webhooks are not loaded (the desktop app as a remote client) |
| `engines` | list of engines | Engines that are ready to use, each named once |
| `engine_count` | count | Ready engine accounts and endpoints |
| `custom_endpoints` | count | OpenAI-compatible servers you added |
| `trial_credit` | `active`, `used_up`, `ended`, `none` | The Cloud trial's Claude credit |
| `apps` | list of apps | Connected apps with a working account; left out when the inventory could not be read |
| `apps_connected` | count | Connected apps with a working account |
| `connectors_mode` | `managed`, `self_hosted`, `unavailable` | How connected apps are provided |
| `local_vm_mode` | `shared`, `per_bot`, `pool` | Local VM isolation |
| `vps_configured` | true/false | A VPS is set up |
| `voice` | `elevenlabs`, `fish`, `system`, `chatterbox`, `xai`, `none` | The voice provider in use |
| `voice_included` | true/false | The voice comes with a Cloud plan |
| `decider` | `jev`, `openrouter`, `off` | The decision model |
| `decider_included` | true/false | The decision model comes with a Cloud plan |
| `live_calls` | true/false | Live calls are set up |
| `phones_paired` | count | Phones paired with the desktop app (desktop app only) |
| `paired_devices` | count | Devices signed in to this server without an email, other than this one |
| `phone_paired` | true/false | Either count above is more than zero |
| `members` | count | People signed in to this server with an email, other than you |
| `cloud_home` | true/false | This server is a MausBot Cloud |
| `cloud_plan` | `starter`, `personal`, `pro`, `max`, `other`, `none`, `unknown` | The Cloud plan: `none` when free or signed out, `unknown` when the app cannot tell |
| `cloud_trial` | true/false | A Cloud trial is running |
| `edition` | `oss`, `enterprise` | The edition |
| `org_managed` | true/false | An organisation manages this desktop |
| `onboarded` | true/false | The first-run tour was finished |
| `first_turn` | true/false | A bot has answered at least once |
| `platform` | `desktop`, `browser` | The desktop app or a browser |
| `remote_client` | true/false | The desktop app is connected to another server |

## Events

| Event | When it is sent | Properties |
| --- | --- | --- |
| `app_first_open` | The first time this app page starts with analytics on | `platform`: `desktop`, `browser` |
| `app_opened` | Each time this app page starts with analytics on | `platform`: `desktop`, `browser` |
| `app_active` | Once a day you use the app: when this app page starts, comes into view or is focused, or when a check every ten minutes finds a new day while the page is in view and focused. At most once per day by your computer's date for each app page, and never while the page is hidden | `platform`: `desktop`, `browser` |
| `email_submitted` | You shared your email on the first-run screen; your events are tied to that email from then on | none |
| `$identify` | PostHog's own event, sent with `email_submitted`, and before a `cloud_pro_popup` `upgrade`, `manage` or `see_plans` counted on this computer's page for someone signed in to MausBot Cloud (not while the app has kept no analytics choice of its own and serves that page on a port other than its first), to tie your events to that email. When your events were already tied to an email, PostHog sends its `$set` event with the new one instead | `$set`: `email`, the email you shared or your Cloud account's email; `$anon_distinct_id`: the random id your events had before |
| `email_skipped` | You skipped the email on the first-run screen | none |
| `onboarding_step` | A first-run tour step is shown | `step`: `hello`, `reel`, `engines`, `import`, `permissions`, `phone`, `cloud`, `bot`; `replay`: true/false |
| `onboarding_completed` | The first-run tour ends | `reason`: `completed`, `skipped`; `at`: the step it ended on; `replay`: true/false |
| `setup_import_applied` | You bring in the skills and MCP servers the first-run tour found from other AI tools on this computer | `skills`, `tools`: how many were added. Never their names or where they came from |
| `setup_import_skipped` | You skip that step | `skills`, `tools`: how many it found |
| `onboarding_cloud` | You answer the first-run tour's MausBot Cloud step | `action`: `start_trial` (Start free trial, or See plans when the offer has no trial), `not_now`; `trial`: true/false, with `start_trial`: the offer has a free trial |
| `phone_setup_skipped`, `phone_setup_completed` | The phone step of the first-run tour was skipped or finished | none |
| `message_sent` | You send a message | To a bot: `driver`: engine; `queued`: true/false. To a room: `room`: true; `mode`: `chat`, `goal`; `queued`: true/false |
| `call_started` | You start a call with a bot | `driver`: engine; `mode`: `turns`, `live` |
| `group_call_started` | You start a call with a room | `memberCount`: count |
| `room_created` | You create a room | `members`: count; `context`: true/false (it was put in a team) |
| `room_members_changed` | You change who is in a room | `members`, `added`, `removed`: counts |
| `team_imported` | You import a team | `members`: count; `source`: `library`, `file`, `github`, `organization`, `scout`; `mode`: `add`, `project`; `format`: `team`, `package`, `backup` |
| `team_scouted` | The app suggests a team for a project folder | `signals`: count |
| `bot_created` | You create a bot in the New bot dialog | `source`: `blank`, `template` (a starting role), `preset`; `template`: starting role, only when `source` is `template` |
| `api_key_saved` | You save a key in Settings → API keys, in the Screen panel, on the X card in Apps, from a bot's request in a chat, or by adding an OpenAI-compatible server | `provider`: key provider; `via`: `settings`, `computer_panel`, `apps`, `chat_request`; `result`: `ok` (the provider accepted it), `rejected` (the provider refused it), `unverified` (saved, not checked), `error` (not saved) |
| `api_key_removed` | You clear a key of your own in Settings → API keys, the Screen panel or the X card in Apps | `provider`: key provider; `via`: `settings`, `computer_panel`, `apps` |
| `engine_signed_in` | You finish signing in to an engine inside the app | `engine`: `claude`, `codex`, `grok`; `method`: `code`, `device_code`, `browser` |
| `connector_connect` | A Connect you started in Connected apps ends | `app`: app; `result`: `connected` (the account it added works), `failed` or `expired` (that account failed or expired), `timed_out` (neither within two minutes) |
| `app_snapshot` | Once a day, as described above | The properties in the snapshot table |
| `cloud_card_shown` | The MausBot Cloud card is shown | `variant`: `signed_out`, `free` |
| `cloud_card_action` | You act on the MausBot Cloud card | `action`: `start`, `howto`, `signin`, `not_now`, `close` |
| `cloud_pro_popup` | The Cloud Pro popup (once on each desktop after an update, on whichever page its window shows) is shown, counted at most once a day on that desktop until it is closed, or you choose one of its buttons. On this computer's page, signed in to MausBot Cloud, `upgrade`, `manage` or `see_plans` first ties your events to your Cloud account's email (`$identify`); `shown`, `continue`, `not_now`, `close` and anything counted on a server's page never do. A server's page counts its main button there as `continue`: Manage plan on My Cloud's page, or Continue on this computer on a page that is not told your plan (a saved server's other than My Cloud's, or My Cloud's while it reads no plan). It switches the window to this computer, whose page counts what it opens there, with `via` naming the page clicked: `manage` for Manage plan; for Continue on this computer, from the plan this computer knows, `upgrade` with no plan, and `manage` with one or when its sign-in or plan is not known in time | `action`: `shown`, `upgrade` (Start free trial, Upgrade to Cloud Pro, or Continue on this computer with no plan), `manage` (Manage plan, or Continue on this computer with a plan), `see_plans` (Compare plans), `continue` (the main button on a server's page), `not_now`, `close` (the X, Escape or a click outside); `plan`: `none`, `trial`, `starter`, `personal`, `pro`, `max`, `other` (a plan newer than the app), `unknown` (the sign-in ended or is not known yet, or a page that is not told the plan); `signed_in`: true/false, signed in to MausBot Cloud in the app (false on a page that is not told); `page`: where it was counted: `local` (this computer's page), `my_cloud`, `server` (another saved server's); `via`: on this computer's page, the page whose click it finishes: `my_cloud`, `server` |
| `cloud_howto` | The "Show me how" tip ends | `result`: `no_button`, `skipped`, `closed` |
| `cloud_dialog_shown` | The Add a Cloud dialog opens | `source`: `app_card`, `app_howto`, `app_menu`, `app_settings`, `app_routines`, `update_popup` (the Cloud Pro popup), `app_onboarding` (the first-run tour's MausBot Cloud step); `view`: the dialog's first screen |
| `cloud_dialog_view` | The Add a Cloud dialog reaches a step | `view`: `received`, `starting`, `ready` |
| `cloud_signin` | Signing in to MausBot Cloud inside the Add a Cloud dialog takes a step | `step`: `code_sent` (a sign-in code was emailed), `signed_in`, `browser` (Continue in browser); `source`: as for `cloud_dialog_shown` |
| `cloud_checkout_opened` | A Cloud checkout opens in the browser | `plan`: Cloud plan; `trial`: true/false; `source`: as for `cloud_dialog_shown` |
| `cloud_setup_started` | A new Cloud starts its first job | none |
| `cloud_intent_submitted` | You tell a new Cloud what to do first | `idea`: `digest`, `watch`, `research`, `plan`, or none for your own words; `edited`: true/false |
| `cloud_intent_skipped` | You skip that question | none |
| `cloud_welcome_step` | A step of a new Cloud's welcome is shown | `step`: `bring`, `engine`, `files`, `done` |
| `cloud_welcome_ended` | A new Cloud's welcome ends | `reason`: `done`, `skipped`; `at`: the step it ended on |
| `product_hunt_card` | You act on the Product Hunt card | `action`: `upvote`, `not_now`, `close` |

`api_key_saved` reports `ok` for a key the server checks with its provider before saving it (Boat, Composio,
ElevenLabs, Fish Audio), and for a model provider key whose test passed right after saving. A key nothing checks before
it is used (OpenCode, OpenAI images, an added OpenAI-compatible server, an xAI key from a chat request) reports
`unverified`.
