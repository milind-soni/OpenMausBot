import {
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  Laptop,
  Menu,
  Play,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { CentipedeMark } from "@/components/CentipedeBrand";
import "./agent-centipede-landing.css";

const releaseUrl = "https://github.com/milind-soni/openmausbot-releases/releases/latest";

function Brand() {
  return (
    <a className="acp-brand" href="#top" aria-label="Agent Centipede home">
      <span className="acp-brand-mark"><CentipedeMark className="acp-brand-svg" /></span>
      <span><strong>Agent Centipede</strong><small>local-first agent harness</small></span>
    </a>
  );
}

function StatusDot({ tone = "acid" }: { tone?: "acid" | "blue" | "amber" }) {
  return <i className={"acp-status-dot acp-status-" + tone} aria-hidden="true" />;
}

function MissionPreview() {
  return (
    <div className="acp-window" aria-label="Agent Centipede mission preview">
      <div className="acp-window-bar">
        <span className="acp-window-lights"><i /><i /><i /></span>
        <span className="acp-window-path">SAMPLE RUN / 014 / CLIENT REDLINE</span>
        <span className="acp-window-ready"><StatusDot /> ready</span>
      </div>
      <div className="acp-window-body">
        <aside className="acp-mini-rail">
          <span className="acp-mini-mark"><i /><i /><i /></span>
          <span className="acp-mini-rail-item is-active" /><span className="acp-mini-rail-item" /><span className="acp-mini-rail-item" /><span className="acp-mini-rail-item" />
        </aside>
        <div className="acp-mission-main">
          <div className="acp-mission-heading">
            <div><span className="acp-micro">OUTCOME IN MOTION</span><h3>Prepare the Kelvin redline</h3></div>
            <span className="acp-pill acp-pill-acid"><StatusDot /> 3 of 4</span>
          </div>
          <p className="acp-mission-request">Research the latest terms, draft the response, scan for private context, and stop before send.</p>
          <div className="acp-mission-line">
            <div className="acp-node is-done"><span><Check size={13} /></span><small>source</small></div>
            <div className="acp-node is-done"><span><Check size={13} /></span><small>draft</small></div>
            <div className="acp-node is-done"><span><Check size={13} /></span><small>verify</small></div>
            <div className="acp-node is-waiting"><span><ShieldCheck size={13} /></span><small>your call</small></div>
          </div>
          <div className="acp-receipt">
            <div className="acp-receipt-icon"><ShieldCheck size={17} /></div>
            <div><strong>Verified, not merely reported</strong><small>4 evidence items · nothing sent</small></div>
            <ArrowRight size={15} />
          </div>
        </div>
        <aside className="acp-mission-side">
          <span className="acp-micro">THE CREW</span>
          <div className="acp-crew-row"><span className="acp-crew-avatar is-acid">A</span><span><b>Atlas</b><small>research · active</small></span><StatusDot /></div>
          <div className="acp-crew-row"><span className="acp-crew-avatar is-blue">C</span><span><b>Compiler</b><small>drafting · active</small></span><StatusDot tone="blue" /></div>
          <div className="acp-crew-row"><span className="acp-crew-avatar is-amber">V</span><span><b>Verifier</b><small>checks · done</small></span><StatusDot tone="amber" /></div>
          <div className="acp-side-rule" />
          <span className="acp-micro">SYSTEM</span>
          <div className="acp-system-stat"><span>sources fresh</span><b>11 / 12</b></div>
          <div className="acp-system-stat"><span>response</span><b>1.8s</b></div>
        </aside>
      </div>
    </div>
  );
}

function FeatureCard({ icon: Icon, eyebrow, title, children, className = "" }: { icon: typeof Laptop; eyebrow: string; title: string; children: string; className?: string }) {
  return (
    <article className={"acp-feature-card " + className}>
      <span className="acp-feature-icon"><Icon size={19} /></span>
      <span className="acp-micro">{eyebrow}</span><h3>{title}</h3><p>{children}</p>
      <span className="acp-feature-arrow"><ArrowRight size={16} /></span>
    </article>
  );
}

function FAQ({ question, children }: { question: string; children: string }) {
  return <details className="acp-faq"><summary>{question}<ChevronDown size={16} /></summary><p>{children}</p></details>;
}

export function AgentCentipedeLandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return (
    <div className="acp-page" id="top">
      <header className="acp-nav-wrap">
        <nav className="acp-nav acp-container" aria-label="Primary navigation">
          <Brand />
          <button className="acp-menu-button" type="button" aria-expanded={menuOpen} aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          <div className={"acp-nav-links " + (menuOpen ? "is-open" : "")}>
            <a href="#why" onClick={closeMenu}>Why Centipede</a><a href="#how" onClick={closeMenu}>How it works</a><a href="#controls" onClick={closeMenu}>Controls</a><a href="#faq" onClick={closeMenu}>FAQ</a>
            <a className="acp-nav-cta" href={releaseUrl} target="_blank" rel="noreferrer" onClick={closeMenu}>Download desktop app <ArrowRight size={15} /></a>
          </div>
        </nav>
      </header>

      <main>
        <section className="acp-hero acp-container">
          <div className="acp-hero-copy">
            <div className="acp-eyebrow"><StatusDot /> LOCAL-FIRST · END-TO-END · WITH RECEIPTS</div>
            <h1>Give your agents a computer. <em>Keep the final call.</em></h1>
            <p className="acp-hero-lede">Agent Centipede is the desktop control plane for AI work that has to actually move — across models, apps, browsers, and computers.</p>
            <div className="acp-hero-actions">
              <a className="acp-button acp-button-primary" href={releaseUrl} target="_blank" rel="noreferrer"><Download size={17} /> Download desktop app <ArrowRight size={16} /></a>
              <a className="acp-button acp-button-quiet" href="#demo"><span className="acp-play"><Play size={12} fill="currentColor" /></span> See the demo</a>
            </div>
            <p className="acp-hero-note"><Check size={14} /> Available for Windows, macOS, and Linux · Human-in-the-loop, unfortunately · <a href="#controls">See the boundaries</a></p>
          </div>
          <div className="acp-hero-art"><div className="acp-art-stamp">A / C<br /><small>CONTROL<br />PLANE</small></div><MissionPreview /><span className="acp-art-caption">FIG. 01 / A MISSION WITH A PAPER TRAIL</span></div>
        </section>

        <section className="acp-proof-strip acp-container" aria-label="Product qualities">
          <span className="acp-proof-lead">For work that cannot end at “I drafted that.” The paperwork has legs now.</span>
          <span><GitBranch size={16} /> any agent topology</span><span><ShieldCheck size={16} /> approval boundaries</span><span><Sparkles size={16} /> evidence of completion</span>
        </section>

        <section className="acp-section acp-container" id="why">
          <div className="acp-section-intro"><span className="acp-micro">THE PROBLEM</span><h2>Chat is a great room. Work needs a building.</h2><p>Most assistants can make a convincing start. Centipede gives the work somewhere to live, a way to move, and a clear place to stop. No ritual tab babysitting required.</p></div>
          <div className="acp-feature-grid">
            <FeatureCard icon={GitBranch} eyebrow="01 · YOUR SETUP" title="Compose the crew that fits." className="acp-feature-lime">One agent, independent agents, a coordinator, peers, background operators, temporary workers — or a combination you invent.</FeatureCard>
            <FeatureCard icon={Laptop} eyebrow="02 · REAL EXECUTION" title="Let it use the computer." className="acp-feature-blue">Browser, code, connected apps, and desktop work share one mission instead of becoming four disconnected tabs.</FeatureCard>
            <FeatureCard icon={ShieldCheck} eyebrow="03 · SAFE HANDOFFS" title="Know what happened." className="acp-feature-dark">Permissions, checkpoints, recovery, and receipts make “done” something you can inspect — not a vibe.</FeatureCard>
          </div>
        </section>

        <section className="acp-demo-section" id="demo">
          <div className="acp-container acp-demo-grid">
            <div className="acp-demo-copy"><span className="acp-micro">THE LOOP</span><h2>It moves while you are away. It asks when it matters.</h2><p>Give a mission an outcome and a boundary. Centipede carries the research, browser work, code, and checks across the finish line — then puts the consequential choice back in your hands. No browser-tab séance required.</p><a href="#how" className="acp-text-link">See how a mission moves <ArrowRight size={15} /></a></div>
            <div className="acp-loop-card"><div className="acp-loop-line" aria-hidden="true" />{["Understand the request", "Build the work", "Verify the result", "Bring you the decision"].map((step, index) => <div className={"acp-loop-step " + (index < 3 ? "is-done" : "is-current")} key={step}><span>{index < 3 ? <Check size={13} /> : <ShieldCheck size={13} />}</span><div><b>{step}</b><small>{["Sources + mission context", "Browser + code + computer", "Tests + evidence ledger", "Nothing external happens yet"][index]}</small></div><em>{index < 3 ? "done" : "your call"}</em></div>)}</div>
          </div>
        </section>

        <section className="acp-section acp-container" id="how">
          <div className="acp-section-intro acp-section-intro-centered"><span className="acp-micro">START SMALL · GROW SIDEWAYS</span><h2>From one useful agent to the whole situation.</h2><p>There is no mandatory org chart. Pick a starting point, then keep only the legs that earn their keep. Evolution, but with settings.</p></div>
          <div className="acp-steps-grid"><article><span className="acp-step-number">01</span><h3>Connect what matters</h3><p>Bring your models, sources, routines, browser sessions, and local computer into one visible workspace.</p></article><article><span className="acp-step-number">02</span><h3>Describe the outcome</h3><p>Ask for the result, the constraints, and the decisions that should stay yours.</p></article><article><span className="acp-step-number">03</span><h3>Return to proof</h3><p>Come back to a verified result — or one precise blocker with the evidence to fix it.</p></article></div>
        </section>

        <section className="acp-control-section" id="controls">
          <div className="acp-container acp-control-grid">
            <div><span className="acp-micro">CONTROL, WITHOUT BABYSITTING</span><h2>Local-first means your computer stays in the loop.</h2><p>The desktop app owns your setup, credentials, routines, and execution state. Consequential actions pause at an explicit approval boundary. The Android companion lets you inspect, steer, and answer from somewhere else. You remain a required dependency. Tragic, but safer.</p><div className="acp-control-list"><span><Check size={15} /> scoped permissions</span><span><Check size={15} /> recovery when tools fail</span><span><Check size={15} /> mobile approvals</span><span><Check size={15} /> model choice stays yours</span></div></div>
            <div className="acp-device-stack"><div className="acp-phone"><div className="acp-phone-top" /><span className="acp-micro">YOUR CALL</span><h3>Send the concise redline?</h3><p>Privacy scan passed. 4 evidence items attached. Nothing has been sent.</p><button>Approve send <ArrowRight size={14} /></button><small><ShieldCheck size={12} /> biometric approval available</small></div><div className="acp-desktop-card"><Laptop size={18} /><span><b>Desktop control plane</b><small>Source of truth · online</small></span><StatusDot /></div><div className="acp-mobile-card"><Smartphone size={17} /><span><b>Android companion</b><small>Steer from anywhere</small></span><StatusDot tone="blue" /></div></div>
          </div>
        </section>

        <section className="acp-section acp-container" id="faq">
          <div className="acp-faq-grid"><div className="acp-section-intro"><span className="acp-micro">A FEW HONEST ANSWERS</span><h2>It has too many legs. That is the point.</h2><p>Start with the shape of work you already have. The harness supplies the durable parts.</p></div><div><FAQ question="Is this another chatbot?">It can chat, but the useful distinction is execution. Centipede is a local-first harness for missions that span context, tools, computers, approvals, and evidence.</FAQ><FAQ question="Why a centipede?">One agent with one tool is a chatbot. A coordinated crew has more legs. No humans are stitched together during onboarding.</FAQ><FAQ question="Do I have to use a preset team?">No. Presets are editable starting points. Run one agent, a few independent agents, a coordinator, or your own topology.</FAQ><FAQ question="Will it act without asking me?">You decide the boundary. The product is designed to pause before consequential external actions and show you what is ready.</FAQ><FAQ question="Where does my information live?">The desktop app is the local source of truth for your setup and execution state. Review the app’s connection and permission settings before adding sensitive sources.</FAQ></div></div>
        </section>

        <section className="acp-final acp-container"><div><span className="acp-eyebrow"><StatusDot /> READY WHEN YOU ARE</span><h2>Stop collecting assistants. Start moving work.</h2><p>Download the desktop app. Give the next outcome somewhere to go. The chain of command can finally have knees.</p></div><a className="acp-button acp-button-primary" href={releaseUrl} target="_blank" rel="noreferrer"><Download size={17} /> Download desktop app <ArrowRight size={16} /></a></section>
      </main>
      <footer className="acp-footer acp-container"><Brand /><span>Apache-2.0 open-source core · Agent Centipede is in active development.</span><a href={releaseUrl} target="_blank" rel="noreferrer">Releases <ArrowRight size={14} /></a></footer>
    </div>
  );
}
