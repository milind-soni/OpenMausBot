// Local-only preview. This file is excluded from the production build.
// Every account, email, provider response and workspace is disposable.
import { launchFixture } from "./fixture.ts";

const fixture = await launchFixture();
const admin = fixture.client();
await admin.login("operator@example.test");
for (const [slug, name] of [["design-studio", "Design studio"], ["client-acme", "Acme team"]]) {
  const response = await admin.request("/api/workspaces", "POST", { slug, name });
  if (!response.ok) throw new Error("Fixture workspace setup failed.");
}
let deliveryFailedOnce = false;
fixture.behavior.onMail = (mail) => {
  // A named disposable recipient exercises saved-invitation / Resend UI without SMTP.
  if (mail.to === "retry@example.test" && mail.subject.startsWith("You're invited") && !deliveryFailedOnce) {
    deliveryFailedOnce = true;
    throw new Error("Disposable first-delivery failure");
  }
  const code = /code is (\d{6})/.exec(mail.text)?.[1];
  if (code) console.log(`Disposable sign-in code for ${mail.to}: ${code}`);
  const invitation = mail.text.match(/https?:\/\/\S+\/invite\/[^\s]+/)?.[0];
  if (invitation) console.log(`Disposable invitation for ${mail.to}: ${invitation}`);
};
await admin.request("/api/workspaces/design-studio/invitations", "POST", { email: "designer@example.test", role: "admin" });
console.log(`Disposable Admin preview: ${fixture.url}`);
console.log("Sign in as operator@example.test. The fixture prints the test-only email code here.");
console.log("No real mail, cloud resources, provider calls, or user app data are used.");
console.log("Invite retry@example.test to simulate one failed delivery; Resend succeeds.");
process.once("SIGINT", () => { void fixture.close().then(() => process.exit()); });
process.once("SIGTERM", () => { void fixture.close().then(() => process.exit()); });
