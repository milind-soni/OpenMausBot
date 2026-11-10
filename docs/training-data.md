# Training data

Settings → General → **Training data** lets you help MausBot learn to run bots on your own computer. With it on,
your bots' conversations with chat models become examples that a small model running on a laptop can learn from.
It is off unless you turn it on, and it is never offered on a Team Cloud or a hosted workspace, where the
conversations are other people's.

| Setting | What happens |
|---|---|
| **Off** (the default) | Nothing is kept. |
| **Keep on this computer** | Each step a bot takes with a chat model is kept in `<data>/training/`, one file a day, for 30 days. Nothing leaves this computer. |
| **Also share** | The same, and turns that ended well go to the MausBot team once an hour. You confirm this once, after reading what goes and what never does. |

## What is kept

For every step a chat engine takes (OpenAI-compatible and local servers, Groq, Mistral, Cerebras and the other chat
engines; agent engines such as Claude and Codex are not recorded yet) one JSON line holds:

- the request the model saw: the system prompt, the tools' schemas, and the conversation so far, including tool calls and
  their results;
- what the model answered: its text and its tool calls;
- the model, the engine, whether it ran on this computer's network, and token usage.

After a turn's steps comes one line with how the turn ended (`ok`, and why it stopped).

Before a line is written, secrets are removed: the engine's key and the integrations' secrets, the secrets bots hold,
and anything shaped like a key or token. Images become `[image]`. A step larger than 4 MB is not kept, a day keeps at
most 50 MB, and the folder at most 500 MB (the oldest days go first).

**Export** saves everything kept as one `.jsonl` file. **Delete all** removes it from this computer.

## What is shared

Only with **Also share**, and only:

- turns that began after you turned sharing on (turning it off and on again starts afresh);
- turns that ended well;
- each as its whole conversation: the last step's request and the model's answer.

They go gzipped, at most 1 MB a request, to `https://cloud.openmausbot.com/api/training-data` (a MausBot Cloud sends to
its own Admin; `OMB_TRAINING_DATA_URL` overrides it for testing). Each request carries a random contributor id kept in
`<data>/training/upload.json`, so the team can delete what one install sent if you ask. Nothing from before sharing,
no images, no keys or logins, and nothing from a Team Cloud is ever sent. Turning sharing off stops it at once.

The endpoint answers `201 {accepted}`. On `429` or a server error it waits (`retryAfter`, else 30 minutes) and tries
again; a turn it refuses (`400`, `413`) is not sent again.

```
POST /api/training-data
Content-Encoding: gzip
{ "v": 1, "contributorId": "…", "consentVersion": 1,
  "turns": [{ "turnId", "model", "driverKind", "local", "tools", "messages", "steps", "endedAt" }] }
```

## Model performance

Settings → Usage → **Model performance** shows, for each model in the chosen period: turns, how many ended well, tool
calls that failed, how often it ran as the quick model and fell back to the bot's own model, typical and slow turn
times, tokens and cost. It is read from the usage ledger on this computer (`GET /api/usage/models?from=&to=`) and
works whether or not training data is on.
