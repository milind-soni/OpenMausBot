# Science catalog

Checks the Science filter in the Apps dialog against a stand-in for the
MausBot Cloud science relay (`server/testing/fake-science-relay.ts`), through
the real renderer in the isolated fixture of [Chat UI, driven headlessly](chat-ui.md).
Nothing here touches the installed app, `~/.openmausbot` or a real Cloud.

## Launch

Terminal 1, the relay (add `--locked` for a locked Cloud):

```sh
node --experimental-strip-types server/testing/fake-science-relay.ts
```

It prints one line, `OMB_CLOUD_SCIENCE_URL=… OMB_CLOUD_SCIENCE_TOKEN=…`.
Terminal 2, export those two variables and start the fixture:

```sh
export OMB_CLOUD_SCIENCE_URL=… OMB_CLOUD_SCIENCE_TOKEN=…
pnpm control:omb ui launch
```

The launcher passes the pair to the server only for a loopback `http://127.0.0.1`
relay. The server then holds a Cloud home's science credential, fetches
`GET /api/connector-catalog` through it, and shows what the relay serves.

The launch prints a handle (see [Chat UI](chat-ui.md#launch)). In a third
terminal, with the same two variables exported, set these from it:

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json   # "ui"
URL=http://127.0.0.1:PORT                       # "url"
DATA=/tmp/openmausbot-verify-data-XXXXXX        # "dataDir"
LOG=…                                           # "logPath"
```

## Drive

Take `--ref` from a fresh `snapshot` whenever a name is ambiguous (with the
Science section on All, "Science" names a pill, a region and a heading):

```sh
pnpm control:omb ui click --ui $H --name "Apps"
pnpm control:omb ui snapshot --ui $H --interactive
pnpm control:omb ui click --ui $H --ref @eN        # the "Science" pill
pnpm control:omb ui screenshot --ui $H --out .omb-scratch/verify-evidence/science.png
pnpm control:omb ui click --ui $H --name "All"
pnpm control:omb ui screenshot --ui $H --out .omb-scratch/verify-evidence/science-all.png
```

The headless window is 1280 by 577, which cuts the dialog short and shows its
tiles in one column. `agent-browser set viewport 1440 900` run with the
session's own environment (`sessionEnv` in `scripts/testing/control-omb-ui.ts`)
followed by `agent-browser open` of the printed preview URL gives the 1440 by
900 frames in [science-catalog/](science-catalog/). Any other environment makes
agent-browser relaunch the browser and lose the page.

To connect public databases the way the dialog does, the relay must serve
`https` addresses, which a loopback stand-in cannot. Store the entries as the
dialog would and enable them (the same calls as the end-to-end test in
`server/science-catalog.e2e.test.ts`):

```sh
for db in pubmed biorxiv chembl opentargets clinicaltrials; do
  curl -s -X POST "$URL/api/mcp/servers" -H 'content-type: application/json' \
    -d '{"name":"'$db'","type":"http","url":"'$OMB_CLOUD_SCIENCE_URL'/'$db'/mcp","enabled":false,"catalog":{"id":"'$db'","auth":"cloud"}}'
  curl -s -X POST "$URL/api/mcp/servers/$db/test"
  curl -s -X PATCH "$URL/api/mcp/servers/$db" -H 'content-type: application/json' -d '{"enabled":true}'
done
```

Reopen Apps: the five tiles read connected with a Bot access disclosure, and
the header counts them.

## Redaction

```sh
rg -F -c "$OMB_CLOUD_SCIENCE_TOKEN" "$DATA/config.json" "$LOG"
```

must find nothing (exit 1), for the unlocked and the `--locked` run.

## Evidence

[science-catalog/](science-catalog/) holds the frames of the last run:

- `01-science-relay-unlocked.png`: Science with an unlocked relay, the five public tiles not yet connected (no addresses, so disabled).
- `02-all-relay-unlocked.png`, `03-all-science-connected.png`: All with the Science section first.
- `04-science-connected-top.png`, `05-science-connected-bottom.png`, `06-science-bot-access-disclosure.png`: five public databases connected, one disclosure open.
- `07-mcp-servers-cloud-entries-connected.png`: the stored entries as Signed in.
- `08-all-more-menu-files.png`: Files under More.
- `09-all-locked.png`, `10-science-locked-teaser.png`: a locked relay, the teaser with every Connect disabled and the header reading Connected.
- `asshipped-*.png`: the same relay before the envelope fix, which shows the teaser.

## What this proves

- The catalog transport on the environment path: the server fetches the relay's catalog with its bearer token and the renderer lists it.
- Locked and unlocked views, the All view's Science section first and Files inside More.
- Cloud entries stored under the relay base connect through the relay with the injected token, and the token never reaches `config.json`, the log or a response.

## What this does not prove

- Get Max: it needs `window.ogb.cloudAccount`, which only the Electron preload provides, so the headless page has no button in the locked view.
- A cloud entry flipping from Needs Max to connected when relay access arrives: the fixture has no parent port and holds a credential from its environment, so the entry never reports Needs Max. The revision refetch is covered by `src/components/ScienceCatalog.test.ts`.
- The Electron sync, checkout and upgrade: unit-tested; live acceptance needs the Admin and Cloud half on staging and an OMB2 build with `OMB_CLOUD_STAGING=1`, through the test-locally skill.
- Every vendor's real sign-in: done per vendor before it is served, under the spec's inclusion rule.
