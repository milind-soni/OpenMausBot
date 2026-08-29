// PROTOTYPE ONLY: three ways to hide Agent Centipede's power behind a calm default.
// Run with `pnpm prototype:simplicity`, then switch with ?variant=A|B|C.
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Circle,
  Command,
  Ellipsis,
  ListTodo,
  Menu,
  MessageCircle,
  Mic,
  Monitor,
  Paperclip,
  Search,
  Settings,
  Sparkles,
  X,
} from "lucide-react";

type Variant = "A" | "B" | "C";

const variants: Array<{ key: Variant; name: string }> = [
  { key: "A", name: "One Conversation" },
  { key: "B", name: "Daily Brief" },
  { key: "C", name: "Context Drawer" },
];

function AgentMark() {
  return <span className="simp-mark" aria-label="Agent Centipede"><i /><i /><i /><i /></span>;
}

function Avatar() {
  return <span className="simp-avatar">A</span>;
}

function Composer({ placeholder = "What should we move?" }: { placeholder?: string }) {
  return (
    <div className="simp-composer">
      <button aria-label="Attach"><Paperclip size={18} /></button>
      <span>{placeholder}</span>
      <button aria-label="Voice"><Mic size={18} /></button>
      <button className="is-send" aria-label="Send"><ArrowRight size={18} /></button>
    </div>
  );
}

function Message({ mine = false, children }: { mine?: boolean; children: ReactNode }) {
  return <div className={`simp-message ${mine ? "is-mine" : ""}`}>{!mine && <Avatar />}<div>{children}</div></div>;
}

function ApprovalCard({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`simp-approval ${compact ? "is-compact" : ""}`}>
      <div><span>READY FOR YOU</span><h3>Kelvin redline</h3><p>Concise is cleaner. Privacy check passed.</p></div>
      <div><button>Review</button><button className="is-primary">Approve</button></div>
    </section>
  );
}

function Header({ quiet = false }: { quiet?: boolean }) {
  return (
    <header className="simp-header">
      <button className="simp-menu" aria-label="Open menu"><Menu size={20} /></button>
      <button className="simp-agent"><Avatar /><span><strong>Atlas</strong>{!quiet && <small><i /> ready</small>}</span><ChevronDown size={15} /></button>
      <div className="simp-head-actions"><button><Search size={18} /></button><button><Ellipsis size={19} /></button></div>
    </header>
  );
}

function Rail() {
  return (
    <aside className="simp-rail">
      <AgentMark />
      <nav>
        <button className="is-active"><MessageCircle size={20} /><span>Talk</span></button>
        <button><ListTodo size={20} /><span>Work</span><em>2</em></button>
        <button><Bot size={20} /><span>Agents</span></button>
      </nav>
      <button><Settings size={20} /><span>Settings</span></button>
    </aside>
  );
}

function OneConversation() {
  return (
    <div className="simp-shell simp-a">
      <Rail />
      <main className="simp-chat">
        <Header />
        <div className="simp-thread">
          <div className="simp-greeting"><span>WEDNESDAY</span><h1>What are we moving?</h1><p>Two things need you. Everything else is handled.</p></div>
          <Message mine>Get the Kelvin redline ready. Leave the final send with me.</Message>
          <Message>Done. Concise wins—cleaner, verified, and nothing escaped into the wild.</Message>
          <ApprovalCard />
        </div>
        <div className="simp-compose-wrap"><Composer /><p><Command size={12} /> Press Ctrl K for agents, routines, sources, or computer</p></div>
      </main>
      <nav className="simp-mobile-nav"><button className="is-active"><MessageCircle size={20}/><span>Talk</span></button><button><ListTodo size={20}/><span>Work</span><em>2</em></button><button><Menu size={20}/><span>More</span></button></nav>
    </div>
  );
}

function BriefRow({ tone, title, detail }: { tone: string; title: string; detail: string }) {
  return <button className="simp-brief-row"><i className={tone}/><span><strong>{title}</strong><small>{detail}</small></span><ArrowRight size={16}/></button>;
}

function DailyBrief() {
  return (
    <div className="simp-shell simp-b">
      <Rail />
      <main className="simp-brief">
        <Header quiet />
        <div className="simp-brief-body">
          <div className="simp-brief-intro"><span>GOOD MORNING</span><h1>Here’s the whole situation.</h1><p>No dashboard archaeology required.</p></div>
          <section className="simp-needs"><header><h2>Needs you</h2><b>2</b></header><ApprovalCard compact/><BriefRow tone="red" title="Mercury needs a login" detail="Nothing else is blocked"/></section>
          <section className="simp-moving"><header><h2>Moving quietly</h2><button>See all</button></header><BriefRow tone="green" title="Morning capture" detail="9 sources fresh"/><BriefRow tone="blue" title="Product benchmark" detail="3 of 7 scenarios complete"/></section>
          <button className="simp-start-chat"><Sparkles size={18}/><span><strong>Ask Atlas anything</strong><small>Chat, delegate, research, or use the computer</small></span><ArrowRight size={17}/></button>
        </div>
      </main>
      <nav className="simp-mobile-nav"><button className="is-active"><Sparkles size={20}/><span>Today</span></button><button><MessageCircle size={20}/><span>Talk</span></button><button><Menu size={20}/><span>More</span></button></nav>
    </div>
  );
}

function ContextPanel() {
  return (
    <aside className="simp-context">
      <header><div><span>LIVE TASK</span><h2>Kelvin redline</h2></div><button><X size={18}/></button></header>
      <div className="simp-progress"><i style={{width:"75%"}}/></div>
      <ol>
        <li className="is-done"><Check size={14}/><span><strong>Source found</strong><small>Drive · latest version</small></span></li>
        <li className="is-done"><Check size={14}/><span><strong>Draft built</strong><small>Two options compared</small></span></li>
        <li className="is-done"><Check size={14}/><span><strong>Verified</strong><small>Privacy and terms passed</small></span></li>
        <li><Circle size={12}/><span><strong>Waiting for you</strong><small>Nothing has been sent</small></span></li>
      </ol>
      <button className="simp-computer"><Monitor size={17}/><span><strong>View computer</strong><small>Only while a task is active</small></span><ArrowRight size={16}/></button>
    </aside>
  );
}

function ContextDrawer() {
  const [open, setOpen] = useState(true);
  return (
    <div className={`simp-shell simp-c ${open ? "has-context" : ""}`}>
      <Rail />
      <main className="simp-chat">
        <Header />
        <button className="simp-task-chip" onClick={() => setOpen(!open)}><i/> Kelvin redline · waiting <ChevronDown size={14}/></button>
        <div className="simp-thread is-compact-thread">
          <Message mine>Get the Kelvin redline ready. Leave the final send with me.</Message>
          <Message>Ready. Concise wins, the checks passed, and I stopped before send.</Message>
          <ApprovalCard />
        </div>
        <div className="simp-compose-wrap"><Composer /></div>
      </main>
      {open && <ContextPanel />}
      <nav className="simp-mobile-nav"><button className="is-active"><MessageCircle size={20}/><span>Talk</span></button><button onClick={() => setOpen(!open)}><ListTodo size={20}/><span>Task</span><em>1</em></button><button><Menu size={20}/><span>More</span></button></nav>
    </div>
  );
}

function Switcher({ current, onChange }: { current: Variant; onChange: (value: Variant) => void }) {
  const index = variants.findIndex((item) => item.key === current);
  const move = (by: number) => onChange(variants[(index + by + variants.length) % variants.length].key);
  return <div className="simp-switcher"><button onClick={() => move(-1)}>←</button><span><b>{current}</b> {variants[index].name}</span><button onClick={() => move(1)}>→</button></div>;
}

export function CentipedeSimplicityPrototype() {
  const requested = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  const [variant, setVariant] = useState<Variant>(requested === "B" || requested === "C" ? requested : "A");
  const change = (value: Variant) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", value);
    window.history.replaceState({}, "", url);
    setVariant(value);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = variants.findIndex((item) => item.key === variant);
      change(variants[(index + (event.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length].key);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [variant]);
  return <div className="simp-root"><style>{styles}</style>{variant === "A" ? <OneConversation/> : variant === "B" ? <DailyBrief/> : <ContextDrawer/>}<Switcher current={variant} onChange={change}/></div>;
}

const styles = String.raw`
.simp-root{--bg:#f4f5ef;--surface:#fff;--ink:#17201d;--muted:#6e7771;--line:#dfe3dc;--dark:#121916;--acid:#baf444;--blue:#477df2;--red:#df6759;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink);height:100vh;background:var(--bg);overflow:hidden}.simp-root *{box-sizing:border-box}.simp-root button{font:inherit;color:inherit}.simp-shell{height:100%;display:grid;grid-template-columns:76px minmax(0,1fr);background:var(--bg)}.simp-rail{background:var(--dark);padding:21px 10px 14px;display:flex;flex-direction:column;align-items:center;color:#fff}.simp-mark{display:flex;gap:2px;height:22px;align-items:center}.simp-mark i{width:8px;height:13px;border-radius:50%;background:var(--acid);transform:rotate(-16deg)}.simp-mark i:nth-child(2){height:19px}.simp-mark i:nth-child(3){height:16px}.simp-rail nav{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:44px}.simp-rail button{border:0;background:transparent;color:#85918a;border-radius:12px;min-height:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;position:relative;font-size:9px}.simp-rail button.is-active{background:#ffffff10;color:var(--acid)}.simp-rail>button:last-child{margin-top:auto}.simp-rail em,.simp-mobile-nav em{position:absolute;background:var(--acid);color:var(--dark);font-style:normal;font-weight:800;font-size:9px;min-width:16px;height:16px;border-radius:9px;display:grid;place-items:center;top:5px;right:7px}.simp-chat,.simp-brief{min-width:0;display:flex;flex-direction:column;height:100%}.simp-header{height:68px;padding:0 24px;display:flex;align-items:center;border-bottom:1px solid var(--line);background:#f8f9f5cc;backdrop-filter:blur(16px)}.simp-menu{display:none!important}.simp-header button{border:0;background:transparent}.simp-agent{display:flex;align-items:center;gap:10px;padding:4px!important}.simp-agent>span{display:flex;flex-direction:column;align-items:flex-start}.simp-agent strong{font-size:14px}.simp-agent small{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}.simp-agent small i{width:6px;height:6px;border-radius:50%;background:#4db175}.simp-avatar{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:var(--dark);color:var(--acid);font-weight:800}.simp-head-actions{margin-left:auto;display:flex;gap:5px}.simp-head-actions button,.simp-menu{width:38px;height:38px;border-radius:12px;display:grid!important;place-items:center}.simp-head-actions button:hover{background:#e9ece5}.simp-thread{width:min(760px,calc(100% - 40px));margin:auto;padding:34px 0 150px;display:flex;flex-direction:column;gap:20px;overflow:auto}.simp-greeting{margin-bottom:18px}.simp-greeting>span,.simp-brief-intro>span,.simp-approval>div:first-child>span,.simp-context header span{font:700 10px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em;color:var(--muted)}.simp-greeting h1,.simp-brief-intro h1{font-size:36px;line-height:1.1;margin:9px 0}.simp-greeting p,.simp-brief-intro p{color:var(--muted);margin:0}.simp-message{display:flex;gap:10px;align-items:flex-start;max-width:650px}.simp-message>div{padding:13px 16px;border-radius:18px;border:1px solid var(--line);background:var(--surface);font-size:14px;line-height:1.5}.simp-message .simp-avatar{flex:none;padding:0;border:0;border-radius:11px;width:34px;height:34px}.simp-message.is-mine{align-self:flex-end}.simp-message.is-mine>div{background:var(--dark);color:#fff;border-color:var(--dark);border-bottom-right-radius:5px}.simp-approval{margin-left:44px;border:1px solid #cfe3a0;background:#f0f7dd;border-radius:18px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:18px}.simp-approval h3{font-size:15px;margin:5px 0 3px}.simp-approval p{font-size:12px;color:#59635c;margin:0}.simp-approval>div:last-child{display:flex;gap:7px}.simp-approval button{border:1px solid #cad2c4;background:#fff;border-radius:10px;padding:9px 12px;font-size:12px;font-weight:700}.simp-approval button.is-primary{background:var(--dark);border-color:var(--dark);color:#fff}.simp-compose-wrap{position:absolute;z-index:5;bottom:18px;left:calc(76px + (100% - 76px)/2);transform:translateX(-50%);width:min(760px,calc(100% - 116px));background:linear-gradient(transparent,var(--bg) 28%);padding-top:24px}.simp-composer{height:58px;border:1px solid #cfd5cc;background:#fff;border-radius:19px;display:flex;align-items:center;gap:8px;padding:7px 8px 7px 11px;box-shadow:0 12px 32px #111a1512;color:#8a938d}.simp-composer>span{flex:1;font-size:14px}.simp-composer button{border:0;background:transparent;width:38px;height:38px;display:grid;place-items:center;border-radius:12px;color:#707a73}.simp-composer button.is-send{background:var(--dark);color:#fff}.simp-compose-wrap>p{text-align:center;margin:7px 0 0;color:#8a938d;font-size:10px;display:flex;align-items:center;justify-content:center;gap:5px}.simp-mobile-nav{display:none}.simp-brief-body{width:min(720px,calc(100% - 40px));margin:auto;padding:42px 0 100px;overflow:auto}.simp-brief-intro{margin-bottom:32px}.simp-needs,.simp-moving{margin-bottom:24px}.simp-needs>header,.simp-moving>header{display:flex;align-items:center;margin-bottom:10px}.simp-needs h2,.simp-moving h2{font-size:15px;margin:0}.simp-needs header b{margin-left:8px;background:var(--dark);color:#fff;border-radius:10px;padding:2px 7px;font-size:10px}.simp-moving header button{margin-left:auto;border:0;background:transparent;color:var(--muted);font-size:11px}.simp-approval.is-compact{margin:0 0 8px}.simp-brief-row{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:14px 15px;border:1px solid var(--line);background:#fff;margin-bottom:8px;border-radius:15px}.simp-brief-row>i{width:8px;height:8px;border-radius:50%;background:#aaa}.simp-brief-row>i.red{background:var(--red)}.simp-brief-row>i.green{background:#4cae74}.simp-brief-row>i.blue{background:var(--blue)}.simp-brief-row span{display:flex;flex-direction:column;gap:3px;flex:1}.simp-brief-row strong{font-size:13px}.simp-brief-row small{font-size:11px;color:var(--muted)}.simp-start-chat{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:15px;border:1px solid var(--dark);background:var(--dark);color:#fff;border-radius:16px}.simp-start-chat>span{display:flex;flex-direction:column;gap:3px;flex:1}.simp-start-chat small{color:#aeb8b1}.simp-c.has-context{grid-template-columns:76px minmax(480px,1fr) 330px}.simp-c .simp-compose-wrap{left:calc(76px + (100% - 406px)/2);width:min(700px,calc(100% - 446px))}.simp-task-chip{align-self:center;margin-top:18px;border:1px solid var(--line);background:#fff;border-radius:99px;padding:8px 12px;display:flex;align-items:center;gap:7px;font-size:11px}.simp-task-chip i{width:7px;height:7px;border-radius:50%;background:#e2a333}.is-compact-thread{margin-top:0;padding-top:28px}.simp-context{border-left:1px solid var(--line);background:#fafbf8;padding:24px 20px;overflow:auto}.simp-context header{display:flex;align-items:flex-start}.simp-context h2{font-size:18px;margin:7px 0 0}.simp-context header button{margin-left:auto;border:0;background:transparent;width:34px;height:34px;border-radius:10px}.simp-progress{height:5px;background:#e4e7df;border-radius:4px;margin:24px 0}.simp-progress i{display:block;height:100%;background:var(--acid);border-radius:4px}.simp-context ol{list-style:none;padding:0;margin:0;display:flex;flex-direction:column}.simp-context li{display:flex;gap:11px;padding:11px 0;color:#8b938e}.simp-context li.is-done{color:var(--ink)}.simp-context li>span{display:flex;flex-direction:column;gap:3px}.simp-context li strong{font-size:12px}.simp-context li small{font-size:10px;color:var(--muted)}.simp-computer{margin-top:20px;width:100%;display:flex;align-items:center;gap:10px;text-align:left;border:1px solid var(--line);background:#fff;border-radius:14px;padding:12px}.simp-computer>span{flex:1;display:flex;flex-direction:column;gap:3px}.simp-computer strong{font-size:12px}.simp-computer small{font-size:9px;color:var(--muted)}.simp-switcher{position:fixed;z-index:1000;bottom:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;background:#111714;color:#fff;padding:5px;border-radius:99px;box-shadow:0 12px 36px #0005}.simp-switcher button{border:0;background:#ffffff12;color:#fff;width:32px;height:32px;border-radius:50%}.simp-switcher span{min-width:190px;text-align:center;font-size:11px}.simp-switcher b{color:var(--acid);margin-right:4px}
.simp-root .simp-start-chat{color:#fff}
@media(max-width:720px){.simp-shell,.simp-c.has-context{display:flex;flex-direction:column}.simp-rail{display:none}.simp-header{height:62px;padding:0 12px}.simp-menu{display:grid!important}.simp-head-actions button:first-child{display:none!important}.simp-thread{width:auto;margin:0;padding:28px 14px 180px}.simp-greeting h1,.simp-brief-intro h1{font-size:27px}.simp-message{max-width:92%}.simp-approval,.simp-approval.is-compact{margin-left:0;align-items:flex-start;flex-direction:column}.simp-approval>div:last-child{width:100%}.simp-approval button{flex:1}.simp-compose-wrap,.simp-c .simp-compose-wrap{left:12px;right:12px;bottom:64px;transform:none;width:auto}.simp-compose-wrap>p{display:none}.simp-mobile-nav{position:fixed;z-index:6;display:flex;left:0;right:0;bottom:0;height:62px;background:#f8f9f5e8;backdrop-filter:blur(18px);border-top:1px solid var(--line);padding:4px 18px}.simp-mobile-nav button{position:relative;flex:1;border:0;background:transparent;color:#7d867f;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;font-size:9px}.simp-mobile-nav button.is-active{color:var(--ink)}.simp-mobile-nav em{right:25%;top:1px}.simp-brief-body{width:auto;margin:0;padding:28px 14px 110px}.simp-brief-intro{margin-bottom:26px}.simp-start-chat{margin-top:26px}.simp-context{position:fixed;z-index:20;left:8px;right:8px;bottom:70px;max-height:66vh;border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 60px #0003}.simp-c.has-context:after{content:'';position:fixed;z-index:19;inset:0;background:#1118}.simp-task-chip{margin-top:12px}.is-compact-thread{padding-top:22px}.simp-switcher{bottom:70px}.simp-switcher span{min-width:154px}}
`;
