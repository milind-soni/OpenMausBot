"""Pinned, offline WhatsApp pairing repair for an unpublished Hermes stage.

Baileys production hunks are backported from the still-unmerged PR 2765 at
042fe1f3ddacf63ac2288837fbc8a395556bbb6e into the installed rc13 ESM output.
Only TypeScript erasure, .js import paths and explanatory comments differ.
The linked-devices URL format, normal QR deadlines and generic ACK routing
remain upstream behavior. Source maps are not runtime inputs and stay upstream.

Hermes overlays prefer the prepared installed bridge over a stale HOME mirror
and require an actual creds.me.id before treating the QR wizard as paired.
Partial unpaired credentials are preserved; sender policy is unchanged.

Input bytes were read from the immutable source under:
/opt/origin-hermes/releases/2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19-supervised-2/source
No patch download, process invocation, auth access or live mutation occurs here.
The caller MUST freeze and exclusively own the unpublished destination and its
ancestors before applying, and MUST NOT publish a stage unless a receipt returns.
All inputs, compatibility guards and outputs are checked before the first write.
Writes preserve the existing file modes/ownership and touch only the five listed files.
An I/O failure can leave a partial unpublished stage: discard it, never retry it
as an already-applied repair. Receipt validation is intentionally independent of
today's asset identity, so trusted historical receipts remain rollback-safe.
The caller authenticates/protects receipts and enforces ownership/layout trust.
"""

from __future__ import annotations

from contextlib import ExitStack
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat


PROVENANCE = {
    "url": "https://github.com/WhiskeySockets/Baileys/pull/2765",
    "commit": "042fe1f3ddacf63ac2288837fbc8a395556bbb6e",
}
# Capture the exact loaded asset, including the implementation and all guards.
_REPAIR_ID = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

# Untouched prerequisites: exact rc13 metadata, existing helper export and the
# optional-identity ACK builder used by the reviewed production hunks.
_GUARDS = {
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/package.json':
        'e913239bada07e391604e92ec2f51de8039ec9ff3bb75b3f26e77fa75dad8de7',
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/lib/Utils/index.js':
        '8b6987b137f7744051ef55907fb34a86e092544b3449e0121cf04f99ff9e0100',
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/lib/Utils/stanza-ack.js':
        '3157d58ebcf0e800232afd555d7bde2233b06eef3f530524fe8e154f221538b2',
}

# destination-relative path: (input SHA256, output SHA256, exact-once hunks).
_PATCHES = {
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/lib/Socket/socket.js': (
        'ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9',
        'a71af9130b9f5f05e4ee90bb904923abc3f04100c12eb770d87d3a5305c455f3',
        (
            (
                (
                    "import { QueryIds, ReachoutTimelockEnforcementType } from '../Types/index.js';\n"
                    "import { DisconnectReason, XWAPaths } from '../Types/index.js';\n"
                    "import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, buildPairingQRData, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getCompanionPlatformId, getErrorCodeFromStreamError, getNextPreKeysNode, makeEventBuffer, makeNoiseHandler, promiseTimeout, signedKeyPair, xmppSignedPreKey } from '../Utils/index.js';\n"
                    "import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidDecode, jidEncode, S_WHATSAPP_NET } from '../WABinary/index.js';\n"
                    "import { BinaryInfo } from '../WAM/BinaryInfo.js';\n"
                ),
                (
                    "import { QueryIds, ReachoutTimelockEnforcementType } from '../Types/index.js';\n"
                    "import { DisconnectReason, XWAPaths } from '../Types/index.js';\n"
                    "import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, buildPairingQRData, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getCompanionPlatformId, getErrorCodeFromStreamError, getNextPreKeysNode, handleCompanionRegRefresh, makeEventBuffer, makeNoiseHandler, makePairingQRRenderer, promiseTimeout, signedKeyPair, xmppSignedPreKey } from '../Utils/index.js';\n"
                    "import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidDecode, jidEncode, S_WHATSAPP_NET } from '../WABinary/index.js';\n"
                    "import { BinaryInfo } from '../WAM/BinaryInfo.js';\n"
                ),
            ),
            (
                (
                    '    // the server terminated the connection\n'
                    "    ws.on('CB:xmlstreamend', () => void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed })));\n"
                    '    // QR gen\n'
                    "    ws.on('CB:iq,type:set,pair-device', async (stanza) => {\n"
                ),
                (
                    '    // the server terminated the connection\n'
                    "    ws.on('CB:xmlstreamend', () => void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed })));\n"
                    '    // Re-render the QR currently on screen while a pairing flow is live.\n'
                    '    let refreshPairingQR;\n'
                    '    // QR gen\n'
                    "    ws.on('CB:iq,type:set,pair-device', async (stanza) => {\n"
                ),
            ),
            (
                (
                    "        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');\n"
                    "        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');\n"
                    '        const advB64 = creds.advSecretKey;\n'
                    '        let qrMs = qrTimeout || 60000; // time to let a QR live\n'
                    '        const genPairQR = () => {\n'
                ),
                (
                    "        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');\n"
                    "        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');\n"
                    "        const renderer = makePairingQRRenderer(refNodes.map(refNode => refNode.content.toString('utf-8')), ref => ev.emit('connection.update', {\n"
                    '            // Read the secret per render: companion_reg_refresh rotates it mid-flow.\n'
                    '            qr: buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser)\n'
                    '        }));\n'
                    '        refreshPairingQR = () => void renderer.refresh();\n'
                    '        let qrMs = qrTimeout || 60000; // time to let a QR live\n'
                    '        const genPairQR = () => {\n'
                ),
            ),
            (
                (
                    '                return;\n'
                    '            }\n'
                    '            const refNode = refNodes.shift();\n'
                    '            if (!refNode) {\n'
                    "                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));\n"
                    '                return;\n'
                    '            }\n'
                    "            const ref = refNode.content.toString('utf-8');\n"
                    '            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);\n'
                    "            ev.emit('connection.update', { qr });\n"
                    '            qrTimer = setTimeout(genPairQR, qrMs);\n'
                    '            qrMs = qrTimeout || 20000; // shorter subsequent qrs\n'
                    '        };\n'
                    '        genPairQR();\n'
                    '    });\n'
                    '    // device paired for the first time\n'
                ),
                (
                    '                return;\n'
                    '            }\n'
                    '            if (!renderer.next()) {\n'
                    "                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));\n"
                    '                return;\n'
                    '            }\n'
                    '            qrTimer = setTimeout(genPairQR, qrMs);\n'
                    '            qrMs = qrTimeout || 20000; // shorter subsequent qrs\n'
                    '        };\n'
                    '        genPairQR();\n'
                    '    });\n'
                    '    // Generic notification handling supplies the ACK; do not send a second one.\n'
                    "    ws.on('CB:notification,type:companion_reg_refresh', node => {\n"
                    '        handleCompanionRegRefresh(node, {\n'
                    '            creds,\n'
                    "            emitCredsUpdate: update => ev.emit('creds.update', update),\n"
                    '            // Keep the current ref and its original deadline.\n'
                    '            refreshQR: () => refreshPairingQR?.(),\n'
                    '            logger\n'
                    '        });\n'
                    '    });\n'
                    '    // device paired for the first time\n'
                ),
            ),
        ),
    ),
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/lib/Utils/companion-reg-client-utils.js': (
        'dee36dbf5c36a2b0f5adcd114ddcc45c4847e4e2eafc6dc4266e81a87f6ffb23',
        '7bcfb49c960b3dbafd261c40411ae8a0772b20f2ee0043c8b0a11cbb77ccc38a',
        (
            (
                (
                    'export var CompanionWebClientType;\n'
                    '(function (CompanionWebClientType) {\n'
                ),
                (
                    "import { randomBytes } from 'crypto';\n"
                    "import { getBinaryNodeChild } from '../WABinary/index.js';\n"
                    'export var CompanionWebClientType;\n'
                    '(function (CompanionWebClientType) {\n'
                ),
            ),
            (
                (
                    "        [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(','));\n"
                    '};\n'
                    '//# sourceMappingURL=companion-reg-client-utils.js.map'
                ),
                (
                    "        [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(','));\n"
                    '};\n'
                    '/**\n'
                    ' * Keep the current ref so a refresh neither spends a ref nor extends its timer.\n'
                    ' * The caller reads the current adv secret every time render is called.\n'
                    ' */\n'
                    'export const makePairingQRRenderer = (refs, render) => {\n'
                    '    let index = 0;\n'
                    '    let current;\n'
                    '    return {\n'
                    '        next() {\n'
                    '            const ref = refs[index];\n'
                    '            if (ref === undefined) {\n'
                    '                return false;\n'
                    '            }\n'
                    '            index += 1;\n'
                    '            current = ref;\n'
                    '            render(ref);\n'
                    '            return true;\n'
                    '        },\n'
                    '        refresh() {\n'
                    '            if (current === undefined) {\n'
                    '                return false;\n'
                    '            }\n'
                    '            render(current);\n'
                    '            return true;\n'
                    '        }\n'
                    '    };\n'
                    '};\n'
                    "const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];\n"
                    '/**\n'
                    " * Retire only an unpaired companion's ADV secret. The generic notification\n"
                    ' * handler already ACKs this stanza; this helper only rotates and re-renders.\n'
                    ' */\n'
                    'export const handleCompanionRegRefresh = (node, { creds, emitCredsUpdate, refreshQR, logger }) => {\n'
                    '    if (!COMPANION_REG_REFRESH_CHILDREN.some(tag => getBinaryNodeChild(node, tag))) {\n'
                    "        logger.warn({ node }, 'companion_reg_refresh carries neither expected child; ignoring');\n"
                    "        return 'ignored_malformed';\n"
                    '    }\n'
                    '    // Pair-success and pairing-code setup both set me; registered is not a\n'
                    '    // substitute for this guard and can still be false in protected sessions.\n'
                    '    if (creds.me) {\n'
                    "        logger.debug({ id: node.attrs.id }, 'companion_reg_refresh on a registered session; keeping the adv secret');\n"
                    "        return 'ignored_registered';\n"
                    '    }\n'
                    "    creds.advSecretKey = randomBytes(32).toString('base64');\n"
                    '    emitCredsUpdate({ advSecretKey: creds.advSecretKey });\n'
                    "    logger.info({ id: node.attrs.id }, 'rotated the adv secret the server asked to retire; re-rendering the pairing QR');\n"
                    '    refreshQR();\n'
                    "    return 'rotated';\n"
                    '};\n'
                    '//# sourceMappingURL=companion-reg-client-utils.js.map'
                ),
            ),
        ),
    ),
    'scripts/whatsapp-bridge/node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js': (
        '850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710',
        '5d6ffff97ba21953051ff35fc10eb6848d392ef7d64c616c8a1144a19cb391f8',
        (
            (
                (
                    '    };\n'
                    '    const sendMessageAck = async (node, errorCode) => {\n'
                    '        const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);\n'
                    "        logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');\n"
                    '        await sendNode(stanza);\n'
                ),
                (
                    '    };\n'
                    '    const sendMessageAck = async (node, errorCode) => {\n'
                    '        // Pre-login notifications need ACKs even though there is no identity yet.\n'
                    '        // Message-class ACKs require `from`, so those still need creds.me.\n'
                    '        const meId = authState.creds.me?.id;\n'
                    "        if (node.tag === 'message' && !meId) {\n"
                    "            throw new Boom('cannot ack a message before creds.me is set');\n"
                    '        }\n'
                    '        const stanza = buildAckStanza(node, errorCode, meId);\n'
                    "        logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');\n"
                    '        await sendNode(stanza);\n'
                ),
            ),
        ),
    ),
    'gateway/platforms/whatsapp_common.py': (
        '6f5f5d56ab7d115cd13b9b176dfa26e40d242a7fd5d19bf6c334ff47ba022711',
        'e36945184cacb34b06b5f68bb89a49f7de8f6b80f341c83c2668a221ef5453b5',
        (
            (
                (
                    '\n'
                    'def resolve_whatsapp_bridge_dir() -> Path:\n'
                    '    """Bridge directory for CLI and adapter. A read-only install tree (e.g. Docker\n'
                    '    /opt/hermes) is mirrored to HERMES_HOME so npm install works."""\n'
                    '    import shutil\n'
                    '    from hermes_constants import get_hermes_home\n'
                    '    install_bridge = Path(__file__).resolve().parents[2] / "scripts" / "whatsapp-bridge"\n'
                    '    hermes_home_bridge = get_hermes_home() / "scripts" / "whatsapp-bridge"\n'
                    '    try:\n'
                ),
                (
                    '\n'
                    'def resolve_whatsapp_bridge_dir() -> Path:\n'
                    '    """Prefer a prepared installed bridge; mirror unprepared read-only installs."""\n'
                    '    import hashlib\n'
                    '    import shutil\n'
                    '    from hermes_constants import get_hermes_home\n'
                    '    install_bridge = Path(__file__).resolve().parents[2] / "scripts" / "whatsapp-bridge"\n'
                    '    # Managed immutable releases already carry dependencies and the upstream\n'
                    '    # package stamp. Never replace that reviewed bridge with a stale HOME copy.\n'
                    '    try:\n'
                    '        package_hash = hashlib.sha256((install_bridge / "package.json").read_bytes()).hexdigest()[:16]\n'
                    '        stamp = install_bridge / "node_modules" / ".hermes-pkg-hash"\n'
                    '        if (stamp.read_text(encoding="ascii").strip() == package_hash\n'
                    '                and (install_bridge / "bridge.js").is_file()\n'
                    '                and (install_bridge / "node_modules" / "@whiskeysockets" / "baileys" / "lib" / "index.js").is_file()):\n'
                    '            return install_bridge\n'
                    '    except (OSError, UnicodeError):\n'
                    '        pass\n'
                    '    hermes_home_bridge = get_hermes_home() / "scripts" / "whatsapp-bridge"\n'
                    '    try:\n'
                ),
            ),
        ),
    ),
    'hermes_cli/main_platform_setup.py': (
        '6d02b0263e34f0938db9ffae5ca8649f84e5aab2a228346d939d84af51b3880e',
        '50386584b6fd3768824c1d4e5a320df7e8c85b41b77027dd11aec4333460503e',
        (
            (
                (
                    '\n'
                    'import contextlib\n'
                    'import shutil\n'
                    'import subprocess\n'
                ),
                (
                    '\n'
                    'import contextlib\n'
                    'import json\n'
                    'import shutil\n'
                    'import subprocess\n'
                ),
            ),
            (
                (
                    '\n'
                    '\n'
                    'def cmd_whatsapp(args):\n'
                    '    """Set up WhatsApp: choose mode, configure, install bridge, pair via QR."""\n'
                ),
                (
                    '\n'
                    '\n'
                    'def _whatsapp_has_identity(session_dir) -> bool:\n'
                    '    """Partial credentials persisted during QR refresh are not a paired session."""\n'
                    '    try:\n'
                    '        creds = json.loads((session_dir / "creds.json").read_text(encoding="utf-8"))\n'
                    '    except (OSError, ValueError):\n'
                    '        return False\n'
                    '    me = creds.get("me") if isinstance(creds, dict) else None\n'
                    '    identity = me.get("id") if isinstance(me, dict) else None\n'
                    '    return isinstance(identity, str) and bool(identity.strip())\n'
                    '\n'
                    '\n'
                    'def cmd_whatsapp(args):\n'
                    '    """Set up WhatsApp: choose mode, configure, install bridge, pair via QR."""\n'
                ),
            ),
            (
                (
                    '\n'
                    '    # WHATSAPP_ENABLED=true is deliberately NOT written here: an aborted wizard (Ctrl+C, failed npm\n'
                    '    # install, missed QR scan) would leave .env claiming WhatsApp is ready with no creds.json, and\n'
                    '    # every `hermes gateway` would pay a 30s bridge timeout + indefinite retries. Set only after\n'
                    '    # pairing succeeds; prior successful pairings stay enabled.\n'
                ),
                (
                    '\n'
                    '    # WHATSAPP_ENABLED=true is deliberately NOT written here: an aborted wizard (Ctrl+C, failed npm\n'
                    '    # install, missed QR scan) would leave .env claiming WhatsApp is ready without a paired identity, and\n'
                    '    # every `hermes gateway` would pay a 30s bridge timeout + indefinite retries. Set only after\n'
                    '    # pairing succeeds; prior successful pairings stay enabled.\n'
                ),
            ),
            (
                (
                    '        return\n'
                    '\n'
                    '    # Existing session: re-pair or keep.\n'
                    '    session_dir = get_hermes_home() / "whatsapp" / "session"\n'
                    '    session_dir.mkdir(parents=True, exist_ok=True)\n'
                    '    if (session_dir / "creds.json").exists():\n'
                    '        print("✓ Existing WhatsApp session found")\n'
                    '        if _yes_no("\\n  Re-pair? This will clear the existing session. [y/N] "):\n'
                ),
                (
                    '        return\n'
                    '\n'
                    '    # Existing paired session: re-pair or keep. Preserve partial unpaired state.\n'
                    '    session_dir = get_hermes_home() / "whatsapp" / "session"\n'
                    '    session_dir.mkdir(parents=True, exist_ok=True)\n'
                    '    if _whatsapp_has_identity(session_dir):\n'
                    '        print("✓ Existing WhatsApp session found")\n'
                    '        if _yes_no("\\n  Re-pair? This will clear the existing session. [y/N] "):\n'
                ),
            ),
            (
                (
                    '            _say("\\n✓ WhatsApp is configured and paired!", "  Start the gateway with: hermes gateway")\n'
                    '            return\n'
                    '\n'
                    '    # QR code pairing\n'
                ),
                (
                    '            _say("\\n✓ WhatsApp is configured and paired!", "  Start the gateway with: hermes gateway")\n'
                    '            return\n'
                    '    elif (session_dir / "creds.json").exists():\n'
                    '        print("  Resuming unpaired WhatsApp credentials; no paired identity is saved.")\n'
                    '\n'
                    '    # QR code pairing\n'
                ),
            ),
            (
                (
                    '\n'
                    '    print()\n'
                    '    if not (session_dir / "creds.json").exists():\n'
                    '        print("⚠ Pairing may not have completed. Run \'hermes whatsapp\' to try again.")\n'
                    '        return\n'
                ),
                (
                    '\n'
                    '    print()\n'
                    '    if not _whatsapp_has_identity(session_dir):\n'
                    '        print("⚠ Pairing may not have completed. Run \'hermes whatsapp\' to try again.")\n'
                    '        return\n'
                ),
            ),
        ),
    ),
}


def repair_id() -> str:
    """SHA256 of this exact loaded repair asset, not merely its patch manifest."""
    return _REPAIR_ID


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_digest(value, length: int = 64) -> bool:
    return type(value) is str and re.fullmatch(r"[0-9a-f]{%d}" % length, value) is not None


def _relative_parts(relative: str) -> tuple[str, ...]:
    if type(relative) is not str or not relative or "\x00" in relative or "\\" in relative:
        raise ValueError("Repair file path is not a safe relative path")
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts or str(path) != relative:
        raise ValueError("Repair file path is not canonical and root-relative")
    return path.parts


def _open_root(destination: Path) -> int:
    """Walk from / without ever following an intermediate or final symlink."""
    path = Path(destination)
    if ".." in path.parts:
        raise ValueError("Repair destination contains parent traversal")
    if not path.is_absolute():
        path = Path.cwd() / path
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _open_file(root_fd: int, relative: str, *, writable: bool = False) -> int:
    """Hold the actual regular inode; refuse links and potentially blocking nodes."""
    parts = _relative_parts(relative)
    directory = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        flags = (os.O_RDWR if writable else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK
        fd = os.open(parts[-1], flags, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError(f"Repair path is not an unlinked regular file: {relative}")
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(directory)


def _read_fd(fd: int) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(fd), "rb") as stream:
        return stream.read()


def _patched_bytes(relative: str, source: bytes, specification) -> bytes:
    input_hash, output_hash, hunks = specification
    if _sha256(source) != input_hash:
        raise ValueError(f"Unexpected repair input, drift or prior application: {relative}")
    result = source
    for before, after in hunks:
        old = before.encode("utf-8")
        if not old or result.count(old) != 1:
            raise ValueError(f"Repair hunk does not match exactly once: {relative}")
        result = result.replace(old, after.encode("utf-8"), 1)
    if _sha256(result) != output_hash:
        raise ValueError(f"Repair output does not match its pinned hash: {relative}")
    return result


def apply_repair(destination: Path) -> dict:
    """Apply only to a frozen, exclusively held, unpublished source directory.

    Validation errors cause no writes. An I/O failure during writes invalidates
    the entire unpublished stage; no receipt is returned and no live fallback
    or automatic partial-repair recovery is attempted.
    """
    mutation_started = False
    try:
        with ExitStack() as opened:
            root_fd = _open_root(destination)
            opened.callback(os.close, root_fd)
            for relative, expected in _GUARDS.items():
                fd = _open_file(root_fd, relative)
                opened.callback(os.close, fd)
                if _sha256(_read_fd(fd)) != expected:
                    raise ValueError(f"Unexpected repair prerequisite: {relative}")
            pending = []
            for relative, specification in _PATCHES.items():
                fd = _open_file(root_fd, relative, writable=True)
                opened.callback(os.close, fd)
                result = _patched_bytes(relative, _read_fd(fd), specification)
                pending.append((fd, result))
            # All paths, source hashes, exact hunks and output hashes passed.
            # The held descriptors preserve modes/ownership and cannot follow a
            # renamed symlink. Single-link inputs prevent writes outside stage.
            mutation_started = True
            for fd, result in pending:
                os.lseek(fd, 0, os.SEEK_SET)
                view = memoryview(result)
                offset = 0
                while offset < len(view):
                    written = os.write(fd, view[offset:])
                    if written <= 0:
                        raise OSError("Repair write made no progress")
                    offset += written
                os.ftruncate(fd, len(result))
                os.fsync(fd)
    except (OSError, TypeError) as exc:
        state = "; discard the partially written unpublished stage" if mutation_started else "; no repair writes performed"
        raise ValueError(f"Cannot apply runtime repair{state}: {exc}") from exc
    return {
        "schema": 1,
        "id": repair_id(),
        "provenance": dict(PROVENANCE),
        "files": {relative: specification[1] for relative, specification in _PATCHES.items()},
    }


def validate_repair(destination: Path, receipt: dict) -> None:
    """Validate trusted historical receipts without requiring the current asset.

    This is integrity validation, not receipt authentication. The supervisor
    supplies the protected receipt and checks its immutable stage ownership.
    Historical output digests and identities must not be compared to _PATCHES
    or repair_id(), because doing so would break rollback after asset updates.
    """
    if type(receipt) is not dict or set(receipt) != {"schema", "id", "provenance", "files"}:
        raise ValueError("Malformed runtime repair receipt")
    if type(receipt["schema"]) is not int or receipt["schema"] != 1 or not _is_digest(receipt["id"]):
        raise ValueError("Unsupported runtime repair receipt schema or identity")
    provenance = receipt["provenance"]
    if (type(provenance) is not dict or set(provenance) != {"url", "commit"}
            or type(provenance["url"]) is not str
            or re.fullmatch(r"https://github\.com/WhiskeySockets/Baileys/pull/[1-9][0-9]*", provenance["url"]) is None
            or not _is_digest(provenance["commit"], 40)):
        raise ValueError("Malformed pinned repair provenance")
    files = receipt["files"]
    if type(files) is not dict or not files:
        raise ValueError("Repair receipt has no file hashes")
    for relative, expected in files.items():
        _relative_parts(relative)
        if not _is_digest(expected):
            raise ValueError("Malformed repair output hash")
    try:
        with ExitStack() as opened:
            root_fd = _open_root(destination)
            opened.callback(os.close, root_fd)
            for relative, expected in files.items():
                fd = _open_file(root_fd, relative)
                opened.callback(os.close, fd)
                if _sha256(_read_fd(fd)) != expected:
                    raise ValueError(f"Runtime repair output drift: {relative}")
    except (OSError, TypeError) as exc:
        raise ValueError(f"Cannot validate runtime repair: {exc}") from exc
