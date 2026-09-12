# Onboard a hosted client

This checklist describes the implemented Admin portal. Offline tests are not
production qualification: complete the [disposable Linux deployment checks](README.md#fresh-linux-deployment)
before onboarding a real client. Actual hosting, TLS, SMTP delivery, OAuth
callbacks and paid provider calls still need that qualification.

Use a separate workspace for every separate client. People invited into the
same workspace join its shared bots, conversations and workspace data; an
invitation does not create a private copy. Member/admin roles control actions,
not private conversation partitions. The current fleet uses separate Unix
users and data directories on one kernel, not a VM/container per client.

## One-time operator preparation

- Follow the [deployment instructions](README.md#fresh-linux-deployment): a
  matching built core/portal release, Node 24.15.0+, the required engine CLI,
  dedicated unprivileged portal service, private fleet/Caddy sockets, and
  fenced tenant services. Do not run the portal inside your desktop or chat
  workspace, or give tenants management-socket access.
- Set up the portal HTTPS address and client subdomains, for example
  `admin.example.com` and `acme.example.com`. Prepare SMTP with TLS and a
  working sender; set the platform-owner email list and unique portal secret.
  Keep secrets out of customer configuration and source control.
- Configure the licensed `admin` entitlement. The repository's
  [licensing policy](../../LICENSING.md) also requires a written partner
  agreement for third-party hosting/white-labelling; a working license key
  alone is not that agreement.
- Optionally configure Google/GitHub client IDs, secrets and the exact
  callbacks in the deployment guide. Email-code sign-in is available without
  OAuth. Social sign-in has not been qualified against live providers by the
  offline fixtures; do not advertise it as working until tested.
- Sign in as a configured platform owner. In **Providers**, enter the
  Anthropic and/or OpenRouter API key and exact allowed model IDs in its own
  card, then **Save provider**. Install OpenCode on the server for OpenRouter
  workspaces, and choose tool-capable chat models. Saving does not validate
  either key with its provider. Qualify a bounded paid
  request only with approval. Workspaces receive their own gateway credential,
  not this master key.
- Establish backups of portal state and its secret, fleet configuration and
  each tenant's data. Retain the portal secret securely with the recovery
  materials: replacing it can invalidate sessions and make saved keys unreadable.

## Repeat for each client

1. **Create a blank workspace.** In **Workspaces → New workspace**, enter
   the client's display name and a unique address slug. Slugs are 2–31
   lowercase letters, digits or dashes, starting with a letter; the UI cannot
   rename the address later. Select only this client's managed Anthropic/OpenRouter
   models and choose **Create workspace**. The display name suggests an editable
   address; confirm it before creating. The workspace opens on **People** so
   you can invite its team next. Check the refreshed runtime status. Existing fleet
   workspaces are not automatically imported; never copy your personal home,
   chats, credentials or connected accounts into the new workspace.
2. **Confirm model access.** Open the workspace's **Models** tab. In **Model access**,
   check the intended models and use **Save model access** if changes are
   needed. With none assigned, managed model requests cannot run. The global
   provider list and this workspace's assignment must both allow a model.
   OpenRouter models are configured in the workspace's OpenCode model picker.
   Refresh the engine catalog after assignment changes. Existing bots are not
   silently switched: choose a replacement if their selected model was removed.
3. **Invite the client's first administrator.** In the workspace's **People**
   tab, choose **Invite people**, enter the exact client email and select
   **Workspace admin**. The first invitation defaults to this role; review it
   before sending. Confirm it appears
   as **Pending**. Sending alone grants no workspace membership. If delivery
   fails, the invitation may still be saved: check the list and use **Resend**
   after repairing mail delivery. The bootstrap operator must join as Workspace
   admin unless another workspace administrator has already accepted.
4. **Have the client accept as the correct person.** They open the emailed
   invitation and sign in with that same email: **Email me a code**, then the
   six-digit code, or a qualified configured social provider. Codes expire
   after 10 minutes; invitations after 7 days. If the tab already shows your
   operator account or another email, use **Switch account**. Signing in
   alone does not accept the invitation or connect a mailbox to a bot.
5. **Enter the workspace.** The client reviews the workspace, email and role,
   chooses **Accept invitation**, then **Continue to workspace** on the
   workspace sign-in screen. Confirm the destination hostname is this
   client's and the workspace contains no operator/other-client chats. Later,
   use **Workspaces → Open** or **Open workspace**. Platform management alone
   gives you no chat access: if you need setup access, explicitly invite and
   accept your own account too.
6. **Set up the client's bots and skills inside that workspace.** Create
   the required bots, select assigned models, and configure their instructions,
   tools and approval settings. Review skills before enabling them; add only
   this client's approved data and integrations. The portal does not perform
   this configuration or copy a bot/skill template automatically. Keep
   customer-specific configuration/skills in the customer's own repository,
   not a fork of the application. Run a bounded acceptance task after agreeing
   on any paid calls or external actions.
7. **Invite the rest of this client's team.** From the workspace's **People** tab,
   paste up to 20 email addresses (one per line, or comma-separated). Use **Member**
   for ordinary workspace users and **Workspace admin** only for people who
   should manage its people/settings. Every recipient must accept. Do not
   invite another client into this workspace to save a provisioning step. Review
   each delivery result. Retry only failed deliveries; an uncertain network
   result requires refreshing the invitation list first so a successful invite
   is not silently replaced.

Record the client, workspace hostname, accepted administrator(s), assigned
models and acceptance-check outcome. A **Needs attention** or failed operation
requires checking refreshed state and operator logs; do not assume rollback,
delete a reservation, or reuse its slug to force another create.

## Change or end access

- **Sign out:** signing out of Admin invalidates workspace sign-ins made from
  that same Admin session, including unconsumed sign-in links. Other signed-in
  devices retain their independent sessions. Removing a member instead ends
  that person's access to this workspace across devices.
- **Unaccepted invitation:** in **People → Invitations**, choose **Revoke**.
  To remove someone who already accepted, use their entry under **Members**.
- **One person:** choose **Change role** or **Remove**, confirm, and refresh
  People. Removal/demotion invalidates old workspace grants; the person must
  sign in again for any remaining role. Existing event/browser streams are
  closed within the hosted revalidation bound of 15 seconds. Verify that the
  removed account can no longer open this workspace. Conversations are not
  deleted. Assign another workspace administrator before demoting/removing
  its last one. A synchronization error can occur after central removal has
  taken effect: inspect the fleet state instead of assuming access was restored.
- **Whole client, temporarily:** a platform administrator uses the workspace's
  **Hosting → Suspend** action and confirms **Suspend workspace**. Confirm **Suspended**
  and that member access is denied. Managed provider requests/streams are
  aborted, but already processed work or charges cannot be undone. **Resume**
  starts it again for its remaining members.
- **Copied workspace provider credentials:** member removal does not revoke a
  previously copied workspace-wide gateway key. Suspend that workspace or
  clear its **Model access** to block its managed use. Individual gateway-key
  rotation is not implemented.
- **Remove from service, retain data:** choose **Remove workspace**, type the
  exact slug, and confirm **Remove · keep data**. Confirm **Removed · data
  retained**; the operator must also verify the retained tenant home and backup
  using the deployment procedure. This is not erasure: the name, account,
  data and isolation reservations are retained. There is no automatic restore
  or permanent-delete UI; either needs a separately reviewed operator procedure.

## What this does not set up

- **Runtime status is not an end-to-end health check.** Refresh queries the
  service manager without scanning conversation or usage data. A running
  service is not proof that mail, models or the customer journey works. An
  unavailable manager is shown as unknown, never as successful provisioning.
- Agree and configure tenant resource limits (memory, CPU, process count and
  spend) before shared-host production use. The portal does not yet manage
  those limits; use a reviewed operator procedure and capacity-test the host.
- Managed access supports Anthropic API and OpenRouter chat models. It does not pool personal
  Claude/Codex CLI subscriptions, sign in those accounts for clients, or manage
  every provider. Email/OAuth here identifies a person; bot integrations are separate.
  OpenRouter automatic routers, presets and model fallbacks are not supported;
  choose exact model IDs. Live OpenCode/provider calls still need qualification.
- Branding remains manual configuration: a licensed workspace can use
  [`brand.json`](../README.md#white-label-whitelabel), and the portal name is
  configured with `OMB_ADMIN_NAME`. There is no branding editor in the portal.
  Fully rebranded desktop/mobile apps, installers and permission prompts
  require a separate packaging job; creating a workspace does not produce them.
- Availability of the portal is required for hosted sign-in/access checks and
  managed provider calls. Offline test results do not promise production
  availability, billing accuracy or isolation beyond the deployment checks.
