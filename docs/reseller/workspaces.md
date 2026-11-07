# Workspaces and web addresses

A reseller server runs one workspace per customer. Each workspace is its own
Unix user and `openmausbot@<name>` service, behind its own Caddy site.

## The default address

`openmausbot fleet create acme --admin owner@acme.test` serves the workspace at
`https://acme.<domain>`, where `<domain>` is the one given to `fleet init`. A
wildcard `*.<domain>` record at the server is all the DNS this needs.

## A customer's own address

```sh
openmausbot fleet create acme --admin owner@acme.test --host chat.acme-corp.com
```

The custom address replaces the default. It is the registry host, the Caddy
site and the workspace's `OMB_PUBLIC_URL`. The default `acme.<domain>` stays reserved and is never served.

Point the name at the server first: an A or AAAA record for
`chat.acme-corp.com`. The create plan prints a reminder. Caddy fetches the
certificate once the name resolves to this server, so a workspace created
before the record exists answers over HTTPS only after DNS catches up.

An address is accepted when it is:

- a plain domain name, lowercased (`Chat.Acme.COM` becomes `chat.acme.com`);
- not an IP address, `localhost`, a wildcard, or anything with a port, path,
  space, newline, brace or trailing dot;
- not the fleet's own domain;
- not held by any workspace in the registry, whatever its status: running,
  suspended, retained, provisioning or error;
- not under `.<domain>`, except the workspace's own `<name>.<domain>`.

A new workspace name is refused when its default address is already held by
another workspace's entry. A custom address is refused when a portal is
configured (`--portal-url`), because the portal serves its workspaces from
their own names. Every refusal is a plain message printed before any step runs.

## Changing an address

There is no rename. Delete the workspace and create it again with the new
`--host`. `fleet delete NAME --yes --keep-data` keeps the home, account and
address reserved; recover or remove the retained workspace before reusing the
address.

## Suspend, resume and delete

A suspended workspace answers `503` with "This workspace is suspended." on its
custom address. Resume restores the proxy. Delete removes the site file.

## The operator workspace

The fleet agent behind Settings -> Installations creates workspaces on their
default address only. A `host` in its request body is ignored: custom addresses
are a root CLI decision in version 1.
