# Orgo cloud computers

Orgo is an optional alternative to Boat and a self-hosted VPS. OMB uses your
Orgo account for a Linux desktop while keeping the bot's selected model.
You need a model connection that supports computer tools; the provider picker
disables Orgo for unsupported engines.

1. Get an API key from your [Orgo dashboard](https://www.orgo.ai/dashboard).
2. In OMB, open **Settings → Connections**, save the Orgo key, and explicitly
   choose its workspace. Saving a key does not create a computer.
3. Open your bot's **Computer** panel, choose **Cloud**, then **Orgo**.
   Opening this explicitly selected Cloud panel or sending a Cloud task creates
   or starts the bot's computer. Orgo charges your account, not OMB.
4. Use the normal screen preview, **Take control**, **Sleep** and **Start**
   controls. Cloud routines use Orgo too, with the same selected model.

Each bot gets a separate managed computer. Files persist across stop/start,
but deleting the computer or its bot deletes that computer's files. Export any
files you need first. Computers are scoped to this OMB environment and the
selected Orgo workspace; importing a bot into another installation does not
take ownership of the original installation's computer.

**Auto** only reuses an existing ready Orgo computer. It does not create or
start one. Choose Cloud when a task must run on Orgo. Other tools supplied by
your model can still act on the OMB host; the computer tools target Orgo, not
the host filesystem. This is not a sandbox for the entire model process.

The account key is write-only in OMB's existing credential settings: packaged
desktop installations use the OS-backed store; self-hosted servers use their
private config or `ORGO_API_KEY`. It is not returned to the browser or added to
chat. The desktop viewer uses the existing app-origin noVNC proxy and a fresh,
per-computer VNC password, not the Orgo account key.

To change workspaces or disconnect, first delete the managed computers from
the selected workspace. A replacement key must still manage existing
computers. These checks avoid orphaning billable resources.

This integration uses Orgo's [computer API](https://docs.orgo.ai/api-reference/computers/create)
and [desktop transport](https://docs.orgo.ai/guides/embed-vms), not its hosted
model service. The local Orgo mark comes from [Orgo's official site](https://www.orgo.ai/).
Offline verification is documented in [verification/orgo.md](verification/orgo.md).
