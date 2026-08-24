import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Circle,
  Clipboard,
  Cloud,
  Download,
  EyeOff,
  FileText,
  Keyboard,
  Mic,
  MonitorUp,
  MousePointer2,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";

import {
  mergeAssemblyAITurn,
  startAssemblyAITranscription,
  type AssemblyAITranscript,
  type AssemblyAITranscriptionSession,
} from "@/lib/assemblyai-transcription";
import {
  appendNativeEvent,
  eventLabel,
  formatRecordingTime,
  type RecordedSkillEvent,
} from "@/lib/skill-recorder";
import { requestScreenPreview, stopScreenPreview } from "@/lib/screen-preview";
import { TRANSCRIPTION_STATUS_EVENT } from "@/lib/transcription-status";
import { useStore } from "@/state/store";

type Phase = "idle" | "starting" | "recording" | "review" | "saving" | "saved";

const iconFor = (type: RecordedSkillEvent["type"]) => {
  if (type === "click") return MousePointer2;
  if (type === "scroll") return ScrollText;
  if (type === "typing" || type === "shortcut") return Keyboard;
  if (type === "clipboard") return Clipboard;
  if (type === "download") return Download;
  return MonitorUp;
};

const originHost = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the microphone recording"));
    reader.readAsDataURL(blob);
  });
}

export function SkillRecorderPage() {
  const { dispatch } = useStore();
  const bridge = window.ogb?.skillRecorder;
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [events, setEvents] = useState<RecordedSkillEvent[]>([]);
  const eventsRef = useRef<RecordedSkillEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [transcriptionConfigured, setTranscriptionConfigured] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; path: string; events: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const transcriptionSessionRef = useRef<AssemblyAITranscriptionSession | null>(null);
  const cloudTranscriptRef = useRef<AssemblyAITranscript>({ turns: new Map(), finalText: "", partialText: "" });
  const audioChunksRef = useRef<Blob[]>([]);
  const audioDataRef = useRef("");
  const startedRef = useRef(0);
  const stoppingRef = useRef(false);

  const updatePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const takeScreenshot = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return undefined;
    const width = Math.min(1120, video.videoWidth);
    const height = Math.round(video.videoHeight * (width / video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/webp", 0.68);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const offEvent = bridge.onEvent((native) => {
      if (phaseRef.current !== "recording") return;
      const result = appendNativeEvent(eventsRef.current, native);
      if (result.addedId) {
        // A frame is worth keeping for visual/context-changing moments (clicks,
        // app switches, scrolls, downloads) but not for typing bursts or
        // clipboard ops — those add no visual evidence and a typing frame can
        // catch field contents. Secure-field typing never reaches here (the
        // native helper suppresses it), but skip typing frames regardless.
        const noFrame = native.type === "typing" || native.type === "clipboard";
        const screenshot = noFrame ? undefined : takeScreenshot();
        if (screenshot) {
          const index = result.events.findIndex((event) => event.id === result.addedId);
          if (index >= 0) result.events[index] = { ...result.events[index]!, screenshot };
        }
      }
      eventsRef.current = result.events;
      setEvents(result.events);
    });
    const offEnd = bridge.onEnd((info) => {
      if (phaseRef.current === "recording" && info.code !== 0) {
        setError(info.reason || "The native recorder stopped unexpectedly.");
      }
    });
    return () => { offEvent(); offEnd(); };
  }, [bridge, takeScreenshot]);

  useEffect(() => {
    let alive = true;
    const onStatus = (event: CustomEvent<{ configured: boolean }>) => {
      setTranscriptionConfigured(event.detail.configured);
    };
    window.addEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    window.ogb?.transcription?.status()
      .then((status) => alive && setTranscriptionConfigured(status.configured))
      .catch(() => alive && setTranscriptionConfigured(false));
    return () => {
      alive = false;
      window.removeEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => setElapsed(Date.now() - startedRef.current);
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const releaseStreams = useCallback(() => {
    stopScreenPreview(screenRef.current);
    screenRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
  }, []);

  useEffect(() => () => {
    void bridge?.stop();
    void transcriptionSessionRef.current?.stop();
    releaseStreams();
  }, [bridge, releaseStreams]);

  const start = async () => {
    setError("");
    if (!bridge || !window.ogb?.beginScreenPreviewIntent || !navigator.mediaDevices?.getDisplayMedia) {
      setError("Skill recording requires the OpenMausBot desktop app on macOS.");
      return;
    }
    if (!transcriptionConfigured || !window.ogb.transcription) {
      setError("Add your AssemblyAI key under Cloud transcription before recording.");
      return;
    }
    const nextPermission = await bridge.permissions();
    if (!nextPermission.supported) {
      setError("Skill recording is currently available in the macOS desktop app.");
      return;
    }
    updatePhase("starting");
    try {
      const selected = await requestScreenPreview({
        beginIntent: () => window.ogb!.beginScreenPreviewIntent(),
        getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
      });
      if (!selected.ok) throw new Error(selected.message);
      screenRef.current = selected.stream;
      const video = videoRef.current;
      if (!video) throw new Error("The recorder preview is unavailable");
      video.srcObject = selected.stream;
      await video.play();

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micRef.current = mic;
      audioChunksRef.current = [];
      const preferredAudio = "audio/webm;codecs=opus";
      const recorder = new MediaRecorder(
        mic,
        MediaRecorder.isTypeSupported(preferredAudio) ? { mimeType: preferredAudio } : undefined,
      );
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.start(1_000);
      mediaRecorderRef.current = recorder;

      await bridge.start();
      eventsRef.current = [];
      setEvents([]);
      transcriptRef.current = "";
      setTranscript("");
      setPartialTranscript("");
      cloudTranscriptRef.current = { turns: new Map(), finalText: "", partialText: "" };
      transcriptionSessionRef.current = await startAssemblyAITranscription({
        stream: mic,
        getToken: () => window.ogb!.transcription!.streamingToken(),
        onTurn: (turn) => {
          const next = mergeAssemblyAITurn(cloudTranscriptRef.current, turn);
          cloudTranscriptRef.current = next;
          transcriptRef.current = next.finalText;
          setTranscript(next.finalText);
          setPartialTranscript(next.partialText);
        },
        onError: (message) => setError(message),
      });
      audioDataRef.current = "";
      startedRef.current = Date.now();
      setElapsed(0);
      updatePhase("recording");
    } catch (caught) {
      await bridge.stop().catch(() => {});
      await transcriptionSessionRef.current?.stop().catch(() => {});
      transcriptionSessionRef.current = null;
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      releaseStreams();
      updatePhase("idle");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const stop = async () => {
    if (stoppingRef.current || phaseRef.current !== "recording") return;
    stoppingRef.current = true;
    setElapsed(Date.now() - startedRef.current);
    try {
      await bridge?.stop();
      await transcriptionSessionRef.current?.stop().catch(() => {
        setError("Cloud transcription did not close cleanly; the original audio is still available.");
      });
      transcriptionSessionRef.current = null;
      const capturedTranscript = [
        cloudTranscriptRef.current.finalText,
        cloudTranscriptRef.current.partialText,
      ].filter(Boolean).join(" ");
      transcriptRef.current = capturedTranscript;
      setTranscript(capturedTranscript);
      setPartialTranscript("");
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
      }
      mediaRecorderRef.current = null;
      if (audioChunksRef.current.length) {
        const mime = recorder?.mimeType.split(";")[0] || "audio/webm";
        audioDataRef.current = await blobDataUrl(new Blob(audioChunksRef.current, { type: mime }));
      }
      releaseStreams();
      updatePhase("review");
    } catch (caught) {
      await transcriptionSessionRef.current?.stop().catch(() => {});
      transcriptionSessionRef.current = null;
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      releaseStreams();
      updatePhase("review");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      stoppingRef.current = false;
    }
  };

  const discard = async () => {
    await bridge?.stop().catch(() => {});
    await transcriptionSessionRef.current?.stop().catch(() => {});
    transcriptionSessionRef.current = null;
    if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    releaseStreams();
    eventsRef.current = [];
    setEvents([]);
    setTranscript("");
    setPartialTranscript("");
    setName("");
    setDescription("");
    setSaved(null);
    setError("");
    updatePhase("idle");
  };

  const removeEvent = (id: string) => {
    const next = eventsRef.current.filter((event) => event.id !== id);
    eventsRef.current = next;
    setEvents(next);
  };

  const save = async () => {
    if (!bridge || !name.trim()) return;
    updatePhase("saving");
    setError("");
    try {
      const result = await bridge.save({
        name,
        description,
        durationMs: elapsed,
        transcript: transcriptRef.current,
        transcription: { provider: "assemblyai", model: "u3-rt-pro" },
        audio: audioDataRef.current || undefined,
        events: eventsRef.current,
      });
      setSaved(result);
      updatePhase("saved");
    } catch (caught) {
      updatePhase("review");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const restart = () => void discard();
  const recording = phase === "recording";

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <video ref={videoRef} muted playsInline className="pointer-events-none absolute size-px opacity-0" />
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-hairline px-6">
        <div>
          <h1 className="text-[15px] font-semibold">Teach a skill</h1>
          <p className="text-[11px] text-ink-secondary">Show it once. Let every bot repeat it.</p>
        </div>
        {recording && (
          <button type="button" onClick={() => void stop()} className="flex items-center gap-2 rounded-full bg-danger px-4 py-2 text-[12px] font-semibold text-white shadow-sm">
            <Square size={11} fill="currentColor" /> Stop · {formatRecordingTime(elapsed)}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8">
          {phase === "idle" || phase === "starting" ? (
            <div className="mx-auto max-w-2xl">
              <div className="rounded-3xl border border-hairline bg-panel p-8 shadow-sm">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-accent/15 text-accent-text">
                  <Sparkles size={24} />
                </div>
                <h2 className="mt-5 text-[25px] font-semibold tracking-[-0.02em]">Record yourself doing the task</h2>
                <p className="mt-2 max-w-xl text-[14px] leading-6 text-ink-secondary">
                  Speak naturally while you work. OpenMausBot lines up your clicks, app changes, screenshots, and narration, then turns the reviewed demonstration into a reusable local skill.
                </p>

                <div className="mt-7 grid gap-3 sm:grid-cols-3">
                  {[
                    { Icon: MousePointer2, label: "Actions", copy: "Clicks, scrolling, app changes" },
                    { Icon: MonitorUp, label: "Visuals", copy: "A frame at each useful moment" },
                    { Icon: Mic, label: "Narration", copy: "Live transcript plus original audio" },
                  ].map(({ Icon, label, copy }) => (
                    <div key={label} className="rounded-2xl bg-card p-4">
                      <Icon size={18} className="text-ink-secondary" />
                      <div className="mt-3 text-[13px] font-medium">{label}</div>
                      <div className="mt-1 text-[11px] leading-4 text-ink-secondary">{copy}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 flex items-start gap-3 rounded-2xl bg-inset px-4 py-3">
                  <EyeOff size={17} className="mt-0.5 shrink-0 text-success" />
                  <p className="text-[12px] leading-5 text-ink-secondary">
                    Raw keystrokes and clipboard contents are never stored. Screen frames can contain visible text and stay on this computer; microphone audio is streamed to AssemblyAI for transcription. You review everything before creating the skill.
                  </p>
                </div>

                <div className="mt-4 flex items-center gap-3 rounded-2xl border border-hairline bg-card p-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent-text"><Cloud size={17} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      Cloud transcription
                      {transcriptionConfigured && <span className="text-[10px] font-medium text-success">Saved</span>}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-ink-secondary">
                      {transcriptionConfigured ? "AssemblyAI is ready for live narration." : "Add an AssemblyAI key in Settings before recording."}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
                    className="shrink-0 rounded-xl bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover"
                  >
                    {transcriptionConfigured ? "Manage" : "Open Settings"}
                  </button>
                </div>

                <button type="button" disabled={phase === "starting" || !transcriptionConfigured} onClick={() => void start()} className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3.5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-40">
                  {phase === "starting" ? <><Circle size={15} className="animate-pulse" /> Getting ready…</> : <><Circle size={14} fill="currentColor" /> Start recording</>}
                </button>
                <p className="mt-3 text-center text-[11px] text-ink-secondary">macOS will ask for screen, microphone, and action-recording access the first time.</p>
              </div>
            </div>
          ) : recording ? (
            <div className="mx-auto max-w-2xl">
              <div className="rounded-3xl border border-danger/30 bg-panel p-8 text-center shadow-sm">
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-danger/12">
                  <span className="size-4 animate-pulse rounded-full bg-danger" />
                </div>
                <h2 className="mt-5 text-[25px] font-semibold">You’re teaching</h2>
                <p className="mt-2 text-[14px] text-ink-secondary">Move through the task and explain the why as you go.</p>
                <div className="mx-auto mt-6 max-w-lg rounded-2xl bg-inset p-4 text-left">
                  <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.12em] text-ink-secondary">
                    <span className="flex items-center gap-2"><Volume2 size={14} /> Live narration · AssemblyAI</span>
                    <span>{events.length} moments</span>
                  </div>
                  <p className="mt-3 min-h-12 text-[13px] leading-5 text-ink">
                    {[transcript, partialTranscript].filter(Boolean).join(" ") || "Start speaking — your transcript will appear here."}
                  </p>
                </div>
                <button type="button" onClick={() => void stop()} className="mx-auto mt-7 flex items-center gap-2 rounded-2xl bg-danger px-6 py-3 text-[14px] font-semibold text-white">
                  <Square size={12} fill="currentColor" /> Stop and review
                </button>
              </div>
            </div>
          ) : phase === "review" || phase === "saving" ? (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-success">Recording complete</div>
                  <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.02em]">Review what the bot learned</h2>
                  <p className="mt-1 text-[13px] text-ink-secondary">Remove anything private or irrelevant, then name the skill.</p>
                </div>
                <button type="button" onClick={() => void discard()} className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised"><Trash2 size={15} /> Discard recording</button>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                <section className="min-w-0 space-y-3">
                  {events.map((event, index) => {
                    const Icon = iconFor(event.type);
                    const context = [
                      event.name,
                      event.app,
                      event.windowTitle,
                      event.type === "download" ? originHost(event.whereFroms?.[0]) : undefined,
                    ].filter(Boolean).join(" · ") || formatRecordingTime(event.atMs);
                    return (
                      <article key={event.id} className="group overflow-hidden rounded-2xl border border-hairline bg-panel">
                        {event.screenshot && <img src={event.screenshot} alt={`Recorded screen at step ${index + 1}`} className="aspect-[16/9] w-full bg-inset object-cover object-top" />}
                        <div className="flex items-center gap-3 px-4 py-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-card text-ink-secondary"><Icon size={15} /></span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-medium">{index + 1}. {eventLabel(event)}</div>
                            <div className="truncate text-[10.5px] text-ink-secondary">{context}</div>
                          </div>
                          <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => removeEvent(event.id)} className="rounded-lg p-2 text-ink-secondary opacity-60 hover:bg-raised hover:text-danger group-hover:opacity-100"><X size={14} /></button>
                        </div>
                      </article>
                    );
                  })}
                  {!events.length && <div className="rounded-2xl border border-dashed border-hairline p-8 text-center text-[12px] text-ink-secondary">No action steps remain. The narration can still become the skill.</div>}
                </section>

                <aside className="h-fit rounded-2xl border border-hairline bg-panel p-5 lg:sticky lg:top-0">
                  <label className="block text-[11px] font-medium text-ink-secondary" htmlFor="skill-name">Skill name</label>
                  <input id="skill-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. File an expense report" maxLength={100} className="mt-2 w-full rounded-xl border border-hairline bg-inset px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-secondary/60 focus:border-accent" />
                  <label className="mt-4 block text-[11px] font-medium text-ink-secondary" htmlFor="skill-description">When should bots use it?</label>
                  <textarea id="skill-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Use when I ask to submit a company expense…" maxLength={300} rows={4} className="mt-2 w-full resize-none rounded-xl border border-hairline bg-inset px-3 py-2.5 text-[12px] leading-5 outline-none placeholder:text-ink-secondary/60 focus:border-accent" />
                  <div className="mt-4 space-y-2 rounded-xl bg-inset p-3 text-[11px] text-ink-secondary">
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><FileText size={13} /> Steps</span><span>{events.length}</span></div>
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><Mic size={13} /> Narration</span><span>{transcript ? "Included" : "Audio only"}</span></div>
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><ShieldCheck size={13} /> Storage</span><span>Local</span></div>
                  </div>
                  <button type="button" disabled={!name.trim() || phase === "saving"} onClick={() => void save()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[13px] font-semibold text-white disabled:opacity-40">
                    <Sparkles size={15} /> {phase === "saving" ? "Creating skill…" : "Create skill"}
                  </button>
                </aside>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-xl rounded-3xl border border-hairline bg-panel p-9 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/15 text-success"><Check size={27} /></div>
              <h2 className="mt-5 text-[25px] font-semibold">Skill ready</h2>
              <p className="mt-2 text-[13px] leading-5 text-ink-secondary">Bots will load <span className="text-ink">{name}</span> automatically when a request matches it.</p>
              <div className="mt-5 rounded-2xl bg-inset p-4 text-left">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-secondary">Saved locally</div>
                <div className="mt-1 break-all text-[11px] text-ink">{saved?.path}</div>
              </div>
              <button type="button" onClick={restart} className="mt-6 rounded-xl bg-raised px-5 py-2.5 text-[13px] font-medium hover:bg-raised-hover">Teach another skill</button>
            </div>
          )}

          {error && <div role="alert" className="mx-auto mt-4 max-w-2xl rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[12px] text-danger">{error}</div>}
        </div>
      </div>
    </main>
  );
}
