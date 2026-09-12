export type InvitationResult = { email: string; sent: boolean; error?: string; invitationId?: string; uncertain?: boolean };

export function workspaceSlug(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 31).replace(/-+$/, "");
}

export function invitationEmails(input: string) {
  const emails = [...new Set(input.split(/[\s,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new Error("Enter at least one email address.");
  if (emails.length > 20) throw new Error("Invite up to 20 people at a time.");
  const invalid = emails.find(email => email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid) throw new Error(`Check this email address: ${invalid}`);
  return emails;
}

// Invitations deliberately use the existing individual endpoint: a partial
// delivery must never make the UI retry invitations that already succeeded.
export async function sendInvitations(emails: string[], send: (email: string) => Promise<void>): Promise<InvitationResult[]> {
  const results: InvitationResult[] = [];
  for (const email of emails) {
    try { await send(email); results.push({ email, sent: true }); }
    catch (error) {
      const failure = error && typeof error === "object" ? error as { message?: string; invitationId?: string; status?: number } : {};
      results.push({ email, sent: false, error: failure.message ?? "Delivery could not be confirmed.", ...(failure.invitationId ? { invitationId: failure.invitationId } : {}), uncertain: !failure.status });
    }
  }
  return results;
}
