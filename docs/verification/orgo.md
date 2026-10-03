# Orgo cloud computer

Run the real-server fixture against an owned loopback provider:

```sh
pnpm exec vitest run server/orgo-routing.test.ts server/orgo.test.ts server/routes/desktop-viewer.test.ts src/components/DesktopViewer.test.ts
pnpm exec vitest run scripts/testing/verification-docs.test.ts
```

`server/orgo-routing.test.ts` launches the shared verification server in a
temporary home with the repository's fake Claude engine and a synthetic Orgo
workspace. It prints the fixture URL, temporary data directory and persistent
server log. The optional launcher parameter accepts only an explicit loopback
HTTP origin. `server/testing/orgo-hooks.mjs` redirects Orgo's fixed production
API URL inside that fixture process; production has no configurable API URL.
No paid computer, real API key or model provider is contacted.

The fixture checks selected-model routing for direct, group and scheduled conversations,
scoped Linux computer tools and control authorization, Auto's refusal to create
or wake a computer, explicit Cloud creation and wake, write-only account keys,
provider changes while resources exist, exact computer cleanup on bot deletion,
and screenshots and app-origin viewer links without account or VNC secrets.

The focused desktop-viewer tests additionally exercise the authenticated HTTPS
proxy with a synthetic loopback desktop, fresh passwords, malformed instance
refusal, session revocation and stripping browser credentials and query values.
The [existing viewer fixture](desktop-viewer.md) covers the built noVNC page and
its controls. These checks prove offline server routing and transport boundaries;
they do not prove real Orgo provisioning, browser pixels from Orgo, MCP package
downloads or native viewer acceptance.

Each test stops its own server and removes its temporary data directory. The
printed server log and sibling `.orgo.json` retain the exact control commands,
wait results, bounded transcripts and provider actions for evidence. Provider
Authorization headers are omitted.
