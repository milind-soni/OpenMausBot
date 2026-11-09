import { z } from "zod";

const connectedAccountResponseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/) }),
});
export type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

export const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
export type ToolkitItem = z.infer<typeof toolkitItemSchema>;
export const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

export const toolkitInventoryPageSchema = toolkitPageSchema.extend({
  items: z.array(toolkitItemSchema.extend({
    slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    connected_account: z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
      status: z.string().optional(),
    }).nullable().optional(),
  }).refine((item) => item.is_no_auth === true || item.connected_account != null)),
});
