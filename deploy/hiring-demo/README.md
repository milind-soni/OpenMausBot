# Hiring demo: an AI recruiting desk on OpenMausBot

A ready-to-host demo of OpenMausBot running a US IT staffing desk. A **Desk Manager** bot (the server's Chief of
Staff) hands a client requirement to **nine specialist bots in four teams**, and they pass the work along: sourcing,
vendor bench, matching, phone screening, paperwork, then client submissions that a person approves. Stages 6–7
(interviews, onboarding, timesheets) run the next morning.

The bots work in **Desk ATS**, a small fake staffing CRM that ships here with made-up candidates, vendors and
requirements. It stays private: people only ever use OpenMausBot.

```
                ┌──────────────────────── one network namespace ────────────────────────┐
 browser ──443──▶ caddy ──▶ omb (OpenMausBot :8799, webhooks :8800) ◀──MCP / webhook──▶ ats (:4100)
                └────────────────────────────────────────────────────────────────────────┘
```

| Service | What it is |
|---|---|
| `omb` | The published OpenMausBot server image plus Claude Code (`../local/Dockerfile`), with `OMB_OPEN_TEAMS=1` |
| `ats` | Desk ATS: the fake CRM, the `deskats` MCP server the bots call, the desk template, and `setup-desk.mjs` |
| `caddy` | Automatic HTTPS for `DOMAIN` (`../Caddyfile`): the web app plus `/hooks/*` |

## What's in the template

- `template/DESK-MANAGER-PROMPT.md`: every bot's instructions (souls), the Phone Screener's voice script, and the
  Desk Manager's event playbook (what to do when a requirement, a phone screen or the next morning arrives).
- `template/recruiting-desk/`: the bots' shared folder (playbook, scoring rubric, screening checklist, submission
  template, recruiter feedback).
- `template/setup-desk.mjs`: applies all of it to the server through its API. It's safe to re-run.

| Bot | Team | Model | Job |
|---|---|---|---|
| Desk Manager | (Chief of Staff) | strong | Takes in requirements, hands out every stage, reports time-to-submit |
| Job Board Sourcer | Sourcing | fast | Posts the JD, runs Boolean searches |
| Vendor Bench | Sourcing | fast | Mass-mails C2C vendors, imports their consultants |
| Matcher | Screening | strong | Scores every profile against the JD, shortlists 3 with reasons |
| Phone Screener | Screening | fast | Text screens, and a voice screen over a Live call |
| Paperwork | Screening | fast | RTR, rate confirmation, NDA, work-authorization documents |
| Submission Writer | Client Delivery | strong | Drafts client submissions and sends only after the recruiter approves |
| Interview Coordinator | Client Delivery | fast | Schedules rounds, logs client feedback |
| Onboarding | Onboarding & Billing | fast | W-2 offer letter or C2C MSA, background check, laptop, start date |
| Timesheets | Onboarding & Billing | fast | Month-end timesheets |

Every bot runs at Full access inside the container. The one human gate is the Submission Writer's approval question.

## Deploy

Needs an x86-64 (amd64) Linux server with Docker and Compose, a DNS name (for example `hiring.example.com`) pointing
at it, and ports 80 and 443 open. The published server image is amd64 only, so use an x86-64 server (on an Apple
Silicon laptop Docker runs it under emulation, which is fine for trying it out).

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy/hiring-demo
cp .env.example .env                                   # set DOMAIN (and the sign-in emails, below)
docker compose up -d --build                           # ~5 min the first time
docker compose exec omb claude                         # sign Claude Code in once (kept on the data volume)
docker compose exec ats node template/setup-desk.mjs   # builds the desk: 10 bots, Desk HQ, ATS connection, webhook
docker compose exec omb node dist-server/openmausbot.js pair   # a pairing link for your own browser
```

Open the pairing link, and the desk is in the sidebar: the Desk Manager, the **Desk HQ** room, and the four teams.

**Engine:** the bots run on the Claude account you sign in with `docker compose exec omb claude` (subscription or
Console). To use an API key instead, set it under Settings → API keys. Change the models with `DESK_STRONG_MODEL` /
`DESK_FAST_MODEL` in `.env` and re-run the setup.

**The voice phone screen (optional):** the Phone Screener can take a Live call in the browser. Live calls need an
OpenAI API key (Settings → API keys, or MausBot asks the first time someone presses Call). Without one, testers type
the candidate's answers into the Phone Screener's chat instead.

## Give a client access

Two ways, both built in:

- **Email sign-in as a member** (recommended for clients): add their address to `OMB_SIGNIN_MEMBER_EMAILS` in `.env`
  and run `docker compose up -d`. They open `https://<DOMAIN>/pair` and sign in with an emailed code. Members can chat
  and approve, but can't change bots or settings.
- **A pairing link:** `docker compose exec omb node dist-server/openmausbot.js pair --label "Client name"` prints a
  one-time link. That gives full access, so keep it for yourself and your team.

## Running the demo (what a tester does)

1. Open **Desk HQ** and say **"start the demo"**. A client requirement lands (Senior Java Developer, Contoso Health,
   Dallas hybrid, $68/hr C2C) and the Desk Manager starts.
2. Watch the room: the Desk Manager hands sourcing to two bots, then matching, then screening. Each specialist reports
   back with what it did and which tools it used. **Team map** (people icon at the bottom of the sidebar) shows the
   hand-offs live.
3. When the Desk Manager says it's **waiting on Kiran's callback**, play Kiran: open the **Phone Screener**, start a
   Live call, and answer as Kiran (the Desk HQ bulletin has his details). Or type his answers into that chat.
4. Paperwork runs, the Submission Writer drafts three submissions and asks **"Send these 3 submissions to Contoso
   Health?"** in Desk HQ. Tap **Approve all**. The Desk Manager reports the time-to-submit.
5. Say **"next morning"**: interview feedback, an accepted offer and month-end timesheets go to three bots at once.
6. Say **"reset the demo"** to put the CRM back to the start.

A full run to the phone screen takes about 3 minutes; the whole thing is 8–10 minutes.

## Between clients

```sh
docker compose exec ats node template/setup-desk.mjs --fresh-room
```

This keeps the last client's Desk HQ under a dated name, opens a clean Desk HQ, and resets the CRM. The bots' own
chats keep their history.

## Upgrade

```sh
git pull && docker compose pull caddy && docker compose up -d --build
docker compose exec ats node template/setup-desk.mjs
```

The data volume keeps chats, engine logins and paired sessions; `ats-state` keeps the CRM.

## Try it on a laptop

Set `DOMAIN=localhost`, `HTTP_PORT=8080` and `HTTPS_PORT=8443` in `.env`, then follow Deploy. Caddy serves
`https://localhost:8443` with a local certificate.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A bot says it has no deskats tools | Re-run `setup-desk.mjs` (it switches the server on and checks). Then `docker compose logs ats` |
| The Desk Manager says there's no Desk HQ room | `OMB_OPEN_TEAMS` must be `"1"` on `omb`; `docker compose up -d` after changing it |
| Nothing happens after "start the demo" | `docker compose logs ats`: the CRM should log "Woke the Desk Manager". Re-run the setup if it says "not configured" |
| Bots don't answer at all | Claude Code isn't signed in: `docker compose exec omb claude` |
| A bot sits silent for more than 90 s | Open its chat and say "continue REQ-1042" |

## Developing the ATS

```sh
cd ats && npm install && npm test          # Node 24; 89 tests
npm start                                  # http://localhost:4100 with its own Demo controls
node scripts/dry-run.ts                    # plays every bot over MCP, no OpenMausBot needed
```
