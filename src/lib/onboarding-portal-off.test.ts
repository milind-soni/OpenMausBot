import { expect, it } from "vitest";

import { DEFAULT_ADMIN_ORIGIN, organisationSignIn } from "./onboarding";

it("offers no organization sign-in when the build names no portal", () => {
  expect(DEFAULT_ADMIN_ORIGIN).toBeNull();
  expect(organisationSignIn({ organization: { begin: () => {} } }, { hosted: false })).toBeUndefined();
});
