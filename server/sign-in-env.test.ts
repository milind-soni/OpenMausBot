import { describe, expect, it } from "vitest";

import { signInEnvRefusal, signInFromEnv } from "./sign-in-env.ts";

describe("sign-in lists from the environment", () => {
  it("leaves Settings in charge of a list whose variable is absent, empty or blank, as a compose file's ${X:-} passes it", () => {
    for (const value of [undefined, "", "  ", " , "]) {
      expect(signInFromEnv({ OMB_SIGNIN_EMAILS: value, OMB_SIGNIN_MEMBER_EMAILS: value }), JSON.stringify(value)).toEqual({});
    }
  });

  it("takes a list the environment names, lower-cased, each variable on its own", () => {
    expect(signInFromEnv({ OMB_SIGNIN_EMAILS: "Boss@Example.test, @team.example.test", OMB_SIGNIN_MEMBER_EMAILS: "" }))
      .toEqual({ admins: ["boss@example.test", "@team.example.test"] });
    expect(signInFromEnv({ OMB_SIGNIN_MEMBER_EMAILS: "ada@example.test carol@example.test" }))
      .toEqual({ members: ["ada@example.test", "carol@example.test"] });
  });
});

describe("a Settings change the environment would overrule", () => {
  const env = { OMB_SIGNIN_EMAILS: "", OMB_SIGNIN_MEMBER_EMAILS: "ada@example.test" };

  it("is refused for the list the environment decides, naming the variable and where to change it", () => {
    const refusal = signInEnvRefusal({ admins: [], members: ["ada@example.test", "new@example.test"] }, env);
    expect(refusal).toContain("OMB_SIGNIN_MEMBER_EMAILS is set where this server starts (its .env)");
    expect(refusal).toContain("as a member");
    expect(signInEnvRefusal({ admins: ["x@example.test"] }, { OMB_SIGNIN_EMAILS: "boss@example.test" })).toContain("OMB_SIGNIN_EMAILS");
  });

  it("goes ahead for a list the environment leaves to Settings, and for the decided list sent back unchanged", () => {
    // Settings sends both lists whenever it changes one: the decided one comes back as the server showed it.
    expect(signInEnvRefusal({ admins: ["boss@example.test"], members: ["ADA@example.test"] }, env)).toBeNull();
    expect(signInEnvRefusal({ members: ["new@example.test"] }, { OMB_SIGNIN_EMAILS: "", OMB_SIGNIN_MEMBER_EMAILS: "" })).toBeNull();
    expect(signInEnvRefusal(undefined, env)).toBeNull();
  });
});
