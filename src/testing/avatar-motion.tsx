import { useEffect, useRef, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { BotAvatar, MausAvatar, type MausAvatarHandle, type MausAvatarProps } from "../components/Avatar";
import { MASCOT_BODIES, MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";
import { MAUS_COLORS, MAUS_COLOR_NAMES, MAUS_MOTIONS, PICKABLE_STATES, stateForBot, type MascotBotProfile, type MausColor, type MausMotion, type MausState } from "../lib/mascot";
import { applySkin } from "../lib/skins";
import { StoreProvider, useStore, type Bot } from "../state/store";
import "../styles.css";

type Check = { name: string; status: "passed" | "failed" | "skipped"; detail: string };
type Probe = Partial<MausAvatarProps> & { mount: number };
type TaskBot = MascotBotProfile & {
  color: MausColor;
  mascotBody: MascotBodyId;
  activity: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
};
const TASK_STEPS: { label: string; expected: MausState; patch: Partial<TaskBot> }[] = [
  { label: "Resting", expected: "sleeping", patch: {} },
  { label: "Thinking", expected: "thinking", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
  { label: "Tool running", expected: "working", patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: {} }] } },
  { label: "Reasoning after tool", expected: "thinking", patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: { ok: true } }] } },
  { label: "Waiting on you", expected: "curious", patch: { busy: true, activity: "waiting-on-you", messages: [{ kind: "activity", tool: {} }] } },
  { label: "Tool resumed", expected: "working", patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: {} }] } },
  { label: "Unread completion", expected: "notifying", patch: { unread: true, messages: [{ kind: "text" }] } },
  { label: "Read; resting again", expected: "sleeping", patch: {} },
  { label: "Tool error", expected: "alerting", patch: { messages: [{ kind: "activity", tool: { ok: false } }] } },
  { label: "Canceled", expected: "sleeping", patch: {} },
  { label: "Retry", expected: "thinking", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
  { label: "Signal lost", expected: "confused", patch: { busy: true, activity: "no-signal", messages: [{ kind: "activity", tool: {} }] } },
  { label: "Process stopped", expected: "sad", patch: { activity: "dead" } },
  { label: "New turn", expected: "thinking", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
];
const taskBotAt = (step: number): TaskBot => ({
  name: "Fixture Scout", color: "blue", mascotBody: "hexagon", mascotExpression: "sleeping",
  busy: false, unread: false, activity: "idle", messages: [], ...TASK_STEPS[step].patch,
});
const STORE_BOT: Bot = {
  id: "fixture-avatar-expiry", threadId: "fixture-avatar-expiry-thread",
  name: "Expiry Scout", title: "Expiry Scout", description: "Synthetic renderer fixture",
  notifications: false, color: "blue", unread: false, busy: false, activity: "idle",
  mascotExpression: "sleeping", mascotBody: "hexagon", messages: [],
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
};

function StoreMotionProbe({ storeRef, avatarKey }: {
  storeRef: RefObject<ReturnType<typeof useStore> | null>; avatarKey: number;
}) {
  const store = useStore();
  storeRef.current = store;
  const bot = store.state.bots.find(candidate => candidate.id === STORE_BOT.id);
  const event = store.state.mascotMotion;
  return <>
    {bot && <BotAvatar key={avatarKey} bot={bot} state={stateForBot(bot)}
      motion={event?.botId === bot.id ? event.kind : "none"} motionKey={event?.nonce} size={56} />}
    <pre className="text-xs" data-testid="store-motion-state">{JSON.stringify({
      connected: store.state.connected, fixtureBotPresent: Boolean(bot), mascotMotion: event,
    }, null, 2)}</pre>
  </>;
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function frames(count = 3) { for (let i = 0; i < count; i++) await frame(); }
async function elapsed(ms: number) {
  const start = performance.now();
  do { await frame(); } while (performance.now() - start < ms);
}
function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireVisibleEyesInside(node: HTMLElement | null) {
  const svg = node?.querySelector("svg");
  const morph = svg?.querySelector<SVGPathElement>("[data-avatar-body]");
  const outline = svg?.getAttribute("data-avatar-morphing") === "true" ? morph
    : morph?.previousElementSibling?.querySelector<SVGPathElement>("path");
  requireCheck(outline && outline.getCTM(), "The rendered body must expose its outline.");
  const inverse = outline.getCTM()!.inverse();
  for (const eye of svg!.querySelectorAll<SVGPathElement>("[data-avatar-eye]")) {
    if (eye.style.opacity === "0") continue; // Eyes on the back of a turn are intentionally hidden.
    const matrix = inverse.multiply(eye.getCTM()!);
    const length = eye.getTotalLength();
    for (let index = 0; index < 32; index++) {
      const point = eye.getPointAtLength(length * index / 32);
      const fitted = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      requireCheck(outline.isPointInFill(fitted), `Visible eye ${eye.dataset.avatarEye} is clipped by the ${svg!.dataset.avatarShape} outline.`);
    }
  }
}

// Used only while the simulated-preference check mounts its disposable probe.
// Existing gallery avatars remain subscribed to the browser's real media query.
class SimulatedMotionPreference extends EventTarget implements MediaQueryList {
  readonly media = "(prefers-reduced-motion: reduce)";
  matches = false;
  onchange: MediaQueryList["onchange"] = null;
  addListener(listener: MediaQueryList["onchange"]) {
    if (listener) this.addEventListener("change", listener as EventListener);
  }
  removeListener(listener: MediaQueryList["onchange"]) {
    if (listener) this.removeEventListener("change", listener as EventListener);
  }
  change(matches: boolean) {
    this.matches = matches;
    const event = new MediaQueryListEvent("change", { media: this.media, matches });
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
  }
}

function Fixture() {
  const [color, setColor] = useState<MausColor>("green");
  const [state, setState] = useState<MausState>();
  const [body, setBody] = useState<MascotBodyId>();
  const [paused, setPaused] = useState(false);
  const [motion, setMotion] = useState<MausMotion>("none");
  const [motionKey, setMotionKey] = useState(0);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [probe, setProbe] = useState<Probe>({ mount: 0, animated: false });
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [taskStep, setTaskStep] = useState(0);
  const [taskPaused, setTaskPaused] = useState(false);
  const taskNode = useRef<HTMLDivElement>(null);
  const storeNode = useRef<HTMLDivElement>(null);
  const storeRef = useRef<ReturnType<typeof useStore> | null>(null);
  const [storeAvatarKey, setStoreAvatarKey] = useState(0);
  const probeNode = useRef<HTMLDivElement>(null);
  const probeHandle = useRef<MausAvatarHandle>(null);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const sample = (node = probeNode.current) => {
    const svg = node?.querySelector("svg");
    const eyes = [...(svg?.querySelectorAll("[data-avatar-eye]") ?? [])];
    requireCheck(svg && eyes.length === 2, "The real avatar must expose two instrumented eyes.");
    const movement = svg.querySelector("[data-avatar-motion]");
    const effectPaths = [...(movement?.parentElement?.children ?? [])]
      .filter(layer => layer !== movement)
      .reduce((count, layer) => count + layer.querySelectorAll("path").length, 0);
    return {
      state: svg.getAttribute("data-avatar-state"),
      shape: svg.getAttribute("data-avatar-shape"),
      morphing: svg.getAttribute("data-avatar-morphing"),
      eyes: eyes.map(eye => eye.getAttribute("d")).join("|"),
      gaze: eyes.map(eye => eye.getAttribute("transform")).join("|"),
      body: svg.querySelector("[data-avatar-body]")?.getAttribute("d"),
      clip: svg.querySelector("[data-avatar-clip]")?.getAttribute("d"),
      movement: movement?.getAttribute("transform"),
      effectPaths,
    };
  };
  const put = async (props: Partial<MausAvatarProps>, remount = false) => {
    setProbe(previous => ({ ...props, mount: previous.mount + Number(remount) }));
    await frames();
  };
  const runChecks = async () => {
    setRunning(true);
    setChecks([]);
    const results: Check[] = [];
    const check = async (name: string, action: () => Promise<string>, skip = false) => {
      try {
        results.push(skip
          ? { name, status: "skipped", detail: "Requires browser reduced-motion emulation in the opposite setting." }
          : { name, status: "passed", detail: await action() });
      } catch (error) {
        results.push({ name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      }
      setChecks([...results]);
    };
    try {
      await check("Static expression picker", async () => {
        const signatures = [];
        for (const candidate of PICKABLE_STATES) {
          await put({ state: candidate, animated: false });
          const face = sample();
          requireCheck(face.eyes.length > 20 && !/NaN|Infinity/.test(face.eyes), `${candidate} has no valid face.`);
          signatures.push(face.eyes);
        }
        requireCheck(new Set(signatures).size === PICKABLE_STATES.length, "Different expression options show the same static face.");
        return `${signatures.length} selectable expressions paint distinct eyes.`;
      });
      await check("Paused props and gaze", async () => {
        await put({ state: "sleeping", animated: false, gaze: { x: 0, y: 0 } });
        const before = sample();
        await put({ state: "surprised", animated: false, gaze: { x: 1, y: -1 } });
        const after = sample();
        requireCheck(before.eyes !== after.eyes && before.gaze !== after.gaze, "Paused expression/gaze did not repaint.");
        await elapsed(650);
        const parked = sample();
        requireCheck(after.eyes === parked.eyes && after.gaze === parked.gaze && !parked.movement, "Paused avatar kept moving.");
        return "Changed face and gaze repaint, then remain still.";
      });
      await check("Body and clipping morph together", async () => {
        await put({ bodyId: "circle", animated: true, state: "idle" }, true);
        await put({ bodyId: "star", animated: true, state: "idle" });
        const during = sample();
        requireCheck(during.morphing === "true" && during.body && during.body === during.clip, "No synchronized body/clip transition was observed.");
        await frames(4);
        const advancing = sample();
        requireCheck(advancing.body !== during.body && advancing.body === advancing.clip, "The intermediate contour did not advance with its clip.");
        await elapsed(2200);
        const after = sample();
        requireCheck(after.shape === "star" && after.morphing === "false", "The transition did not settle on the chosen shape.");
        return "Intermediate outline and clip match; shape settles on Star.";
      }, reduced);
      await check("Rapid shape changes and pause", async () => {
        await put({ bodyId: "circle", animated: true, state: "idle" }, true);
        for (const bodyId of ["star", "pill", "cloud", "wedge"] as const) {
          await put({ bodyId, animated: true, state: "idle" });
          const during = sample();
          requireCheck(during.body && during.body === during.clip && !/NaN|Infinity/.test(during.body), "Retargeting broke the outline or its clip.");
        }
        await put({ bodyId: "hexagon", animated: false, state: "idle" });
        requireCheck(sample().shape === "hexagon" && sample().morphing === "false", "Pausing did not settle on the requested shape.");
        await put({ bodyId: "cloud", animated: false, state: "sleeping" });
        requireCheck(sample().shape === "cloud" && sample().morphing === "false", "A parked avatar ignored a new shape.");
        await put({ bodyId: "pill", animated: true, state: "idle" });
        requireCheck(sample().morphing === "true", "Resuming skipped the next shape transition.");
        await elapsed(1200);
        requireCheck(sample().shape === "pill" && sample().morphing === "false", "Resumed transition failed to settle.");
        return "Rapid destinations retain valid outlines; pause, parked shape changes and resume settle correctly.";
      }, reduced);
      await check("Cursor keeps visible eyes inside its silhouette", async () => {
        for (const state of ["idle", "working", "thinking", "curious"] as const) {
          for (const turn of [0, 45, 75, 285, 315, 345]) {
            for (const gaze of [{ x: 0, y: 0 }, { x: -1, y: 1 }, { x: 1, y: -1 }]) {
              await put({ bodyId: "cursor", state, turn, gaze, forward: false, lookAround: 1, animated: false });
              try { requireVisibleEyesInside(probeNode.current); }
              catch (error) { throw new Error(`${state}, turn ${turn}, gaze ${gaze.x}/${gaze.y}: ${String(error)}`); }
            }
          }
        }
        return "Visible eye contours stay inside Cursor across task expressions, side turns and gaze extremes; intentional back-face hiding is preserved.";
      });
      await check("Appearance survives task, color and pause updates", async () => {
        await put({ bodyId: "hexagon", animated: false }, true);
        for (const props of [
          { bodyId: "cursor", state: "idle", animated: false },
          { bodyId: "cursor", state: "working", animated: false, color: "blue" },
          { bodyId: "cursor", state: "thinking", animated: true, color: "red" },
          { bodyId: "cursor", state: "curious", animated: false, color: "red" },
        ] as const) {
          await put(props);
          const svg = probeNode.current!.querySelector("svg")!;
          const artwork = svg.querySelector("[data-avatar-body]")!.previousElementSibling!;
          const clip = svg.querySelector("clipPath")!;
          const expected = MASCOT_BODIES.cursor.clip.match(/ d="([^"]+)"/)![1];
          requireCheck(artwork.querySelector("path")?.getAttribute("d") === expected &&
            clip.querySelector("path")?.getAttribute("d") === expected,
          "A React update restored the initial shape's artwork or clip.");
          requireVisibleEyesInside(probeNode.current);
        }
        return "Cursor artwork, clip and face stay synchronized after a Hexagon mount, task/color changes and pause/resume.";
      });
      await check("Cancel a transient motion", async () => {
        await put({ state: "idle", motion: "failure", motionKey: 1, animated: true }, true);
        requireCheck(sample().state === "sad", "Failure did not borrow the reaction state.");
        await put({ state: "idle", motion: "none", animated: true });
        requireCheck(sample().state === "idle", "Canceled motion left the reaction state pinned.");
        return "Cancel before timeout restores the habitual state.";
      }, reduced);
      await check("Late-mounted entrance", async () => {
        await elapsed(900);
        await put({ state: "spawning", animated: true }, true);
        const start = sample().movement;
        const scales = [...(start?.matchAll(/scale\(([\d.-]+)\)/g) ?? [])].map(match => Number(match[1]));
        requireCheck(scales.some(scale => scale > 0 && scale < 0.5), "Entrance was skipped when mounted after page startup.");
        await elapsed(950);
        requireCheck(sample().movement !== start, "Entrance did not advance from its initial scale.");
        return "A newly mounted avatar starts its own entrance clock.";
      }, reduced);
      await check("Synthetic task lifecycle and rapid transitions", async () => {
        setTaskPaused(false);
        const visited: string[] = [];
        for (let round = 0; round < 2; round++) {
          for (let index = 0; index < TASK_STEPS.length; index++) {
            const step = TASK_STEPS[index];
            const selected = stateForBot(taskBotAt(index));
            requireCheck(selected === step.expected, `${step.label}: expected ${step.expected}, selected ${selected}.`);
            setTaskStep(index);
            await frames();
            const actual = sample(taskNode.current);
            requireCheck(actual.state === step.expected, `${step.label}: renderer is stuck in ${actual.state}.`);
            requireCheck(actual.shape === "hexagon" && actual.morphing === "false", `${step.label}: the bot lost its chosen shape.`);
            requireCheck(!/NaN|Infinity/.test(JSON.stringify(actual)), `${step.label}: rapid transition produced invalid geometry.`);
            if (round === 0) visited.push(actual.state);
          }
        }
        return `Two rapid cycles preserve Hexagon identity and finite geometry: ${visited.join(" → ")}.`;
      });
      await check("Working persists for six seconds", async () => {
        setTaskPaused(false);
        setTaskStep(2);
        await frames();
        const movements = new Set<string | null | undefined>();
        const start = performance.now();
        let samples = 0;
        do {
          const actual = sample(taskNode.current);
          requireCheck(actual.state === "working" && actual.shape === "hexagon", "A running tool fell back to a resting state or changed identity.");
          requireCheck(!/NaN|Infinity/.test(JSON.stringify(actual)), "Long-running work produced invalid geometry.");
          movements.add(actual.movement);
          samples++;
          await elapsed(100);
        } while (performance.now() - start < 6000);
        requireCheck(movements.size > 5, "Working stopped animating before the tool finished.");
        return `${samples} samples over at least six seconds remain working with ongoing motion and fixed Hexagon identity.`;
      }, reduced);
      await check("Explicit pause parks an active task", async () => {
        setTaskStep(2);
        setTaskPaused(true);
        await frames();
        const parked = sample(taskNode.current);
        let mutations = 0;
        const observer = new MutationObserver(records => { mutations += records.length; });
        observer.observe(taskNode.current!, { attributes: true, childList: true, subtree: true });
        try {
          await elapsed(650);
          const after = sample(taskNode.current);
          requireCheck(after.state === "working" && after.shape === "hexagon", "Pause discarded task state or bot identity.");
          requireCheck(!after.movement && after.effectPaths === 0 && after.eyes === parked.eyes && mutations === 0, "animated=false left task animation or scheduled repaints active.");
          return "Pausing preserves working state and identity, removes motion/effects and produces no DOM mutations.";
        } finally {
          observer.disconnect();
        }
      });
      await check("New task state preempts a transient reaction", async () => {
        for (const beat of ["success", "customize"] as const) {
          const start = performance.now();
          const resting = stateForBot(taskBotAt(0));
          await put({ state: resting, bodyId: "hexagon", motion: beat, motionKey: 1, animated: true }, true);
          requireCheck(sample().state !== resting, `${beat} never started its reaction.`);
          const active = stateForBot(taskBotAt(beat === "success" ? 1 : 2));
          await put({ state: active, bodyId: "hexagon", motion: beat, motionKey: 1, animated: true });
          requireCheck(performance.now() - start < 1400, "The test missed the reaction interruption window.");
          requireCheck(sample().state === active, `${beat} masked the new ${active} task state.`);
          await elapsed(1500);
          requireCheck(sample().state === active && sample().shape === "hexagon", "An old reaction timeout restored stale state or identity.");
        }
        return "New thinking/working state interrupts success/customize before 1.4s and survives the old timeout.";
      }, reduced);
      await check("Terminal reaction keeps its original deadline", async () => {
        const started = performance.now();
        await put({ state: "working", busy: true, motion: "celebrate", motionKey: 41, animated: true }, true);
        requireCheck(sample().state === "celebrate", "Completion reaction did not start.");
        await elapsed(600);
        await put({ state: "curious", busy: false, motion: "celebrate", motionKey: 41, animated: true });
        requireCheck(sample().state === "celebrate", "Final resting snapshot erased the completion reaction.");
        await elapsed(Math.max(0, 1550 - (performance.now() - started)));
        requireCheck(sample().state === "curious", "The resting snapshot restarted the reaction deadline.");

        await put({ state: "working", motion: "celebrate", motionKey: 42, animated: true });
        requireCheck(sample().state === "celebrate", "A new completion event was ignored.");
        await put({ state: "sleeping", motion: "none", motionKey: 42, animated: true });
        requireCheck(sample().state === "sleeping", "Canceling with motion=none left a completion reaction active.");

        await put({ state: "working", motion: "celebrate", motionKey: 43, animated: true });
        await put({ state: "working", motion: "celebrate", motionKey: 43, animated: false });
        requireCheck(sample().state === "working" && !sample().movement, "Pausing did not cancel the current reaction.");
        await put({ state: "working", motion: "celebrate", motionKey: 43, animated: true });
        requireCheck(sample().state === "working", "Resuming replayed an already canceled event key.");
        return "Completion survives the final idle snapshot without extending its deadline; none cancels; pause/resume does not replay the same key.";
      }, reduced);
      await check("Selecting a bot preserves existing attention", async () => {
        for (const activity of ["waiting-on-you", "no-signal", "dead"] as const) {
          const busy = activity !== "dead";
          const expected = stateForBot({ name: "Attention probe", activity, busy });
          const props = { state: expected, activity, busy, motion: "switch" as const, motionKey: 61, animated: true };
          await put(props, true);
          const first = sample();
          requireCheck(first.state === expected, `Selecting a ${activity} bot covered ${expected} with a reaction.`);
          await elapsed(100);
          requireCheck(sample().gaze === first.gaze, `Selecting a ${activity} bot started a head spin.`);
          await put({ ...props, motion: "customize", motionKey: 62 });
          requireCheck(sample().state === expected, `A new customize beat covered ${activity}.`);
          await put({ ...props, activity: "idle", busy: false, motion: "customize", motionKey: 62 });
          requireCheck(sample().state === expected, "Resolving attention replayed a canceled event.");
        }
        await put({ state: "curious", activity: "idle", busy: false, motion: "switch", motionKey: 63, animated: true }, true);
        requireCheck(sample().state === "waking", "A resting curious expression was mistaken for approval state.");
        return "New selection/customization beats cannot cover attention or spin the head; a curious resting identity still accepts selection motion.";
      }, reduced);
      await check("StoreProvider expires events before avatar remount", async () => {
        const readyBy = performance.now() + 5000;
        while (!storeRef.current?.state.config && performance.now() < readyBy) await frames();
        requireCheck(storeRef.current?.state.config, "The isolated StoreProvider did not load fixture configuration.");
        // These two actions are local event folds. markUnread/select would make
        // HTTP writes, so they deliberately are not used to prepare this probe.
        storeRef.current.dispatch({ type: "botPatched", bot: STORE_BOT });
        await frames();
        requireCheck(storeRef.current.state.bots.some(bot => bot.id === STORE_BOT.id), "The synthetic bot was not folded into the real store.");
        storeRef.current.dispatch({ type: "turnCompleted", threadId: STORE_BOT.threadId, ok: true });
        await frames();
        const event = storeRef.current.state.mascotMotion;
        requireCheck(event?.kind === "celebrate" && event.botId === STORE_BOT.id, "The real turn-completion fold did not emit celebration.");
        requireCheck(sample(storeNode.current).state === "celebrate", "The mounted store-backed avatar did not receive celebration.");
        await elapsed(1600);
        requireCheck(storeRef.current.state.mascotMotion === null, "The real StoreProvider expiry effect left its event in global state.");
        setStoreAvatarKey(key => key + 1);
        await frames();
        requireCheck(storeRef.current.state.mascotMotion === null && sample(storeNode.current).state === "sleeping", "A remounted avatar replayed an expired global event.");
        return "Real StoreProvider emitted and expired a synthetic turn-completion event; remounting only the avatar did not replay it. No expiry action was dispatched by the test.";
      });
      await check("BotAvatar forwards runtime attention", async () => {
        requireCheck(storeRef.current, "The store probe is not mounted.");
        for (const activity of ["waiting-on-you", "no-signal", "dead"] as const) {
          const bot = { ...STORE_BOT, activity, busy: activity !== "dead" };
          storeRef.current.dispatch({ type: "botPatched", bot });
          await frames();
          storeRef.current.dispatch({ type: "turnCompleted", threadId: STORE_BOT.threadId, ok: true });
          await frames();
          requireCheck(storeRef.current.state.mascotMotion?.kind === "celebrate", "The synthetic reaction was not emitted.");
          requireCheck(sample(storeNode.current).state === stateForBot(bot), `BotAvatar dropped its ${activity} runtime status.`);
        }
        storeRef.current.dispatch({ type: "botPatched", bot: STORE_BOT });
        return "A real store-backed BotAvatar forwards attention even when a new reaction event arrives before the final activity snapshot.";
      });
      await check("Native reduced-motion preference", async () => {
        await put({ state: "celebrate", motion: "celebrate", animated: true }, true);
        const before = sample();
        probeHandle.current?.blink();
        probeHandle.current?.spin();
        await elapsed(800);
        const after = sample();
        requireCheck(!after.movement && before.eyes === after.eyes && before.gaze === after.gaze, "Reduced-motion avatar responded with animation.");
        return "Native preference holds body, eyes and imperative blink/spin still.";
      }, !reduced);
      await check("Simulated preference change", async () => {
        const originalMatchMedia = window.matchMedia;
        const media = new SimulatedMotionPreference();
        let observer: MutationObserver | undefined;
        window.matchMedia = query => query === media.media ? media : originalMatchMedia.call(window, query);
        try {
          await put({ state: "celebrate", animated: true }, true);
          const first = sample();
          await elapsed(120);
          const moving = sample();
          requireCheck(moving.movement && first.movement !== moving.movement && moving.effectPaths > 0, "The probe did not animate before the simulated preference change.");
          probeHandle.current?.spin();
          await frames();
          media.change(true);
          await frames();
          const parked = sample();
          requireCheck(!parked.movement && parked.effectPaths === 0, "Preference change did not clear body motion and effects.");

          let mutations = 0;
          observer = new MutationObserver(records => { mutations += records.length; });
          observer.observe(probeNode.current!, { attributes: true, childList: true, subtree: true });
          probeHandle.current?.blink();
          probeHandle.current?.spin();
          // Longer than this state's blink/drift intervals: parked means no DOM
          // work, including invisible animation and periodic stale repaints.
          await elapsed(4800);
          const held = sample();
          observer.disconnect();
          requireCheck(mutations === 0 && parked.eyes === held.eyes && parked.gaze === held.gaze, "Blink, spin, drift or repaint continued under the simulated preference.");
          await put({ state: "sleeping", animated: true });
          const updated = sample();
          requireCheck(updated.state === "sleeping" && updated.eyes !== held.eyes && !updated.movement, "A reduced-motion state change failed to update the static face.");

          await put({ state: "celebrate", animated: true });
          media.change(false);
          await frames();
          const resumed = sample();
          await elapsed(120);
          const later = sample();
          requireCheck(resumed.movement && resumed.movement !== later.movement && later.effectPaths > 0, "Animation did not resume after the simulated preference was removed.");
          return "Simulated false → true → false: motion/effects stop, no DOM mutations for 4.8s, static state updates, then animation resumes. Native OS behavior is not claimed.";
        } finally {
          observer?.disconnect();
          window.matchMedia = originalMatchMedia;
          await put({ animated: false }, true);
        }
      });
    } finally {
      setRunning(false);
    }
  };

  const button = "rounded border border-hairline px-3 py-2 text-sm hover:bg-raised-hover disabled:opacity-50";
  const { mount: probeMount, ...probeProps } = probe;
  // Automated scenarios use a stable identity; manual exploration follows the picker.
  const taskBot = running ? taskBotAt(taskStep) : {
    ...taskBotAt(taskStep), color, mascotBody: body ?? "cursor", mascotExpression: state ?? "sleeping",
  };
  const taskState = stateForBot(taskBot);
  return <main className="h-screen overflow-y-auto bg-panel p-6 text-ink">
    <div className="mx-auto max-w-5xl space-y-6">
      <header><h1 className="text-xl font-semibold">Avatar motion verification</h1>
        <p className="mt-2 text-sm text-ink-secondary">Disposable fixture. All bots below are local samples; no messages or settings are saved.</p>
      </header>
      <div className="flex flex-wrap gap-3">
        <button className={button} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Resume animation" : "Pause animation"}</button>
        <button className={button} onClick={() => { setState(undefined); setBody(undefined); setMotion("none"); }}>Restore app defaults</button>
        <span className="self-center text-sm">Native reduced motion: <strong>{reduced ? "on" : "off"}</strong></span>
      </div>
      <section aria-label="Avatar sizes" className="flex flex-wrap items-end gap-10 rounded border border-hairline p-6">
        {[32, 56, 112].map(size => <div key={size} className="space-y-3 text-center">
          <MausAvatar color={color} state={state} bodyId={body} size={size} animated={!paused} motion={motion} motionKey={motionKey} />
          <div className="text-xs">MausAvatar · {size}px</div>
          <BotAvatar bot={{ name: "Fixture bot", color, mascotBody: body }} state={state} size={size} animated={!paused} motion={motion} motionKey={motionKey} />
          <div className="text-xs">BotAvatar · {size}px</div>
        </div>)}
      </section>
      <section><h2 className="mb-3 font-semibold">Expressions ({PICKABLE_STATES.length})</h2>
        <div className="flex flex-wrap gap-2">{PICKABLE_STATES.map(candidate => <button key={candidate} className={button} aria-pressed={state === candidate} onClick={() => setState(candidate)}>
          <MausAvatar color={color} state={candidate} bodyId={body} size={42} animated={false} /><span className="mt-1 block">{candidate}</span>
        </button>)}</div>
      </section>
      <section><h2 className="mb-3 font-semibold">Shapes ({MASCOT_BODY_IDS.length})</h2>
        <div className="flex flex-wrap gap-2">{MASCOT_BODY_IDS.map(id => <button key={id} className={button} aria-pressed={body === id} onClick={() => setBody(id)}>
          <MausAvatar color={color} bodyId={id} size={34} animated={false} /><span className="mt-1 block">{MASCOT_BODIES[id].name}</span>
        </button>)}</div>
      </section>
      <section><h2 className="mb-3 font-semibold">Colors and motions</h2>
        <p className="mb-3 text-sm text-ink-secondary">Changing appearance keeps the current task phase. Reactions below play only when requested.</p>
        <div className="mb-3 flex flex-wrap gap-2">{MAUS_COLOR_NAMES.map(candidate => <button key={candidate} className={button} aria-label={`Color ${candidate}`} aria-pressed={color === candidate} onClick={() => setColor(candidate)}><span className="block h-5 w-5 rounded-full" style={{ background: MAUS_COLORS[candidate] }} /></button>)}</div>
        <div className="flex flex-wrap gap-2">{["none", ...MAUS_MOTIONS].map(candidate => <button key={candidate} className={button} onClick={() => { setMotion(candidate as MausMotion); setMotionKey(key => key + 1); }}>{candidate}</button>)}</div>
      </section>
      <section className="space-y-3 rounded border border-hairline p-4" aria-label="Synthetic task lifecycle">
        <h2 className="font-semibold">Synthetic task lifecycle</h2>
        <p className="text-sm text-ink-secondary">Fixture Scout follows the shape, color and resting expression selected above. Every step supplies synthetic task data to the real stateForBot selector. Automated checks temporarily use a fixed blue Hexagon.</p>
        <div className="flex flex-wrap items-center gap-5">
          <div ref={taskNode} data-testid="task-avatar"><BotAvatar bot={taskBot} state={taskState} size={112} animated={!taskPaused && (running || !paused)} forward={false} lookAround={1} trackPointer={false} /></div>
          <div><strong>{TASK_STEPS[taskStep].label}</strong><p className="text-sm">Expression: {taskState} · Shape: {MASCOT_BODIES[taskBot.mascotBody].name}</p></div>
          <button className={button} disabled={running} onClick={() => setTaskStep(index => (index + 1) % TASK_STEPS.length)}>Next task step</button>
          <button className={button} disabled={running} onClick={() => { setTaskStep(0); setTaskPaused(false); }}>Restart task sequence</button>
          <button className={button} disabled={running} aria-pressed={taskPaused} onClick={() => setTaskPaused(!taskPaused)}>{taskPaused ? "Resume task avatar" : "Pause task avatar"}</button>
        </div>
        <div className="flex flex-wrap gap-2">{TASK_STEPS.map((step, index) => <button key={step.label} className={button} disabled={running} aria-pressed={taskStep === index} onClick={() => setTaskStep(index)}>{index + 1}. {step.label}</button>)}</div>
        <pre className="overflow-auto whitespace-pre-wrap rounded bg-panel-secondary p-3 text-xs" data-testid="task-avatar-input">{JSON.stringify(taskBot, null, 2)}</pre>
      </section>
      <section className="space-y-3 rounded border border-border p-4" aria-label="Automated checks">
        <div className="flex items-center gap-4"><button className={button} disabled={running} onClick={() => void runChecks()}>{running ? "Running checks…" : "Run checks"}</button>
          <div ref={probeNode} data-testid="avatar-probe"><MausAvatar key={probeMount} ref={probeHandle} color="green" {...probeProps} /></div>
        </div>
        <p className="text-xs text-ink-secondary">The checks drive this real React avatar over animation frames. One test temporarily simulates the probe's media query and restores it afterward. Native preference coverage is reported separately; this page never changes system preferences.</p>
        <div ref={storeNode} className="flex items-center gap-3" data-testid="store-avatar-probe">
          <StoreProvider><StoreMotionProbe storeRef={storeRef} avatarKey={storeAvatarKey} /></StoreProvider>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap rounded bg-panel-secondary p-3 text-xs" data-testid="avatar-check-results" aria-live="polite">{JSON.stringify({ running, reducedMotion: reduced, checks }, null, 2)}</pre>
      </section>
    </div>
  </main>;
}

applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
