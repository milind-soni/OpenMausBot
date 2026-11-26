# Bot contact cards

The AgentMail, AgentPhone, Vapi and Telnyx cards in Apps give bots their own
email, numbers and calls on the person's own accounts. AgentMail and AgentPhone
sign in with the browser like Whop. Vapi and Telnyx take a pasted key.

## Isolated browser verification

Use an installed Playwright module and Chromium, as for [Whop](whop.md):

```sh
node --experimental-strip-types scripts/verify-bot-contact-cards.ts
```

It launches a disposable fake-engine workspace and drives the real Apps modal,
with a loopback MCP server that accepts one key standing in for Vapi. Only the
fixture's middleware maps Vapi's official address to that fake. It checks:

- All four cards show; AgentMail has no key field and Vapi's Connect stays off
  until a key is typed.
- A refused key leaves the server off with the key in its `Authorization`
  header, never in its address, and the card says the key was refused.
- A good key replaces the refused one on the same server, switches it on and
  counts it in **Connected**; no listing ever returns the key.
- **Disconnect** deletes the server and its key.

Screenshots go to `OMB_UI_EVIDENCE_DIR` (default
`/tmp/omb-contact-cards-evidence`). No real Vapi, Telnyx, AgentMail or
AgentPhone account is used.
