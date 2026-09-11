/** Match provider error wording, not ordinary assistant discussions of safety. */
export function isProviderSafetyBlock(message: string): boolean {
  return /\bblocked by (?:our|the provider['’]s) safety systems\b|\bsafety monitoring\b.{0,100}\b(?:paused|ended|blocked)\b|\b(?:safety_check_failed|safety_policy_violation)\b/i.test(message);
}

export const PROVIDER_SAFETY_GUIDANCE = "The provider stopped this task. Full access controls tool approvals, not provider safety checks. Review the provider’s findings in Codex if available; OpenMausBot cannot override this block.";
export const PROVIDER_SAFETY_HELP_URL = "https://learn.chatgpt.com/docs/agent-approvals-security#safety-monitoring-and-paused-tasks";
