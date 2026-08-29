// PROTOTYPE ONLY: three full-shell interaction models for Agent Centipede.
// Run with `pnpm prototype:centipede`, then switch with ?variant=A|B|C.
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  FileCheck2,
  FlaskConical,
  Gauge,
  LayoutGrid,
  Link2,
  ListTodo,
  MessageSquare,
  Mic,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  TimerReset,
} from "lucide-react";

type Variant = "A" | "B" | "C";

const variants: Array<{ key: Variant; name: string }> = [
  { key: "A", name: "Clinical Command" },
  { key: "B", name: "Mission Board" },
  { key: "C", name: "Quiet Focus" },
];

function Mark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`cp-mark ${compact ? "is-compact" : ""}`} aria-label="Agent Centipede">
      <span className="cp-mark-body"><i /><i /><i /><i /></span>
      {!compact && <span><b>AGENT CENTIPEDE</b><small>CHAIN OF COMMAND</small></span>}
    </div>
  );
}

function Dot({ tone = "green" }: { tone?: "green" | "amber" | "red" | "blue" }) {
  return <span className={`cp-dot cp-dot-${tone}`} />;
}

function Composer({ label = "Ask Chief to do something…" }: { label?: string }) {
  return (
    <div className="cp-composer">
      <button aria-label="Attach"><Plus size={18} /></button>
      <span>{label}</span>
      <div className="cp-composer-actions">
        <button aria-label="Voice"><Mic size={18} /></button>
        <button className="cp-send" aria-label="Send"><ArrowRight size={18} /></button>
      </div>
    </div>
  );
}

function Message({ from, children, meta }: { from: "you" | "chief"; children: ReactNode; meta?: string }) {
  return (
    <article className={`cp-message cp-message-${from}`}>
      {from === "chief" && <div className="cp-agent-avatar">C</div>}
      <div>
        <div className="cp-message-copy">{children}</div>
        {meta && <div className="cp-message-meta">{meta}</div>}
      </div>
    </article>
  );
}

function TaskReceipt() {
  return (
    <section className="cp-receipt">
      <header>
        <div><span className="cp-kicker">MISSION 024</span><h3>Prepare the Kelvin redline package</h3></div>
        <span className="cp-status"><Dot tone="green" /> Verified</span>
      </header>
      <div className="cp-receipt-steps">
        <span><Check size={14} /> Research</span>
        <span><Check size={14} /> Draft</span>
        <span><Check size={14} /> Privacy scan</span>
        <span className="is-current"><CircleDot size={14} /> Awaiting send approval</span>
      </div>
      <footer><FileCheck2 size={15} /> 4 evidence items <button>Review package</button></footer>
    </section>
  );
}

const nav = [
  { icon: MessageSquare, label: "Chief", badge: "" },
  { icon: ListTodo, label: "Work", badge: "3" },
  { icon: Activity, label: "Capture", badge: "" },
  { icon: Monitor, label: "Computer", badge: "" },
  { icon: Link2, label: "Sources", badge: "1" },
];

function ClinicalCommand() {
  return (
    <div className="cp-a">
      <aside className="cp-a-rail">
        <Mark compact />
        <nav>
          {nav.map(({ icon: Icon, label, badge }, index) => (
            <button className={index === 0 ? "is-active" : ""} key={label} title={label}>
              <Icon size={20} /><small>{label}</small>{badge && <em>{badge}</em>}
            </button>
          ))}
        </nav>
        <button className="cp-avatar">SF</button>
      </aside>

      <main className="cp-a-main">
        <header className="cp-a-header">
          <div className="cp-title-lockup"><div className="cp-agent-avatar cp-agent-avatar-lg">C</div><div><h1>Chief</h1><p><Dot tone="green" /> ready · Grok 4.6</p></div></div>
          <div className="cp-header-actions"><button><Search size={17} /></button><button><Monitor size={17} /><span>Computer</span></button><button><MoreHorizontal size={17} /></button></div>
        </header>
        <div className="cp-a-mobile-triage"><span><b>2</b> need you</span><span><b>3</b> running</span><span><b>1.8s</b> response</span></div>
        <section className="cp-thread">
          <div className="cp-day">TODAY · WEDNESDAY</div>
          <Message from="you" meta="8:31 AM">Get the Kelvin redline ready, check it for privacy issues, and leave the final send with me.</Message>
          <Message from="chief" meta="8:31 AM · 18 seconds">
            Done. Found the latest source, built two versions, compared the redline, and ran a privacy sweep. Nothing escaped.
          </Message>
          <TaskReceipt />
          <Message from="chief" meta="8:32 AM">Your move: concise or warmer. Concise is cleaner.</Message>
        </section>
        <div className="cp-a-compose"><Composer /><p><ShieldCheck size={13} /> Anything external waits for your tap. No unauthorized surgery.</p></div>
      </main>

      <aside className="cp-a-side">
        <section className="cp-side-intro"><span className="cp-kicker">THE MORNING DAMAGE</span><h2>Morning. The machine mostly behaved.</h2><p>Two things need your brain. The rest has legs.</p></section>
        <section className="cp-panel cp-needs">
          <header><h3>Your move</h3><span>2</span></header>
          <button><div className="cp-icon amber"><Send size={16} /></div><span><b>Kelvin redline</b><small>Choose concise or warm</small></span><ArrowRight size={16} /></button>
          <button><div className="cp-icon red"><TimerReset size={16} /></div><span><b>Mercury source</b><small>Connection refused</small></span><ArrowRight size={16} /></button>
        </section>
        <section className="cp-panel">
          <header><h3>Scuttling along</h3><button>View all</button></header>
          <div className="cp-progress-row"><span><Activity size={15} /> Morning capture</span><b>8/9</b></div>
          <div className="cp-progress"><i style={{ width: "88%" }} /></div>
          <div className="cp-progress-row"><span><FlaskConical size={15} /> Product benchmark</span><b>3/7</b></div>
          <div className="cp-progress"><i style={{ width: "43%" }} /></div>
        </section>
        <section className="cp-panel cp-vitals">
          <header><h3>System vitals</h3><span className="cp-status"><Dot tone="green" /> Stable</span></header>
          <div><span>First response</span><b>1.8s</b></div><div><span>Sources fresh</span><b>11/12</b></div><div><span>Spend today</span><b>$0.84</b></div>
        </section>
      </aside>
      <MobileNav />
    </div>
  );
}

function MobileNav() {
  return <nav className="cp-mobile-nav">{nav.slice(0, 4).map(({ icon: Icon, label }, i) => <button key={label} className={i === 0 ? "is-active" : ""}><Icon size={20} /><span>{label}</span></button>)}</nav>;
}

function MissionBoard() {
  const missions = [
    ["Kelvin redline", "Waiting on you", "amber"],
    ["Morning capture", "Running · 8/9", "blue"],
    ["Agent benchmark", "Running · 3/7", "green"],
    ["Mercury recovery", "Blocked", "red"],
  ] as const;
  return (
    <div className="cp-b">
      <header className="cp-b-top"><Mark /><nav><button className="is-active">Missions</button><button>Conversation</button><button>Sources</button></nav><div><button><Search size={18} /></button><button><Settings size={18} /></button><button className="cp-avatar">SF</button></div></header>
      <aside className="cp-b-list">
        <div className="cp-b-list-head"><span><b>Mission queue</b><small>4 active · 2 need you</small></span><button><Plus size={17} /></button></div>
        <div className="cp-mission-tabs"><button className="is-active">Active</button><button>Needs me <b>2</b></button><button>Done</button></div>
        <div className="cp-missions">
          {missions.map(([name, detail, tone], i) => <button className={i === 0 ? "is-active" : ""} key={name}><Dot tone={tone} /><span><b>{name}</b><small>{detail}</small></span><ArrowRight size={15} /></button>)}
        </div>
        <div className="cp-b-pulse"><Gauge size={18} /><span><b>System healthy</b><small>11/12 sources · 1.8s response</small></span></div>
      </aside>
      <main className="cp-b-main">
        <div className="cp-mission-heading"><div><span className="cp-kicker">MISSION 024 · CLIENT WORK</span><h1>Kelvin redline package</h1><p>Research, compare, draft, verify, and stop before send.</p></div><button><MoreHorizontal size={18} /></button></div>
        <section className="cp-stagebar">
          {[["01","Understand","done"],["02","Build","done"],["03","Verify","done"],["04","Approve","active"]].map(([n,l,s]) => <div className={s} key={n}><span>{s === "done" ? <Check size={14}/> : n}</span><b>{l}</b></div>)}
        </section>
        <section className="cp-b-brief">
          <header><div className="cp-agent-avatar">C</div><div><b>Chief’s call</b><small>Updated 1 minute ago</small></div><span className="cp-status"><Dot tone="amber" /> Your move</span></header>
          <h2>Use the concise one. Cleaner, sharper, less room for nonsense.</h2>
          <p>It preserves the commercial position, removes the ambiguous acceptance language, and exposes no private internal context.</p>
          <div className="cp-choice"><button className="is-primary"><Check size={17} /> Approve concise</button><button>Review warmer draft</button></div>
        </section>
        <section className="cp-b-grid">
          <article><span className="cp-kicker">OUTPUT</span><h3>Redline package</h3><p>Two drafts, marked comparison, source memo.</p><button>Open package <ArrowRight size={15}/></button></article>
          <article><span className="cp-kicker">SAFETY</span><h3>Clean bill of health</h3><p>No secrets, private notes, or internal-only references.</p><button>Show me <ArrowRight size={15}/></button></article>
        </section>
        <Composer label="Ask a follow-up about this mission…" />
      </main>
      <aside className="cp-b-context">
        <span className="cp-kicker">LIVE DOSSIER</span><h3>What happened</h3>
        <ol className="cp-timeline">
          <li><i><Check size={13}/></i><span><b>Latest source identified</b><small>8:31:04 · Drive</small></span></li>
          <li><i><Check size={13}/></i><span><b>Terms compared</b><small>8:31:09 · 7 changes</small></span></li>
          <li><i><Check size={13}/></i><span><b>Drafts generated</b><small>8:31:14 · 2 options</small></span></li>
          <li><i><Check size={13}/></i><span><b>Independent verification</b><small>8:31:18 · Passed</small></span></li>
          <li className="active"><i><CircleDot size={13}/></i><span><b>Approval requested</b><small>Waiting for Shane</small></span></li>
        </ol>
        <section className="cp-context-card"><ShieldCheck size={19}/><div><b>Stopped at send</b><p>Everything’s ready. Nothing leaves until you tap approve.</p></div></section>
        <section className="cp-context-card"><Bot size={19}/><div><b>Computer handed back</b><p>Temporary session closed. All legs accounted for.</p></div></section>
      </aside>
    </div>
  );
}

function QuietFocus() {
  return (
    <div className="cp-c">
      <header className="cp-c-top"><Mark compact/><button className="cp-c-title"><span className="cp-agent-avatar">C</span><b>Chief</b><Dot tone="green"/><ChevronDown size={15}/></button><div><button><Search size={18}/></button><button><Monitor size={18}/></button><button className="cp-avatar">SF</button></div></header>
      <aside className="cp-c-shortcuts"><button className="is-active"><MessageSquare size={19}/><span>Talk</span></button><button><ListTodo size={19}/><span>Work</span><em>2</em></button><button><Activity size={19}/><span>Pulse</span></button><button><LayoutGrid size={19}/><span>More</span></button></aside>
      <main className="cp-c-main">
        <div className="cp-c-greeting"><span className="cp-kicker">WEDNESDAY · 8:32 AM</span><h1>What are we moving?</h1><p>Two things need your brain. The rest is behaving.</p></div>
        <section className="cp-c-thread">
          <Message from="you">Get the Kelvin redline ready and leave the final send with me.</Message>
          <Message from="chief">Done. Concise wins: cleaner, verified, and nothing escaped into the wild.</Message>
          <div className="cp-c-action"><div><span className="cp-kicker">READY FOR YOU</span><h3>Kelvin redline package</h3><p>Concise draft recommended · 4 evidence items</p></div><div><button>Review</button><button className="is-primary">Approve</button></div></div>
        </section>
        <Composer />
        <div className="cp-suggestions"><button>What needs me?</button><button>Show today’s work</button><button>Use my computer</button></div>
      </main>
      <aside className="cp-c-now"><header><span><Dot tone="green"/> Now</span><button><MoreHorizontal size={17}/></button></header><div><b>3</b><span>tasks moving</span></div><ul><li><i className="blue"/><span><b>Morning capture</b><small>8 of 9 sources</small></span></li><li><i className="green"/><span><b>Benchmark lab</b><small>Product build test</small></span></li><li><i className="amber"/><span><b>Kelvin package</b><small>Waiting on you</small></span></li></ul><button className="cp-view-work">Open work queue <ArrowRight size={15}/></button></aside>
      <MobileNav />
    </div>
  );
}

function PrototypeSwitcher({ current, onChange }: { current: Variant; onChange: (variant: Variant) => void }) {
  const index = variants.findIndex((variant) => variant.key === current);
  const cycle = (offset: number) => onChange(variants[(index + offset + variants.length) % variants.length].key);
  return (
    <div className="cp-switcher">
      <button onClick={() => cycle(-1)} aria-label="Previous variant">←</button>
      <span><b>{current}</b> {variants[index].name}</span>
      <button onClick={() => cycle(1)} aria-label="Next variant">→</button>
    </div>
  );
}

export function CentipedeShellPrototype() {
  const initial = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  const [variant, setVariant] = useState<Variant>(initial === "B" || initial === "C" ? initial : "A");
  const change = (next: Variant) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    setVariant(next);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = variants.findIndex((item) => item.key === variant);
      change(variants[(index + (event.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length].key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);
  return <div className="cp-prototype"><style>{styles}</style>{variant === "A" ? <ClinicalCommand/> : variant === "B" ? <MissionBoard/> : <QuietFocus/>}<PrototypeSwitcher current={variant} onChange={change}/></div>;
}

const styles = String.raw`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
.cp-prototype{--paper:#f5f5ef;--paper2:#eceee7;--ink:#18201d;--muted:#6d756f;--line:#d9ddd4;--dark:#111714;--green:#b9f43d;--teal:#167e75;--blue:#4779ef;--amber:#e3a32d;--red:#e66c5c;font-family:'DM Sans',sans-serif;color:var(--ink);background:var(--paper);height:100vh;overflow:hidden}.cp-prototype *{box-sizing:border-box}.cp-prototype button{font:inherit}.cp-mark{display:flex;align-items:center;gap:12px}.cp-mark span:last-child{display:flex;flex-direction:column}.cp-mark b{font:700 12px/1 'Space Mono';letter-spacing:.12em}.cp-mark small{font:8px/1.7 'Space Mono';letter-spacing:.15em;color:var(--muted)}.cp-mark-body{display:flex;align-items:center;gap:2px}.cp-mark-body i{display:block;width:9px;height:13px;border-radius:50%;background:var(--green);border:1px solid #6d8f1d;transform:rotate(-16deg)}.cp-mark-body i:nth-child(2){height:17px}.cp-mark-body i:nth-child(3){height:15px}.cp-mark.is-compact{justify-content:center}.cp-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 18%,transparent)}.cp-dot-amber{background:var(--amber);box-shadow:0 0 0 3px #e3a32d22}.cp-dot-red{background:var(--red);box-shadow:0 0 0 3px #e66c5c22}.cp-dot-blue{background:var(--blue);box-shadow:0 0 0 3px #4779ef22}.cp-kicker{font:700 10px/1.3 'Space Mono';letter-spacing:.11em;color:var(--muted)}.cp-agent-avatar,.cp-avatar{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--dark);color:var(--green);font-weight:700;border:0}.cp-agent-avatar-lg{width:42px;height:42px;border-radius:14px}.cp-status{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;border:1px solid var(--line);border-radius:99px;font:600 11px/1 'DM Sans';white-space:nowrap}.cp-composer{height:58px;border:1px solid #cbd0c7;background:#fff;border-radius:18px;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 12px;box-shadow:0 8px 24px #17201d0a;color:#949b95}.cp-composer>button,.cp-composer-actions button{border:0;background:transparent;display:grid;place-items:center;color:#7e8781;padding:8px;border-radius:11px}.cp-composer>span{flex:1;font-size:14px}.cp-composer-actions{display:flex;align-items:center}.cp-composer-actions .cp-send{background:var(--dark);color:#fff;width:42px;height:42px;border-radius:13px}.cp-message{display:flex;gap:11px;max-width:780px}.cp-message>div:last-child{max-width:640px}.cp-message-copy{font-size:15px;line-height:1.55;padding:14px 17px;border-radius:18px;background:#fff;border:1px solid #e1e4dc}.cp-message-you{justify-content:flex-end;margin-left:auto}.cp-message-you .cp-message-copy{background:var(--dark);color:#f8faf6;border-color:var(--dark);border-bottom-right-radius:5px}.cp-message-chief .cp-message-copy{border-top-left-radius:5px}.cp-message-meta{font-size:10px;color:#929a94;margin:6px 5px}.cp-message-you .cp-message-meta{text-align:right}.cp-receipt{margin-left:45px;max-width:680px;background:#f0f7dd;border:1px solid #cfe49b;border-radius:18px;overflow:hidden}.cp-receipt header{display:flex;justify-content:space-between;gap:18px;padding:17px 18px 13px}.cp-receipt h3{font-size:15px;margin:5px 0 0}.cp-receipt-steps{display:flex;gap:7px;flex-wrap:wrap;padding:0 18px 15px}.cp-receipt-steps span{display:flex;align-items:center;gap:5px;font-size:11px;padding:6px 8px;background:#ffffff9c;border-radius:7px;color:#4c5a51}.cp-receipt-steps .is-current{background:var(--dark);color:#fff}.cp-receipt footer{border-top:1px solid #d4e7a9;padding:11px 18px;display:flex;gap:7px;align-items:center;font-size:11px}.cp-receipt footer button{margin-left:auto;border:0;background:transparent;font-weight:700;color:var(--teal)}.cp-mobile-nav{display:none}.cp-switcher{position:fixed;z-index:1000;bottom:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;background:#111714;color:white;padding:6px;border-radius:99px;box-shadow:0 12px 40px #0004}.cp-switcher button{border:0;background:#ffffff12;color:#fff;width:32px;height:32px;border-radius:50%}.cp-switcher span{min-width:190px;text-align:center;font-size:12px}.cp-switcher span b{color:var(--green);font-family:'Space Mono';margin-right:5px}

/* A: narrow command rail + conversation + contextual cockpit */
.cp-a{display:grid;grid-template-columns:78px minmax(500px,1fr) 350px;height:100%;background:var(--paper)}.cp-a-rail{background:var(--dark);color:#fff;padding:20px 10px 16px;display:flex;flex-direction:column;align-items:center}.cp-a-rail nav{display:flex;flex-direction:column;gap:7px;margin-top:44px;width:100%}.cp-a-rail nav button{position:relative;border:0;background:transparent;color:#818d86;display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 3px;border-radius:13px}.cp-a-rail nav button small{font-size:9px}.cp-a-rail nav button em{position:absolute;top:5px;right:11px;background:var(--red);color:#fff;font-style:normal;font-size:8px;width:15px;height:15px;border-radius:50%;display:grid;place-items:center}.cp-a-rail nav button.is-active{background:#b9f43d13;color:var(--green)}.cp-a-rail>.cp-avatar{margin-top:auto;background:#2d3833;color:#fff}.cp-a-main{min-width:0;display:flex;flex-direction:column;background:#fafaf6}.cp-a-header{height:70px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 24px}.cp-title-lockup{display:flex;align-items:center;gap:11px}.cp-title-lockup h1{font-size:17px;margin:0}.cp-title-lockup p{font-size:10px;color:var(--muted);margin:4px 0 0;display:flex;align-items:center;gap:7px}.cp-header-actions{display:flex;gap:7px}.cp-header-actions button{border:1px solid var(--line);background:#fff;border-radius:10px;height:36px;padding:0 10px;display:flex;align-items:center;gap:7px;color:var(--ink);font-size:11px}.cp-thread{flex:1;overflow:auto;padding:28px max(28px,calc((100% - 760px)/2));display:flex;flex-direction:column;gap:17px}.cp-day{text-align:center;font:700 9px 'Space Mono';letter-spacing:.12em;color:#9ca39e;margin-bottom:4px}.cp-a-compose{padding:12px max(28px,calc((100% - 760px)/2)) 20px}.cp-a-compose p{font-size:9px;color:#929a94;text-align:center;margin:7px 0 0;display:flex;align-items:center;justify-content:center;gap:4px}.cp-a-side{border-left:1px solid var(--line);padding:29px 22px;background:#f0f1eb;overflow:auto}.cp-side-intro{padding:3px 3px 23px}.cp-side-intro h2{font-size:22px;letter-spacing:-.03em;margin:8px 0 6px}.cp-side-intro p{font-size:12px;color:var(--muted);line-height:1.5;margin:0}.cp-panel{background:#fff;border:1px solid var(--line);border-radius:17px;padding:15px;margin-bottom:12px}.cp-panel header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.cp-panel header h3{font-size:13px;margin:0}.cp-panel header>span:not(.cp-status){width:21px;height:21px;border-radius:7px;background:var(--dark);color:#fff;font-size:10px;display:grid;place-items:center}.cp-panel header>button{border:0;background:transparent;color:var(--teal);font-size:10px;font-weight:700}.cp-needs>button{width:100%;display:flex;align-items:center;gap:10px;border:0;background:transparent;padding:10px 0;text-align:left;border-top:1px solid #edf0e9}.cp-needs>button>span{display:flex;flex-direction:column;gap:3px;flex:1}.cp-needs>button b{font-size:11px}.cp-needs>button small{font-size:9px;color:var(--muted)}.cp-icon{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;background:#eef1ea;color:var(--teal)}.cp-icon.amber{background:#fff4dc;color:#a76d00}.cp-icon.red{background:#fff0ed;color:#bc4a3d}.cp-progress-row{display:flex;align-items:center;justify-content:space-between;font-size:10px;margin:10px 0 6px}.cp-progress-row span{display:flex;align-items:center;gap:6px}.cp-progress{height:5px;border-radius:99px;background:#e8ebe4;overflow:hidden}.cp-progress i{display:block;height:100%;background:var(--teal);border-radius:99px}.cp-vitals>div{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #edf0e9;font-size:10px}.cp-a-mobile-triage{display:none}

/* B: mission queue + stage-based dossier */
.cp-b{height:100%;display:grid;grid-template:68px 1fr / 292px minmax(520px,1fr) 304px;background:#f8f8f3}.cp-b-top{grid-column:1/-1;display:flex;align-items:center;padding:0 22px;border-bottom:1px solid var(--line);background:#fff;z-index:2}.cp-b-top>nav{display:flex;align-self:stretch;margin-left:54px}.cp-b-top>nav button{border:0;background:transparent;padding:0 18px;font-size:12px;color:var(--muted);position:relative}.cp-b-top>nav button.is-active{color:var(--ink);font-weight:700}.cp-b-top>nav button.is-active:after{content:'';position:absolute;bottom:0;left:18px;right:18px;height:2px;background:var(--teal)}.cp-b-top>div{margin-left:auto;display:flex;gap:8px;align-items:center}.cp-b-top>div>button:not(.cp-avatar){border:1px solid var(--line);background:#fff;width:36px;height:36px;border-radius:10px;display:grid;place-items:center}.cp-b-list{border-right:1px solid var(--line);background:#f0f1eb;padding:20px 16px;display:flex;flex-direction:column;min-height:0}.cp-b-list-head{display:flex;justify-content:space-between;align-items:center;padding:0 4px 14px}.cp-b-list-head span{display:flex;flex-direction:column}.cp-b-list-head b{font-size:13px}.cp-b-list-head small{font-size:9px;color:var(--muted);margin-top:3px}.cp-b-list-head button{border:0;background:var(--dark);color:#fff;width:30px;height:30px;border-radius:9px;display:grid;place-items:center}.cp-mission-tabs{display:flex;gap:4px;background:#e3e6de;padding:4px;border-radius:10px}.cp-mission-tabs button{flex:1;border:0;background:transparent;border-radius:7px;padding:7px 4px;font-size:9px;color:var(--muted)}.cp-mission-tabs button.is-active{background:#fff;color:var(--ink);font-weight:700;box-shadow:0 2px 5px #0000000d}.cp-mission-tabs b{background:var(--red);color:#fff;border-radius:99px;padding:1px 5px}.cp-missions{display:flex;flex-direction:column;gap:5px;margin-top:14px}.cp-missions>button{border:1px solid transparent;background:transparent;border-radius:13px;padding:12px;display:flex;align-items:center;gap:10px;text-align:left}.cp-missions>button.is-active{background:#fff;border-color:var(--line);box-shadow:0 7px 20px #18201d0a}.cp-missions>button>span{display:flex;flex-direction:column;gap:3px;flex:1}.cp-missions b{font-size:11px}.cp-missions small{font-size:9px;color:var(--muted)}.cp-b-pulse{margin-top:auto;background:var(--dark);color:#fff;border-radius:14px;padding:13px;display:flex;gap:10px;align-items:center}.cp-b-pulse>span{display:flex;flex-direction:column}.cp-b-pulse b{font-size:10px}.cp-b-pulse small{font-size:8px;color:#9ca8a1;margin-top:3px}.cp-b-main{padding:31px 38px;overflow:auto}.cp-mission-heading{display:flex;justify-content:space-between;align-items:flex-start}.cp-mission-heading h1{font-size:28px;letter-spacing:-.04em;margin:7px 0 5px}.cp-mission-heading p{font-size:12px;color:var(--muted);margin:0}.cp-mission-heading>button{border:1px solid var(--line);background:#fff;border-radius:10px;width:36px;height:36px;display:grid;place-items:center}.cp-stagebar{display:grid;grid-template-columns:repeat(4,1fr);margin:27px 0 23px}.cp-stagebar>div{display:flex;align-items:center;gap:8px;position:relative;color:#9aa29c}.cp-stagebar>div:not(:last-child):after{content:'';height:1px;background:#ccd1c8;position:absolute;left:70px;right:10px}.cp-stagebar span{width:26px;height:26px;border:1px solid #cdd2c9;border-radius:50%;display:grid;place-items:center;font:700 9px 'Space Mono';background:#f8f8f3;z-index:1}.cp-stagebar b{font-size:10px}.cp-stagebar .done{color:var(--teal)}.cp-stagebar .done span{background:var(--teal);border-color:var(--teal);color:#fff}.cp-stagebar .active{color:var(--ink)}.cp-stagebar .active span{background:var(--green);border-color:#9dcf32}.cp-b-brief{background:#fff;border:1px solid var(--line);border-radius:19px;padding:20px}.cp-b-brief header{display:flex;align-items:center;gap:10px}.cp-b-brief header>div:nth-child(2){display:flex;flex-direction:column}.cp-b-brief header b{font-size:11px}.cp-b-brief header small{font-size:9px;color:var(--muted);margin-top:2px}.cp-b-brief header>.cp-status{margin-left:auto}.cp-b-brief h2{font-size:22px;letter-spacing:-.03em;margin:22px 0 7px}.cp-b-brief>p{font-size:12px;line-height:1.55;color:#59635d;max-width:660px}.cp-choice{display:flex;gap:8px;margin-top:18px}.cp-choice button{border:1px solid var(--line);background:#fff;padding:10px 14px;border-radius:11px;font-size:10px;font-weight:700}.cp-choice button.is-primary{background:var(--dark);color:#fff;border-color:var(--dark);display:flex;align-items:center;gap:6px}.cp-b-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.cp-b-grid article{background:#f0f1eb;border:1px solid var(--line);border-radius:16px;padding:16px}.cp-b-grid h3{font-size:13px;margin:7px 0 4px}.cp-b-grid p{font-size:10px;line-height:1.45;color:var(--muted);margin:0 0 12px}.cp-b-grid button{border:0;background:transparent;color:var(--teal);font-size:10px;font-weight:700;padding:0;display:flex;align-items:center;gap:5px}.cp-b-context{border-left:1px solid var(--line);background:#fff;padding:27px 20px;overflow:auto}.cp-b-context>h3{font-size:17px;margin:7px 0 18px}.cp-timeline{list-style:none;padding:0;margin:0}.cp-timeline li{display:flex;gap:10px;position:relative;padding-bottom:19px}.cp-timeline li:not(:last-child):after{content:'';position:absolute;width:1px;background:#dfe3db;left:12px;top:25px;bottom:0}.cp-timeline i{width:25px;height:25px;border-radius:50%;background:#dff0e9;color:var(--teal);display:grid;place-items:center;z-index:1}.cp-timeline li.active i{background:var(--green);color:var(--ink)}.cp-timeline span{display:flex;flex-direction:column;padding-top:2px}.cp-timeline b{font-size:10px}.cp-timeline small{font-size:8px;color:var(--muted);margin-top:3px}.cp-context-card{display:flex;gap:10px;background:#f4f5ef;border-radius:13px;padding:13px;margin-top:10px;color:var(--teal)}.cp-context-card div{color:var(--ink)}.cp-context-card b{font-size:10px}.cp-context-card p{font-size:9px;line-height:1.45;color:var(--muted);margin:3px 0 0}

/* C: conversation first, context floats */
.cp-c{height:100%;background:#fbfbf7;position:relative;display:flex;flex-direction:column}.cp-c-top{height:62px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 20px}.cp-c-top>.cp-mark{width:170px;justify-content:flex-start}.cp-c-title{border:0;background:transparent;display:flex;align-items:center;gap:8px;margin:auto}.cp-c-title .cp-agent-avatar{width:29px;height:29px;border-radius:9px}.cp-c-title b{font-size:12px}.cp-c-top>div{width:170px;display:flex;justify-content:flex-end;gap:7px;align-items:center}.cp-c-top>div>button:not(.cp-avatar){width:34px;height:34px;border:0;background:transparent;display:grid;place-items:center;border-radius:9px}.cp-c-shortcuts{position:absolute;left:20px;top:50%;transform:translateY(-50%);background:var(--dark);border-radius:19px;padding:8px;display:flex;flex-direction:column;gap:5px;box-shadow:0 15px 45px #0002}.cp-c-shortcuts button{position:relative;width:52px;height:52px;border:0;background:transparent;color:#87928c;border-radius:13px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px}.cp-c-shortcuts button span{font-size:8px}.cp-c-shortcuts button.is-active{background:#b9f43d18;color:var(--green)}.cp-c-shortcuts em{position:absolute;right:5px;top:5px;font-style:normal;background:var(--red);color:white;font-size:7px;width:14px;height:14px;border-radius:50%;display:grid;place-items:center}.cp-c-main{width:min(760px,calc(100% - 500px));margin:auto;display:flex;flex-direction:column;min-height:0;padding:28px 0 45px}.cp-c-greeting{text-align:center;margin-bottom:30px}.cp-c-greeting h1{font-size:28px;letter-spacing:-.04em;margin:8px 0 5px}.cp-c-greeting p{font-size:12px;color:var(--muted);margin:0}.cp-c-thread{display:flex;flex-direction:column;gap:15px;flex:1;overflow:auto;padding:5px}.cp-c-action{background:#edf5dc;border:1px solid #d3e6a7;border-radius:17px;padding:15px 17px;display:flex;justify-content:space-between;align-items:center;margin-left:45px}.cp-c-action h3{font-size:13px;margin:5px 0 2px}.cp-c-action p{font-size:9px;color:var(--muted);margin:0}.cp-c-action>div:last-child{display:flex;gap:6px}.cp-c-action button{border:1px solid #c7d6a7;background:#fff;border-radius:9px;padding:8px 11px;font-size:9px;font-weight:700}.cp-c-action button.is-primary{background:var(--dark);color:#fff;border-color:var(--dark)}.cp-suggestions{display:flex;justify-content:center;gap:7px;margin-top:9px}.cp-suggestions button{border:1px solid var(--line);background:transparent;padding:7px 10px;border-radius:99px;font-size:9px;color:var(--muted)}.cp-c-now{position:absolute;right:22px;top:50%;transform:translateY(-50%);width:230px;background:#fff;border:1px solid var(--line);border-radius:18px;padding:15px;box-shadow:0 15px 50px #18201d0c}.cp-c-now header{display:flex;justify-content:space-between}.cp-c-now header>span{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:700}.cp-c-now header button{border:0;background:transparent}.cp-c-now>div{margin:18px 0 12px;display:flex;align-items:baseline;gap:6px}.cp-c-now>div b{font-size:31px;letter-spacing:-.05em}.cp-c-now>div span{font-size:10px;color:var(--muted)}.cp-c-now ul{list-style:none;padding:0;margin:0}.cp-c-now li{display:flex;gap:9px;padding:10px 0;border-top:1px solid #edf0e9}.cp-c-now li>i{display:block;width:3px;border-radius:99px;background:var(--green)}.cp-c-now li>i.blue{background:var(--blue)}.cp-c-now li>i.amber{background:var(--amber)}.cp-c-now li span{display:flex;flex-direction:column;gap:3px}.cp-c-now li b{font-size:9px}.cp-c-now li small{font-size:8px;color:var(--muted)}.cp-view-work{border:0;background:#f0f1eb;width:100%;border-radius:10px;padding:9px 10px;margin-top:7px;font-size:9px;font-weight:700;display:flex;justify-content:space-between;align-items:center}

.cp-a-main{min-height:0}
@media(max-width:1050px){.cp-a{grid-template-columns:72px 1fr}.cp-a-side{display:none}.cp-b{grid-template-columns:250px 1fr}.cp-b-context{display:none}.cp-c-main{width:min(690px,calc(100% - 200px));margin-left:115px}.cp-c-now{display:none}}
@media(max-width:700px){.cp-prototype{height:100dvh}.cp-switcher{bottom:74px}.cp-switcher span{min-width:155px}.cp-a{display:block;padding-bottom:62px}.cp-a-rail{display:none}.cp-a-header{height:58px;padding:0 14px}.cp-header-actions button span{display:none}.cp-header-actions button:nth-child(1),.cp-header-actions button:nth-child(3){border:0;background:transparent;padding:0 5px}.cp-a-mobile-triage{display:flex;gap:6px;overflow:auto;padding:9px 12px;border-bottom:1px solid var(--line)}.cp-a-mobile-triage span{white-space:nowrap;background:#eef0e9;padding:7px 9px;border-radius:9px;font-size:9px}.cp-thread{padding:18px 13px;gap:14px}.cp-message-copy{font-size:14px}.cp-message-chief .cp-agent-avatar{display:none}.cp-message>div:last-child{max-width:90%}.cp-receipt{margin-left:0}.cp-receipt header{flex-direction:column}.cp-receipt-steps span{display:none}.cp-receipt-steps .is-current{display:flex}.cp-a-compose{padding:8px 12px 15px;position:sticky;bottom:0;background:#fafaf6}.cp-a-compose p{display:none}.cp-mobile-nav{display:flex;position:absolute;bottom:0;left:0;right:0;height:62px;background:#111714;border-top:1px solid #27322d;z-index:5;padding:5px 8px}.cp-mobile-nav button{flex:1;border:0;background:transparent;color:#7f8984;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}.cp-mobile-nav button span{font-size:8px}.cp-mobile-nav button.is-active{color:var(--green)}
.cp-b{display:flex;flex-direction:column;padding-bottom:0;overflow:auto}.cp-b-top{height:57px;min-height:57px;padding:0 12px}.cp-b-top .cp-mark span:last-child,.cp-b-top>nav,.cp-b-top>div>button:nth-child(1),.cp-b-top>div>button:nth-child(2){display:none}.cp-b-top>div{margin-left:auto}.cp-b-list{border:0;padding:13px 12px 9px;display:block}.cp-b-pulse,.cp-missions{display:none}.cp-mission-tabs{display:none}.cp-b-main{padding:17px 13px 90px;overflow:visible}.cp-mission-heading h1{font-size:22px}.cp-mission-heading p{font-size:10px}.cp-stagebar{margin:20px 0}.cp-stagebar b{display:none}.cp-stagebar>div:not(:last-child):after{left:32px;right:5px}.cp-b-brief{padding:16px}.cp-b-brief h2{font-size:19px}.cp-b-brief header>.cp-status{display:none}.cp-choice{flex-direction:column}.cp-choice button{justify-content:center}.cp-b-grid{grid-template-columns:1fr}.cp-b-main>.cp-composer{position:fixed;bottom:12px;left:12px;right:12px;z-index:4}.cp-b-context{display:none}
.cp-c-top{height:57px;padding:0 12px}.cp-c-top>.cp-mark{width:auto}.cp-c-top>div{width:auto;margin-left:auto}.cp-c-top>div>button:nth-child(1){display:none}.cp-c-title{margin-left:13px}.cp-c-shortcuts,.cp-c-now{display:none}.cp-c-main{width:auto;margin:0;padding:24px 13px 125px;flex:1}.cp-c-greeting{text-align:left;margin-bottom:24px}.cp-c-greeting h1{font-size:25px}.cp-c-thread{overflow:visible}.cp-c-action{margin-left:0;align-items:flex-start;flex-direction:column;gap:13px}.cp-c-action>div:last-child{width:100%}.cp-c-action button{flex:1}.cp-c-main>.cp-composer{position:fixed;bottom:67px;left:12px;right:12px;z-index:4}.cp-suggestions{display:none}}
`;
