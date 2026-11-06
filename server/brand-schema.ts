import { z } from "zod";

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
export const MAX_LOGO_CHARS = 300_000;
export const MAX_FAVICON_CHARS = 120_000;

export const BRAND_FIELDS = ["name", "tagline", "accent", "logo", "favicon", "supportUrl"] as const;
export type BrandField = (typeof BRAND_FIELDS)[number];

export const brandSchema = z
  .object({
    /** Product name shown in the window title, onboarding and settings. */
    name: z.string().trim().min(1, "name must not be empty").max(40, "name must be 40 characters or fewer"),
    /** One line under the name on the welcome screen. */
    tagline: z.string().trim().max(120, "tagline must be 120 characters or fewer").optional(),
    /** Accent colour for buttons, links and focus rings; text on it is derived for contrast. */
    accent: z.string().regex(HEX_COLOUR, "accent must be a 6-digit hex colour such as #C2510A").optional(),
    /** Welcome-screen mark: an inline data:image/... URI or an https:// URL. */
    logo: z
      .string()
      .max(MAX_LOGO_CHARS, `logo must be under ${MAX_LOGO_CHARS} characters (inline a small SVG or link an https:// image)`)
      .refine((v) => v.startsWith("data:image/") || v.startsWith("https://"), "logo must be a data:image/... URI or an https:// URL")
      .optional(),
    /** Where "get help" points for this deployment. */
    supportUrl: z.string().url().startsWith("https://", "supportUrl must be an https:// URL").optional(),
    /** Tab and home-screen icon: an inline data:image/... URI (PNG or SVG, small) or an https:// URL. */
    favicon: z
      .string()
      .max(MAX_FAVICON_CHARS, `favicon must be under ${MAX_FAVICON_CHARS} characters (a 64px PNG or a small SVG)`)
      .refine((v) => v.startsWith("data:image/") || v.startsWith("https://"), "favicon must be a data:image/... URI or an https:// URL")
      .optional(),
  })
  .strict();

export type Brand = z.infer<typeof brandSchema>;
