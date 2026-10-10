// Relative thread stamps at every label age, for before/after evidence. The
// row is store-free, so the fixture stages six threads directly and pins one
// clock: the same markup runs unchanged on main (absolute dates) and on this
// branch (relative labels). Driven headlessly by a capture script through
// mountPreview in preview-fixture.ts.
import { createRoot } from "react-dom/client";
import { SidebarThreadRow } from "../../src/components/SidebarThreadRow";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

const now = Date.now();
const ages: [label: string, ms: number][] = [
  ["30 s", 30_000],
  ["5 min", 5 * 60_000],
  ["3 h", 3 * 3_600_000],
  ["26 h", 26 * 3_600_000],
  ["2 d", 2 * 86_400_000],
  ["9 d", 9 * 86_400_000],
];

function Fixture() {
  return <div className="flex h-screen items-center justify-center bg-app p-8">
    <div className="w-80 rounded-lg border border-hairline/50 bg-card p-2">
      {ages.map(([label, age]) => <SidebarThreadRow
        key={label}
        task={{ threadId: label, title: `${label} old`, updatedAt: now - age }}
        ownerId="preview"
        current={false}
        now={now}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />)}
    </div>
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<Fixture />);

