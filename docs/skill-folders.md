# Skill folders and runtimes

A per-bot GitHub skill import keeps the admitted folder, including nested
references, scripts and binary assets. It starts disabled and its recorded files
are checked before use. Links, unsafe paths, generated content and files over
the import limits are reported as omitted. Importing a single text template or
using the library's text import supplies only the text provided. On Windows,
new bot-owned, library and organization imports record reviewed executable
intent in protected state because the filesystem mode cannot preserve it.
This metadata does not execute files or grant new permissions. Existing Windows
copies without trusted mode metadata cannot be exported with companions; an
organization copy needs manual recovery before update or removal. A welcome
import records modes when its source can report them, and keeps those modes
when an updated source moves the import to Windows. A welcome scan on Windows
cannot determine POSIX executable intent; those companions cannot be exported
until brought in again from a trusted source that supplies it.

When an imported skill with companions moves to My Cloud, both sides need a
version that carries executable intent. An older sender cannot establish that
its flags were observed on a filesystem with POSIX modes, and an older receiver
cannot represent unknown modes; the move is refused rather than guessing. A
skill whose source mode is unknown cannot be moved with companions until it is
brought in from a source with known modes. A text-only imported skill can
still move between versions.

There is no automatic in-place recovery for an older Windows organization
skill whose executable intent is unknown. Switch it off and keep a private
backup of both `<data>/workspaces/<bot-id>/skills/` and
`<data>/skill-state/<bot-id>/` before trying to recover it. To continue using
the skill, import a fresh copy into another bot from a trusted GitHub source
that records file modes, review it, and enable it there. Compare the backup for
local edits when preparing a reviewed source; editing an installed folder does
not make those edits reviewed. This workaround preserves the old entry and does
not remove it from the original bot. Do not invent mode metadata or edit its
protected state to force removal.

The bot's own `skill_manage` authoring flow has a narrower reviewed format:
`SKILL.md` and up to eight `references/<topic>.md` files. Sharing a learned
skill into the library currently refuses supporting files. These restrictions
are separate from the package format.

Engines that support workspace files receive an index pointing to `SKILL.md`;
the rest of the admitted folder is beside it and enabled skills are linked into
native task skill directories. An engine still needs its own file and command
tools and follows its normal approval policy to use those files. Importing or
sharing a script does not run it. API-only drivers excluded by
`supportsWorkspaceFiles` do not receive this filesystem skill index. A Local VM
has a separate filesystem and does not automatically mount the host skill folder.

Portable team, preset and organization packages have their own bounded folder
format and review. See [team sharing](team-sharing.md) for limits, exclusions,
binary opt-in, redaction and reader compatibility.
