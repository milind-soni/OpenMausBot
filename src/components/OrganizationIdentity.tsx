import { useOrganizationBranding } from "@/lib/use-organization-branding";

export function OrganizationIdentity({ compact = false }: { compact?: boolean }) {
  const organization = useOrganizationBranding();
  if (!organization?.logo) return null;
  return <div className={`flex items-center gap-2 py-2 ${compact ? "justify-center px-1" : "px-4"}`} title={organization.name}>
    <img src={organization.logo} alt={`${organization.name} logo`} className="size-8 shrink-0 rounded-lg object-contain" />
    {!compact && <span className="truncate text-[13px] font-semibold text-ink-secondary">{organization.name}</span>}
  </div>;
}
