// A bot's browser has no passkey: the person's passkeys live on their own phone or computer. Real Chrome there would show
// its passkey sheet, the person would dismiss it, and the page would get NotAllowedError and offer other ways to sign in.
// A headless Chrome has nowhere to show that sheet, so the request never ended and the sheet held the tab's input
// (Chrome 155): "Try another way" did nothing, for the bot and for a person in the hand-over view.
//
// So each tab gets CDP's virtual WebAuthn environment with one built-in authenticator that holds no passkey and never
// verifies the user: every passkey or security-key request (sign-in, conditional, registration) ends in about 20 ms with
// NotAllowedError, as a dismissed sheet does, and no credential is ever created. Pages see what a desktop Chrome with a
// passkey provider reports: a user-verifying platform authenticator and conditional mediation (a security-key-only
// authenticator would report neither, and would leave a request for a platform authenticator waiting).

/** CDP WebAuthn.VirtualAuthenticatorOptions, measured on Chrome 155 on macOS and Linux. */
export const NO_PASSKEY_AUTHENTICATOR = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  // The user is never verified, so a registration fails as well: a site cannot leave a passkey behind in a browser
  // that forgets it.
  isUserVerified: false,
  // Answers at once instead of waiting for a touch that never comes.
  automaticPresenceSimulation: true,
} as const;

/** What a page's session is sent, in order, before the page runs. The environment lives as long as the session. */
export const NO_PASSKEY_COMMANDS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["WebAuthn.enable", { enableUI: false }],
  ["WebAuthn.addVirtualAuthenticator", { options: NO_PASSKEY_AUTHENTICATOR }],
];
