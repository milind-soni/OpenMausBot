# OpenMausMobile privacy

OpenMausMobile is a companion for an OpenMausBot service chosen and operated by the user.

## Data handling

- The app stores the selected computer address in iOS preferences and its pairing token in the iOS Keychain.
- Messages, approvals, transcript searches, exports, and screen images travel directly between the phone and that computer.
- OpenMausBot stores transcripts on that computer. The app does not send the developer a cloud copy.
- The app contains no advertising, analytics, tracking, or third-party SDKs.
- The app does not sell personal information.

Local-network connections should only be used on a network the user trusts. For remote access, the project recommends Tailscale so traffic is protected by the user's tailnet. Tailscale is a separate service with its own privacy terms.

If optional hosted services are introduced later, this policy and the App Store privacy disclosure will be updated before those services ship.

## Control and deletion

Unpairing removes the connection and pairing token from the phone. Revoking the phone in OpenMausBot's Companion settings prevents that credential from reaching the computer. Transcript deletion is controlled by the OpenMausBot installation that stores it.

## Support

Questions or privacy requests can be opened at [OpenMausBot Support](https://github.com/milind-soni/OpenMausBot/issues).
