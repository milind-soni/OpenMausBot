# The agents tool bridge on Google's native Antigravity CLI

## What it proves

A native Antigravity account keeps every agents tool callable: `coordinate_bots`
by its own name, the rest through `find_tool` and `use_tool`, while the CLI's
MCP budget would otherwise drop the largest. Approval of a bridged `use_tool`
is never wider than a direct call of the tool it names.

## Driving it

```sh
node --experimental-strip-types scripts/verify-antigravity-bridge.ts OUTPUT_DIR
```

It launches the isolated fixture with the repository's stand-in for the native
CLI (`server/testing/fake-antigravity-cli.ts`, installed as the app installs
Google's), which mounts the turn's MCP servers, drops the largest tools past the
budget measured on 1.5.16, and asks permission in 1.5.14's format. A prompt line
`fake-agy: call <server>/<tool> <JSON>` stands for the model's tool call. The
script exits non-zero on any failed check and writes `report.json`:

- with no switch the turn is bridged and nothing is dropped; with the switch
  off the CLI drops `coordinate_bots` and the model cannot call it; on and off
  again in the same conversation, each change starts a new process on the same
  session and every name stays `mcp_agents_<tool>`;
- a hand-off through `coordinate_bots` reaches the teammate;
- `list_threads` through `find_tool` and `use_tool` returns the conversation;
- at Ask, a `use_tool` card names the tool it runs and carries no "Allow for
  this session" and no saved-grant key, a saved grant for that tool does not
  answer it, an allow for the session on a direct call does not carry over,
  and `find_tool` runs with no card;
- with the safety floor on, a never-list command through `use_tool` at Full is
  denied and the agents server gets no call.

## Limits

macOS and Linux: the stand-in is installed as a POSIX shell script, as the
app's own tests install it.

The stand-in reproduces the measured behaviour, not Google's model. The real
CLI's behaviour behind it (budget, names, hooks, rules, resume) was measured on
1.5.16 with scripts kept out of the repository.
