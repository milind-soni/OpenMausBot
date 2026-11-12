import type { SettingsPageId } from "../settings-index";
import { AccountPage, PlanPage } from "./AccountPages";
import { AppPage, AppearancePage, GeneralPage } from "./AppPages";
import { DataPage, ImportExportPage, InstallationsPage, PeoplePage, SpendingPage, VaultPage } from "./DataPages";
import { PhonePage } from "./PhonePage";
import { AiPage, BotsPage, DesktopsPage, OverviewPage } from "./PlacePages";

const PAGES: Record<SettingsPageId, () => React.ReactNode> = {
  overview: OverviewPage,
  phone: PhonePage,
  ai: AiPage,
  bots: BotsPage,
  desktops: DesktopsPage,
  vault: VaultPage,
  usage: SpendingPage,
  transfer: ImportExportPage,
  data: DataPage,
  people: PeoplePage,
  installations: InstallationsPage,
  account: AccountPage,
  plan: PlanPage,
  app: AppPage,
  general: GeneralPage,
  appearance: AppearancePage,
};

export function SettingsPageBody({ page }: { page: SettingsPageId }) {
  const Page = PAGES[page];
  return <Page />;
}
