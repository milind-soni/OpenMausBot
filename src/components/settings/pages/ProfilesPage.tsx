import { AdminOnly } from "../../AdminOnly";
import { ProfilesSettings } from "../../profiles/ProfilesSettings";

export function ProfilesPage() {
  return <AdminOnly><ProfilesSettings /></AdminOnly>;
}
