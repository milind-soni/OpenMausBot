# People and roles

A paired device is a *credential*. A user is a *person*. This page is about
giving a server run with `openmausbot serve` a list of people, so you can sign
one of them out without guessing which iPads were theirs.

The desktop app is single-user and unaffected by any of this.

## What a member can and cannot do

Read this before you create anyone.

| | admin | member |
|---|---|---|
| Chat with every bot, read every transcript | yes | **yes** |
| Change settings, engines, connectors | yes | no |
| Create people, pair devices, revoke sessions | yes | no |

**A member can still read everything.** The role limits what someone may
*change*, not what they may *see*. Per-bot visibility ("you may only see these
three bots") is a later step. If you need that today, run a second server.

## Start

There are no accounts until you make one, and a server without accounts
behaves exactly as it always has: pairing codes mint anonymous devices that
hold full access. Nothing changes on upgrade.

Create the first person on the machine itself (SSH, a console, or the desktop
app — anything on `127.0.0.1` is the owner and needs no account):

```sh
openmausbot users add --name "Ada Lovelace" --email ada@example.com --role admin
openmausbot pair --user ada@example.com --label "Ada's laptop"
```

The second command prints a code. Type it on the device, exactly as before.

From then on every new device names a person:

```sh
openmausbot users add --name "Bob"                    # a member, by default
openmausbot pair --user Bob --label "Kitchen iPad" --client
```

`--user` takes an id, an email, or an exact name. `--name` is the person;
`--label` is the device.

## Everyday commands

```sh
openmausbot users                    # who exists, their role, and how many devices each has
openmausbot users edit Bob --role admin
openmausbot users disable Bob        # reversible
openmausbot users enable Bob
openmausbot users remove Bob --yes   # permanent
openmausbot sessions                 # devices, and who each belongs to
```

## Disabling versus removing

**Disable** is a switch. Every request from their devices is refused and any
live screen goes blank immediately, but the devices themselves are kept — so
`enable` puts them straight back with no re-pairing. Use it for someone on
leave, or a laptop you think was lost.

**Remove** is permanent. Same teardown, then the person is gone.

Either way, a pairing code minted for them stops working at once.

## Two things you cannot do

Both return an error rather than letting you strand yourself:

- **Disable, demote or delete the last active admin.** Promote someone else
  first. This binds the machine's owner too — it is a fact about the file, not
  about who is asking.
- **Change your own role or status, or delete your own account.** Ask another
  admin. (Renaming yourself is fine.)

Whoever is at the machine always has full access over `127.0.0.1`, so no state
is unrecoverable.

## Changing someone's role

It takes effect on their next request. Nobody re-pairs anything.

One subtlety: a device paired with `--client` stays chat-only however senior
its owner becomes. The person and the device each get a veto, so a shared
kitchen iPad does not turn into an admin console because you promoted someone.
Pair a new device without `--client` if they need full access from it.

## Where this lives

`~/.openmausbot/users.json`, owner-readable only, beside `sessions.json`. It
never leaves the machine, and nothing here talks to any cloud service —
`openmausbot login` is a separate thing, for reserving a public address.

If that file is ever damaged, the server keeps running for the bots and for
whoever is at the machine, refuses every remote account, and **does not
overwrite it**. Fix or delete the file and restart.
