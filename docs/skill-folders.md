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
organization copy needs manual recovery before update or removal. Welcome
imports from this computer cannot reliably infer executable intent and still
refuse a skill that declares executable files.

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
