import type { SettingsPageId } from "../settings-index";
import { AccountPage, PlanPage } from "./AccountPages";
import { AppPage, AppearancePage, GeneralPage } from "./AppPages";
import { DataPage, ImportExportPage, InstallationsPage, PeoplePage, SpendingPage, VaultPage } from "./DataPages";
import { DevicesPage } from "./DevicesPage";
import { FeaturesPage } from "./FeaturesPage";
import { PhonePage } from "./PhonePage";
import { AiPage, BotsPage, DesktopsPage, OverviewPage } from "./PlacePages";
import { StoragePage } from "./StoragePage";

const PAGES: Record<SettingsPageId, () => React.ReactNode> = {
  overview: OverviewPage,
  devices: DevicesPage,
  phone: PhonePage,
  ai: AiPage,
  bots: BotsPage,
  desktops: DesktopsPage,
  vault: VaultPage,
  usage: SpendingPage,
  transfer: ImportExportPage,
  storage: StoragePage,
  data: DataPage,
  people: PeoplePage,
  installations: InstallationsPage,
  account: AccountPage,
  plan: PlanPage,
  app: AppPage,
  general: GeneralPage,
  appearance: AppearancePage,
  features: FeaturesPage,
};

export function SettingsPageBody({ page }: { page: SettingsPageId }) {
  const Page = PAGES[page];
  return <Page />;
}
