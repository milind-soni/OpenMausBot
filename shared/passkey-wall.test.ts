import { describe, expect, it } from "vitest";
import { passkeyWallAt, passkeyWallIn } from "./passkey-wall.ts";

describe("Google's passkey step", () => {
  it("is known by its address, under every signin path Google uses", () => {
    for (const address of [
      "https://accounts.google.com/v3/signin/challenge/pk/presend?TL=abc&checkConnection=youtube%3A1&flowName=GlifWebSignIn",
      "https://accounts.google.com/v3/signin/challenge/pk?TL=abc",
      "https://accounts.google.com/signin/v2/challenge/pk/presend?flowName=GlifWebSignIn",
      "https://accounts.google.com/v3/signin/challenge/sk/webauthn?TL=abc",
    ]) expect(passkeyWallAt(address), address).toBe("google");
  });

  it("is not another sign-in step, another host or no address", () => {
    for (const address of [
      "https://accounts.google.com/v3/signin/challenge/pwd?TL=abc",
      "https://accounts.google.com/v3/signin/challenge/selection?TL=abc",
      "https://accounts.google.com/v3/signin/challenge/totp?TL=abc",
      "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn",
      "https://example.com/v3/signin/challenge/pk",
      "https://accounts.google.com.evil.test/v3/signin/challenge/pk",
      "",
      "not a url",
    ]) expect(passkeyWallAt(address), address).toBeNull();
  });

  it("is found in a page change or a snapshot, by address or by Google's own wording", () => {
    expect(passkeyWallIn("The page is now https://accounts.google.com/v3/signin/challenge/pk/presend?TL=… (\"Sign in - Google Accounts\").")).toBe("google");
    expect(passkeyWallIn('heading "Google"\nheading "Verifying it’s you"\ntext "Complete sign-in using your passkey"\nbutton "Try another way"')).toBe("google");
    expect(passkeyWallIn("Google\nUse your passkey to confirm it’s really you\nYour device will ask for your fingerprint, face, or screen lock")).toBe("google");
    expect(passkeyWallIn("Google\nUse sua chave de acesso para confirmar que é você\nTentar de outro jeito")).toBe("google");
    expect(passkeyWallIn("Google\nUsa tu llave de acceso para confirmar que eres tú\nProbar otra manera")).toBe("google");
  });

  it("is not a page that only offers a passkey, or the same words away from Google", () => {
    expect(passkeyWallIn("Google\nSign in\nEmail or phone\nSign in with a passkey\nNext")).toBeNull();
    expect(passkeyWallIn("Google\nWelcome\nEnter your password\nTry another way")).toBeNull();
    expect(passkeyWallIn("Acme blog: how to use your passkey on any site")).toBeNull();
    expect(passkeyWallIn("https://accounts.google.com/v3/signin/challenge/pwd?TL=abc")).toBeNull();
  });
});

describe("Microsoft's passkey step", () => {
  it("is found by its wording on a Microsoft sign-in page, not where a passkey is one option", () => {
    expect(passkeyWallIn("Microsoft\nSign in with your passkey\nOther ways to sign in")).toBe("microsoft");
    expect(passkeyWallIn("https://login.microsoftonline.com/common/login\nSign in with your face, fingerprint, PIN or security key")).toBe("microsoft");
    expect(passkeyWallIn("Microsoft\nSign in\nSign in with a passkey\nNext")).toBeNull();
  });
});
