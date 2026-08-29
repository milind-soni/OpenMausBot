import type { AccountDirectory, LogicalIdentity } from "./account-directory.ts";
import { canonicalConnectorAction, type CanonicalConnectorOperation } from "./canonical-connector-action.ts";
import type { ActionPolicy, ActionProposal } from "./action-policy.ts";

/** The only provider-facing execution seam. Drivers never receive raw model
 * arguments; they receive this exact, policy-checked proposal. */
export interface ProviderActionCall {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly identity: LogicalIdentity;
  readonly provider: string;
  readonly ownerId: string;
  /** AccountDirectory is installation-scoped today while policy ownership is
   * bot-scoped. Keep the two scopes explicit instead of accidentally treating
   * a bot id as an account-directory owner. */
  readonly accountOwnerId: string;
  readonly authorizationId?: string;
}

export interface ProviderActionReceipt {
  readonly ok: boolean;
  readonly reference: string;
  readonly observedAt?: string;
}

export interface ProviderActionExecutor {
  execute(proposal: ActionProposal): Promise<ProviderActionReceipt>;
}

export interface PreparedProviderAction {
  readonly proposal: ActionProposal;
  readonly operation: CanonicalConnectorOperation;
  readonly accountId: string;
}

export type ProviderActionExecutionResult =
  | { readonly status: "executed"; readonly proposal: ActionProposal; readonly receipt: ProviderActionReceipt }
  | { readonly status: "denied"; readonly reason: string; readonly proposal?: ActionProposal };

export interface ProviderActionAdapter {
  prepare(call: ProviderActionCall): PreparedProviderAction | { readonly status: "denied"; readonly reason: string };
  execute(call: ProviderActionCall, executor: ProviderActionExecutor): Promise<ProviderActionExecutionResult>;
}

export class ProviderActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderActionError";
  }
}

/**
 * Deep adapter for all canonical connector mutations. It verifies account
 * identity before policy evaluation, consumes one-time approvals atomically
 * at the last safe seam, and never lets an unknown tool reach an executor.
 */
export function createProviderActionAdapter(options: {
  readonly policy: ActionPolicy;
  readonly accounts: AccountDirectory;
}): ProviderActionAdapter {
  const prepare = (call: ProviderActionCall): PreparedProviderAction | { readonly status: "denied"; readonly reason: string } => {
      const canonical = canonicalConnectorAction(call.toolName, call.arguments);
      if (canonical.fidelity !== "canonical") {
        return { status: "denied", reason: canonical.fidelity === "unsupported" ? "This provider write has no canonical adapter" : canonical.reason };
      }
      if (operationProvider(canonical.action.operation) !== call.provider.trim().toLowerCase()) {
        return { status: "denied", reason: "The provider does not match the canonical operation" };
      }
      const accountResolution = accountResolutionForIdentity(options.accounts, call, canonical.action.accountId);
      if (accountResolution.status !== "resolved") {
        const reason = accountResolution.status === "ambiguous"
          ? "The selected identity has multiple provider accounts; choose one exact account"
          : accountResolution.status === "not_found"
            ? "The provider account is not bound to the selected identity"
            : accountResolution.status === "forbidden"
              ? "The account binding owner is not authorized"
              : "The account binding is invalid";
        return { status: "denied", reason };
      }
      const proposal = options.policy.prepareProposal({ ...canonical.action, ownerId: call.ownerId });
      return { proposal, operation: canonical.action.operation, accountId: canonical.action.accountId };
  };

  return {
    prepare,

    async execute(call, executor) {
      const prepared = prepare(call);
      if ("status" in prepared) return prepared;
      const authorizationId = call.authorizationId;
      if (authorizationId) {
        const authorization = options.policy.getAuthorization(authorizationId);
        if (!authorization) return { status: "denied", reason: "One-time authorization was not found", proposal: prepared.proposal };
        const decision = options.policy.consumeAuthorization(authorizationId, {
          operation: prepared.proposal.operation,
          accountId: prepared.proposal.accountId,
          payload: prepared.proposal.payload,
          ownerId: prepared.proposal.ownerId,
        });
        if (!decision.allowed) return { status: "denied", reason: decision.reason, proposal: prepared.proposal };
        const authorizedProposal = options.policy.getProposal(authorization.proposalId);
        if (!authorizedProposal) return { status: "denied", reason: "The authorized proposal no longer exists", proposal: prepared.proposal };
        const receipt = await executor.execute(authorizedProposal);
        return { status: "executed", proposal: authorizedProposal, receipt };
      } else {
        const decision = options.policy.evaluate(prepared.proposal);
        if (decision.effect !== "allow") return { status: "denied", reason: decision.reason, proposal: prepared.proposal };
      }
      const receipt = await executor.execute(prepared.proposal);
      return { status: "executed", proposal: prepared.proposal, receipt };
    },
  };
}

function operationProvider(operation: string): string {
  return operation.slice(0, operation.indexOf("."));
}

function accountResolutionForIdentity(
  accounts: AccountDirectory,
  call: ProviderActionCall,
  accountId: string,
) {
  return accounts.resolveExact({
    ownerId: call.accountOwnerId,
    identity: call.identity,
    provider: call.provider,
    accountId,
  });
}
