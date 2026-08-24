import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Circle, Loader2, RotateCcw, ShieldCheck, Smartphone, Usb } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import type { AndroidDeviceInput, AndroidDeviceStatus, AndroidUsbDevice } from "@/types/ogb";

type UnitPoint = { x: number; y: number };

const EMPTY_STATUS: AndroidDeviceStatus = { available: false, devices: [] };

export function useAndroidUsbDevices() {
  const bridge = window.ogb?.androidDevice;
  const [status, setStatus] = useState<AndroidDeviceStatus>(EMPTY_STATUS);
  const pageVisible = usePageVisible();

  useEffect(() => {
    // every tick is an adb subprocess — nothing to learn while hidden
    if (!bridge || !pageVisible) return;
    let alive = true;
    const refresh = async () => {
      try {
        const next = await bridge.status();
        if (alive) setStatus(next);
      } catch (cause) {
        if (alive) {
          setStatus({
            available: false,
            devices: [],
            reasonCode: "adb-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge, pageVisible]);

  return status;
}

function deviceLabel(device: AndroidUsbDevice) {
  return device.model === "Android device" ? device.serial : device.model;
}

export function AndroidDevicePanel({ status }: { status: AndroidDeviceStatus }) {
  const bridge = window.ogb?.androidDevice;
  const pageVisible = usePageVisible();
  const authorized = status.devices.filter((device) => device.state === "device");
  const [serial, setSerial] = useState(authorized[0]?.serial ?? status.devices[0]?.serial ?? "");
  const [frame, setFrame] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointerRef = useRef<{ point: UnitPoint; at: number } | null>(null);
  const wheelRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>({
    x: 0,
    y: 0,
    timer: null,
  });
  const selected = status.devices.find((device) => device.serial === serial) ?? status.devices[0];
  const selectedSerial = selected?.serial;
  const selectedState = selected?.state;

  useEffect(() => {
    if (!selected && status.devices[0]) setSerial(status.devices[0].serial);
    if (selected && !status.devices.some((device) => device.serial === selected.serial)) {
      setSerial(status.devices[0]?.serial ?? "");
    }
  }, [selected, status.devices]);

  useEffect(() => {
    // an adb screencap subprocess per tick — pause the mirror while hidden
    if (!bridge || !selectedSerial || selectedState !== "device" || !pageVisible) {
      if (!pageVisible) return;
      setFrame(null);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    const capture = async () => {
      try {
        const result = await bridge.frame(selectedSerial);
        if (alive) {
          setFrame(result.dataUrl);
          setError(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (alive) timer = window.setTimeout(() => void capture(), 850);
      }
    };
    void capture();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [bridge, selectedSerial, selectedState, pageVisible]);

  useEffect(
    () => () => {
      if (wheelRef.current.timer) clearTimeout(wheelRef.current.timer);
    },
    [],
  );

  const send = (payload: AndroidDeviceInput) => {
    if (!bridge || !selected || selected.state !== "device") return;
    void bridge.input(selected.serial, payload).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const unitPoint = (
    event: React.PointerEvent<HTMLDivElement>,
    clampToPhone = false,
  ): UnitPoint | null => {
    const image = imageRef.current;
    if (!image || !dimensions.width || !dimensions.height) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(bounds.width / dimensions.width, bounds.height / dimensions.height);
    const fittedWidth = dimensions.width * scale;
    const fittedHeight = dimensions.height * scale;
    const left = bounds.left + (bounds.width - fittedWidth) / 2;
    const top = bounds.top + (bounds.height - fittedHeight) / 2;
    const x = (event.clientX - left) / fittedWidth;
    const y = (event.clientY - top) / fittedHeight;
    if (clampToPhone) {
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const named: Record<string, string> = {
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      Backspace: "delete",
      Delete: "delete",
      Enter: "enter",
      Escape: "back",
      Tab: "tab",
    };
    if (named[event.key]) {
      event.preventDefault();
      send({ type: "key", key: named[event.key] });
    } else if (/^[A-Za-z0-9 _.,@-]$/.test(event.key)) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  };

  const wheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!dimensions.width || !dimensions.height) return;
    event.preventDefault();
    const gesture = wheelRef.current;
    gesture.x += event.deltaX;
    gesture.y += event.deltaY;
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = setTimeout(() => {
      const horizontal = Math.abs(gesture.x) > Math.abs(gesture.y);
      const delta = horizontal ? gesture.x : gesture.y;
      gesture.x = 0;
      gesture.y = 0;
      gesture.timer = null;
      if (Math.abs(delta) < 2) return;
      const distance = Math.max(0.18, Math.min(0.45, Math.abs(delta) / 500));
      const direction = delta > 0 ? -1 : 1;
      const from = horizontal ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.65 };
      const to = horizontal
        ? { x: from.x + direction * distance, y: from.y }
        : { x: from.x, y: from.y + direction * distance };
      send({
        type: "swipe",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        durationMs: 260,
        width: dimensions.width,
        height: dimensions.height,
      });
    }, 80);
  };

  if (!selected) return null;
  const ready = selected.state === "device";

  return (
    <div className="space-y-3 pb-5">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <Smartphone size={16} className="text-success" /> {deviceLabel(selected)}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
              Connected directly over USB. The screen and controls stay on this computer.
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-success">
            <ShieldCheck size={12} /> USB
          </span>
        </div>
        {status.devices.length > 1 && (
          <select
            value={selected.serial}
            onChange={(event) => setSerial(event.target.value)}
            className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink"
          >
            {status.devices.map((device) => (
              <option key={device.serial} value={device.serial}>
                {deviceLabel(device)} · {device.state}
              </option>
            ))}
          </select>
        )}
      </div>

      {!ready ? (
        <div className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-[12px] leading-relaxed text-warning">
          {selected.state === "unauthorized"
            ? "Unlock the Android phone, accept the “Allow USB debugging” prompt, and optionally choose Always allow from this computer."
            : `The phone is ${selected.state}. Reconnect the USB cable and keep USB debugging enabled.`}
        </div>
      ) : (
        <>
          <div
            role="application"
            aria-label={`Interactive Android screen for ${deviceLabel(selected)}`}
            tabIndex={0}
            onKeyDown={keyDown}
            onWheel={wheel}
            onPointerDown={(event) => {
              const point = unitPoint(event);
              if (!point) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerRef.current = { point, at: performance.now() };
            }}
            onPointerUp={(event) => {
              const start = pointerRef.current;
              const end = unitPoint(event, true);
              pointerRef.current = null;
              if (!start || !end) return;
              const distance = Math.hypot(end.x - start.point.x, end.y - start.point.y);
              if (distance < 0.012) {
                send({ type: "tap", ...end, ...dimensions });
              } else {
                send({
                  type: "swipe",
                  fromX: start.point.x,
                  fromY: start.point.y,
                  toX: end.x,
                  toY: end.y,
                  durationMs: performance.now() - start.at,
                  ...dimensions,
                });
              }
              event.currentTarget.focus();
            }}
            onPointerCancel={() => {
              pointerRef.current = null;
            }}
            className="mx-auto flex h-[520px] w-full touch-none cursor-pointer items-center justify-center overflow-hidden overscroll-none rounded-[28px] bg-black outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-accent"
          >
            {frame ? (
              <img
                ref={imageRef}
                src={frame}
                alt={`${deviceLabel(selected)} screen`}
                draggable={false}
                onLoad={(event) => {
                  setDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
                className="pointer-events-none h-full w-full select-none object-contain"
              />
            ) : (
              <Loader2 size={20} className="animate-spin text-ink-secondary" />
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => send({ type: "key", key: "back" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <ArrowLeft size={13} /> Back
            </button>
            <button
              onClick={() => send({ type: "key", key: "home" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <Circle size={12} /> Home
            </button>
            <button
              onClick={() => send({ type: "key", key: "recent" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <RotateCcw size={13} /> Recent
            </button>
          </div>
          <div className="text-center text-[11px] leading-relaxed text-ink-secondary">
            Click to tap, drag or use a trackpad to scroll, and type after selecting a field.
          </div>
        </>
      )}

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <Usb size={15} className="text-accent" /> First-time USB setup
        </div>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[11.5px] leading-relaxed text-ink-secondary">
          <li>Connect the phone with a data-capable USB cable and keep it unlocked.</li>
          <li>
            Enable Developer options by tapping <span className="text-ink">Build number</span> seven times in
            About phone, then turn on <span className="text-ink">USB debugging</span>.
          </li>
          <li>
            Accept <span className="text-ink">Allow USB debugging</span> on the phone. You can choose Always allow
            for this trusted computer.
          </li>
        </ol>
        <div className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
          Agent control uses this same authorized USB connection. No phone companion app, account, Tailscale, or
          wireless pairing is needed.
        </div>
        <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[11px] leading-relaxed text-ink-secondary">
          Once connected, ask any compatible Maus to open an Android app or complete a task on your phone. The
          bundled Phone Harness skill loads automatically for phone requests.
        </div>
      </div>
    </div>
  );
}
