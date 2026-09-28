export interface OrganizationBranding {
  logo: string | null;
  icons: Array<{ id: string; name: string; image: string }>;
}
export function parseOrganizationBranding(value: unknown): OrganizationBranding;
