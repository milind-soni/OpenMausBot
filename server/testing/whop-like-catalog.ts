// A synthetic catalog shaped like Whop's official MCP server, which lists 425
// tools in 1.2 MB of JSON: `<area>_<action>` names over a few dozen areas, a
// company_id on nearly every tool, readOnlyHint on the reads, and the odd
// distractor whose description mentions other areas' words. No real Whop
// data: every name and sentence here is made up for tests.
import type { FakeHttpMcpTool } from "./fake-http-mcp-server.ts";

const AREAS = [
  "payments", "memberships", "invoices", "products", "plans", "experiences", "companies", "users",
  "accounts", "reviews", "refunds", "disputes", "transfers", "payouts", "webhooks", "apps",
  "courses", "chats", "forums", "leads", "notifications", "shipments", "entries", "files",
  "messages", "reactions", "taxes", "wallets", "promotions", "affiliates", "authorizations", "checkouts",
  "subscriptions", "customers", "coupons", "orders", "teams", "roles", "audits", "exports",
  "bounties", "licenses", "receipts",
];

const ACTIONS: Array<{ action: string; read: boolean; describe(area: string): string }> = [
  { action: "list", read: true, describe: (area) => `List ${area} for a company, newest first. Supports pagination with first and after.` },
  { action: "get", read: true, describe: (area) => `Retrieve one of the company's ${area} by its ID.` },
  { action: "create", read: false, describe: (area) => `Create new ${area} for a company.` },
  { action: "update", read: false, describe: (area) => `Update fields on existing ${area}.` },
  { action: "delete", read: false, describe: (area) => `Permanently delete ${area}. This cannot be undone.` },
  { action: "search", read: true, describe: (area) => `Find ${area} matching a text query.` },
  { action: "archive", read: false, describe: (area) => `Archive ${area} so they stop appearing in lists.` },
  { action: "export", read: true, describe: (area) => `Export ${area} as a CSV file.` },
  { action: "count", read: true, describe: (area) => `Count ${area} matching filters.` },
  { action: "update-fees", read: false, describe: (area) => `Change the fees charged on ${area}.` },
];

function schemaFor(action: string, padding: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    company_id: { type: "string", description: `The company the request is for.${padding ? ` ${"x".repeat(padding)}` : ""}` },
  };
  const required = ["company_id"];
  if (action === "list" || action === "search") {
    properties.first = { type: "integer", minimum: 1, maximum: 100, description: "How many to return." };
    properties.after = { type: "string", description: "Cursor from the previous page." };
    properties.order = { type: "string", enum: ["created_at", "updated_at"] };
  }
  if (action === "search") {
    properties.query = { type: "string" };
    required.push("query");
  }
  if (["get", "update", "delete", "archive", "update-fees"].includes(action)) {
    properties.id = { type: "string" };
    required.push("id");
  }
  if (action === "update" || action === "create") {
    properties.fields = { type: "object", additionalProperties: true };
    properties.tags = { type: "array", items: { type: "string" } };
    properties.status = { anyOf: [{ type: "string" }, { type: "null" }] };
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** `count` tools, at most 432: two distractors, then each action across
 * every area in turn. With `padding`, each schema carries that many more
 * characters, to reach a catalog of a given size. */
export function whopLikeCatalog(count = 300, padding = 0): FakeHttpMcpTool[] {
  const tools: FakeHttpMcpTool[] = [
    // distractors that mention payments and lists without being the list
    { name: "stats_get", description: "Get statistics for a company, such as payments listed by day.", inputSchema: schemaFor("get", padding), annotations: { readOnlyHint: true } },
    { name: "payments_list_refunded", description: "List payments that were refunded, with their refund details, for a company across every product and plan it sells.", inputSchema: schemaFor("list", padding), annotations: { readOnlyHint: true } },
  ];
  for (const { action, read, describe } of ACTIONS) {
    for (const area of AREAS) {
      if (tools.length >= count) break;
      tools.push({
        name: `${area}_${action}`,
        description: describe(area),
        inputSchema: schemaFor(action, padding),
        annotations: read ? { readOnlyHint: true } : action === "delete" ? { destructiveHint: true } : {},
      });
    }
  }
  return tools.slice(0, count);
}

// ── a catalog that puts its meaning in parameters ──
//
// Modeled on what the live Whop server showed (synthetic text, none of it
// Whop's own): many descriptions say little ("Lists payments, newest
// first."), while the words a person asks with live in parameters: a
// `metric` enum offering revenue, a period enum offering this_week.
// "revenue" is in the descriptions of only three unrelated tools, and the
// tools that answer revenue questions name it only in their schemas.
// "payment" and "member" appear all over the catalog, so they say little
// on their own, and payments_list never mentions failed payments at all.

const id = (what: string) => ({ type: "string", description: `The ${what}'s ID.` });
const page = {
  first: { type: "integer", minimum: 1, maximum: 100, description: "How many to return, at most 100." },
  after: { type: "string", description: "Cursor from the previous page." },
};
const company = { company_id: id("company") };
const obj = (properties: Record<string, unknown>, required: string[] = ["company_id"]) => ({ type: "object", properties, required, additionalProperties: false });
const range = {
  created_after: { type: "string", format: "date-time", description: "Only include records created at or after this time." },
  created_before: { type: "string", format: "date-time", description: "Only include records created before this time." },
};
const t = (name: string, description: string, inputSchema: Record<string, unknown>, readOnly = true): FakeHttpMcpTool =>
  ({ name, description, inputSchema, annotations: readOnly ? { readOnlyHint: true } : {} });

/** About sixty tools in the shape above, plus generic filler areas. */
export function parameterHeavyCatalog(): FakeHttpMcpTool[] {
  const tools: FakeHttpMcpTool[] = [
    t("products_list", "Lists products, newest first.", obj({ ...company, visibility: { type: "string", enum: ["visible", "hidden", "archived"] }, ...page })),
    t("products_get", "Retrieves one product.", obj({ ...company, id: id("product") }, ["company_id", "id"])),
    t("products_create", "Creates a product.", obj({ ...company, title: { type: "string" }, price: { type: "number" } }), false),
    t("products_update", "Updates a product.", obj({ ...company, id: id("product"), title: { type: "string" } }, ["company_id", "id"]), false),
    t("payments_list", "Lists payments, newest first.", obj({
      ...company,
      statuses: { type: "array", description: "Only payments in these statuses.", items: { type: "string", enum: ["draft", "open", "paid", "pending", "refunded", "uncollectible", "void"] } },
      product_ids: { type: "array", items: { type: "string" }, description: "Only payments for these products." },
      ...range, ...page,
    })),
    t("payments_get", "Retrieves one payment by its ID.", obj({ ...company, id: id("payment") }, ["company_id", "id"])),
    t("payments_retry", "Retries a failed payment.", obj({ ...company, id: id("payment") }, ["company_id", "id"]), false),
    t("payments_refund", "Refunds a payment, in full or in part.", obj({ ...company, id: id("payment"), amount: { type: "number" } }, ["company_id", "id"]), false),
    t("payments_void", "Voids a payment that has not settled yet.", obj({ ...company, id: id("payment") }, ["company_id", "id"]), false),
    t("accounts_retry_ads_payment", "Retries the failed payment for an ad account's balance.", obj({ ...company, account_id: id("ad account") }), false),
    t("accounts_update-fees", "Changes the fee settings on an account.", obj({ ...company, fee_bps: { type: "integer" } }), false),
    t("partners_leaderboard", "Ranks a company's partners by the revenue they referred this month.", obj({ ...company, ...page })),
    t("members_list", "Lists members with their total spend and lifetime revenue.", obj({ ...company, ...page })),
    t("ad-conversion-value-rules_create", "Creates a rule for the conversion value (revenue) an ad event reports.", obj({ ...company, event: { type: "string" }, value: { type: "number" } }), false),
    t("stats_get", "Returns one metric for a company over a time window.", obj({
      ...company,
      metric: { type: "string", description: "Which number to compute, for example net_revenue.", enum: ["gross_revenue", "net_revenue", "new_members", "churned_members", "mrr", "arr", "refunds"] },
      interval: { type: "string", enum: ["day", "week", "month", "year"] },
      from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
    }, ["company_id", "metric"])),
    t("ledgers_report", "Summarizes ledger activity for a company.", obj({
      ...company,
      metric: { type: "string", description: "What to total: revenue, fees or payouts.", enum: ["revenue", "fees", "payouts", "balance"] },
      period: { type: "string", enum: ["today", "this_week", "last_week", "this_month", "last_month"] },
    })),
    t("ledgers_breakdown", "Breaks ledger totals down by product or plan.", obj({
      ...company, group_by: { type: "string", enum: ["product", "plan"] }, metric: { type: "string", enum: ["revenue", "fees"] },
    })),
    t("ledgers_list", "Lists ledger entries.", obj({ ...company, kind: { type: "string", enum: ["revenue", "fee", "payout", "refund", "adjustment"] }, ...range, ...page })),
    t("payouts_list", "Lists payouts to the company's bank account.", obj({ ...company, ...range, ...page })),
    t("payouts_create", "Starts a payout of the available balance.", obj({ ...company, amount: { type: "number" } }), false),
    t("refunds_list", "Lists refunds.", obj({ ...company, ...range, ...page })),
    t("disputes_list", "Lists disputes opened against payments.", obj({ ...company, status: { type: "string", enum: ["open", "won", "lost"] }, ...page })),
    t("connection_status", "Checks that the connection works and says which account it uses.", { type: "object", properties: {} }),
    t("payment-method-domains_verify", "Verifies a domain so it can take payments with wallets.", obj({ ...company, domain: { type: "string" } }), false),
    t("payment-method-domains_list", "Lists the domains registered for payment methods.", obj({ ...company, ...page })),
    t("payment-rules_replace", "Replaces the payment rules of a product.", obj({ ...company, product_id: id("product"), rules: { type: "array", items: { type: "object" } } }), false),
    t("payment-methods_list", "Lists a member's saved payment methods.", obj({ ...company, member_id: id("member"), ...page })),
    t("memberships_cancel", "Cancels a membership at the end of its billing period.", obj({ ...company, id: id("membership") }, ["company_id", "id"]), false),
    t("memberships_pause", "Pauses a membership's payments.", obj({ ...company, id: id("membership") }, ["company_id", "id"]), false),
    t("promo-codes_create", "Creates a promo code that discounts a plan.", obj({ ...company, code: { type: "string" }, percent_off: { type: "number" } }), false),
    t("promo-codes_list", "Lists promo codes.", obj({ ...company, ...page })),
    t("promo-codes_delete", "Deletes a promo code.", obj({ ...company, id: id("promo code") }, ["company_id", "id"]), false),
  ];
  const filler = ["memberships", "invoices", "plans", "experiences", "webhooks", "courses", "chats", "forums", "leads", "shipments", "reviews", "coupons", "teams",
    "exports", "product-affiliates", "ad-groups", "notifications", "entries", "transfers", "wallets", "authorizations"];
  for (const area of filler) {
    tools.push(
      t(`${area}_list`, `Lists ${area}, newest first, with the member and payment each belongs to.`, obj({ ...company, member_id: id("member"), ...page })),
      t(`${area}_get`, `Retrieves one of the ${area} by its ID, with its member and payment details.`, obj({ ...company, id: id(area) }, ["company_id", "id"])),
      t(`${area}_create`, `Creates ${area} for a member.`, obj({ ...company, fields: { type: "object", additionalProperties: true } }), false),
    );
  }
  return tools;
}
