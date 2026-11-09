import { ChiefOperator, OperatorRefusal, operatorApplySchema, operatorPreviewSchema, operatorRollbackSchema } from "../chief-operator.ts";
import { personKey } from "../person-key.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createInternalChiefOperatorRoutes(deps: {
  operator: ChiefOperator;
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  direct: boolean;
  personTurn: boolean;
  guest: boolean;
  requester: string | null;
  team: boolean;
  cloudHome: boolean;
  desktopManaged: boolean;
  provenCloudOwner(person: string | undefined): boolean;
  active(): boolean;
  readBody(): Promise<unknown>;
}): RouteHandler {
  const ownerStarted = (owner: string) => deps.team ? deps.requester === personKey({ id: "", email: owner })
    : deps.cloudHome ? deps.provenCloudOwner(deps.requester ?? undefined)
      : (owner !== "local-owner" || deps.desktopManaged) && deps.requester === personKey(owner.includes("@") ? { id: "", email: owner } : { id: owner });
  const active = () => {
    if (!ownerStarted(deps.operator.ownerOf(deps.botId))) throw new OperatorRefusal(403, "Only the appointing owner can request Chief Operator settings.");
    if (!deps.active()) throw new OperatorRefusal(409, "The initiating turn ended. Preview the change in a new turn.");
    return true;
  };
  return async ({ res, path, method, json }) => {
    if (path !== "/api/internal/chief-operator") return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST for Chief Operator settings." });
    if (!deps.direct || deps.depth !== 0 || !deps.personTurn || deps.guest) {
      return json(res, 403, { error: "Chief Operator settings require a direct turn started by the owner." });
    }
    try {
      active();
      const body = await deps.readBody();
      active();
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Use action read, preview, apply or rollback." });
      const action = (body as Record<string, unknown>).action;
      if (action === "read" && Object.keys(body).length === 1) return json(res, 200, deps.operator.describe(deps.botId));
      if (action === "preview") {
        const parsed = operatorPreviewSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Preview needs setting and value. Supported: language or computerName." });
        return json(res, 200, deps.operator.preview({ botId: deps.botId, threadId: deps.threadId, generation: deps.generation, setting: parsed.data.setting, value: parsed.data.value }));
      }
      if (action === "apply") {
        const parsed = operatorApplySchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Apply needs previewId and expectedRevision from the preview." });
        return json(res, 200, deps.operator.apply({ botId: deps.botId, threadId: deps.threadId, generation: deps.generation, previewId: parsed.data.previewId, expectedRevision: parsed.data.expectedRevision, active }));
      }
      if (action === "rollback") {
        const parsed = operatorRollbackSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Rollback needs an applied receiptId and current expectedRevision." });
        return json(res, 200, deps.operator.rollback({ botId: deps.botId, receiptId: parsed.data.receiptId, expectedRevision: parsed.data.expectedRevision, active }));
      }
      return json(res, 400, { error: "Use action read, preview, apply or rollback." });
    } catch (error) {
      if (error instanceof OperatorRefusal) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
