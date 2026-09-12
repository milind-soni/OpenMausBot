# Adding people to a hosted workspace

## Sub-features

- Settings → People: who may sign in with an emailed code, their role, when
  each person was last seen, what they spent this month, and an invite link
  per person that opens the sign-in page with the address filled in.
- The owner (or a bootstrap script on the box) names the first admin; from
  then on any admin invites, promotes, demotes and removes people from the
  card, and every change applies to the next sign-in at once.
- A removed person's existing devices stay until an admin revokes them under
  Remote access, as the card's note says.

## Driving it

```sh
pnpm exec vitest run server/people-invite.test.ts server/email-signin.test.ts src/components/PeopleSection.test.ts src/lib/session.test.ts
```

`server/people-invite.test.ts` boots the real server with no sign-in list and a
stubbed control plane, then walks the card's own requests: the owner adds the
first admin, the admin signs in with the emailed code and invites a member,
the member's link serves the sign-in page, the member gets a chat-only cookie
session and cannot change the list, a promotion applies to the next sign-in
while the device already issued keeps its scopes, a removal refuses new
sign-ins while the old devices stay until revoked, and a `@domain` entry
welcomes everyone there and nobody at a look-alike domain.

In the served UI, on a server with a public address: open Settings → People
(the profile menu at the bottom of the sidebar, then Settings), type an
address, pick a role, press Invite. The address appears in the table and the
invite link shows above it. Open that link in another browser: the sign-in
page has the address filled in and the address is gone from the address bar;
the code arrives by email; after it, the app opens as that person and the
People card (Refresh) shows their device and "Today". Remove them: they drop
from the table at once, a new sign-in for them is refused, and their open
device keeps working until it is revoked under Remote access.

## Not proven here

The real emailed code comes from the control plane, so a live run needs an
address you can read. Removing the last admin is allowed and turns email
sign-in off until someone on the box, or a still-signed-in admin, adds an
entry again.
