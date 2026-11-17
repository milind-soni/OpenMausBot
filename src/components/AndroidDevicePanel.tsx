import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Smartphone, Usb } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { t } from "@/lib/i18n";
import { api, ApiError } from "@/state/api";
import { ANDROID_KEY_NAMES, AndroidNavButtons, fittedUnitPoint, type UnitPoint } from "./android-device-parts";
import { PhoneScreenPanel } from "./PhoneScreenPanel";
import { Select } from "./Select";
import type { AndroidDeviceInput, AndroidDeviceStatus, AndroidUsbDevice } from "@/types/ogb";

const EMPTY_STATUS: AndroidDeviceStatus = { available: false, devices: [] };

export type AndroidUsbDevicesStatus = AndroidDeviceStatus & {
  /** A check has finished, successfully or not; read `reasonCode` before trusting an empty list. */
  scanned: boolean;
};

async function readServerPhones(): Promise<AndroidDeviceStatus> {
  try {
    const answer = await api<AndroidDeviceStatus>("/api/usb-phones", { background: true });
    return Array.isArray(answer.devices) ? answer : EMPTY_STATUS;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return EMPTY_STATUS;
    throw cause;
  }
}

/** With `serverPhones` the server lists the phones plugged into its own computer; otherwise the desktop app does. */
export function useAndroidUsbDevices(serverPhones = false): AndroidUsbDevicesStatus {
  const bridge = window.ogb?.androidDevice;
  const [status, setStatus] = useState<AndroidDeviceStatus>(EMPTY_STATUS);
  const [scanned, setScanned] = useState(false);
  const pageVisible = usePageVisible();

  useEffect(() => {
    const read = serverPhones ? readServerPhones : bridge && (() => bridge.status());
    if (!read) {
      setStatus(EMPTY_STATUS);
      setScanned(true);
      return;
    }
    // Every tick is an adb subprocess, so nothing runs while hidden.
    if (!pageVisible) return;
    let alive = true;
    // Overlapping adb checks can answer out of order; an older answer is dropped.
    let issued = 0;
    let answered = 0;
    const refresh = async () => {
      const check = ++issued;
      const superseded = () => check < answered;
      try {
        const next = await read();
        if (alive && !superseded()) {
          answered = check;
          setStatus(next);
        }
      } catch (cause) {
        if (alive && !superseded()) {
          answered = check;
          setStatus({
            available: false,
            devices: [],
            reasonCode: "adb-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      } finally {
        if (alive && !superseded()) setScanned(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge, pageVisible, serverPhones]);

  return { ...status, scanned };
}

function deviceLabel(device: AndroidUsbDevice) {
  return device.model === "Android device" ? device.serial : device.model;
}

export function AndroidDevicePanel({ status, serverPhones = false }: { status: AndroidDeviceStatus; serverPhones?: boolean }) {
  const bridge = serverPhones ? undefined : window.ogb?.androidDevice;
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
  ): UnitPoint | null =>
    imageRef.current ? fittedUnitPoint(event.currentTarget.getBoundingClientRect(), dimensions, event, clampToPhone) : null;

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const named = ANDROID_KEY_NAMES[event.key];
    if (named) {
      event.preventDefault();
      send({ type: "key", key: named });
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
              {t(serverPhones ? "computer.android.serverSubtitle" : "computer.android.usbSubtitle")}
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-success">
            <ShieldCheck size={12} /> {t("computer.android.usb")}
          </span>
        </div>
        {status.devices.length > 1 && (
          <Select
            value={selected.serial}
            onChange={(event) => setSerial(event.target.value)}
            className="mt-3 w-full"
          >
            {status.devices.map((device) => (
              <option key={device.serial} value={device.serial}>
                {deviceLabel(device)} · {device.state}
              </option>
            ))}
          </Select>
        )}
      </div>

      {!ready ? (
        <div className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-[12px] leading-relaxed text-warning">
          {selected.state === "unauthorized"
            ? t("computer.android.unauthorized")
            : t("computer.android.badState", { state: selected.state })}
        </div>
      ) : serverPhones ? (
        <PhoneScreenPanel key={selected.serial} serial={selected.serial} name={deviceLabel(selected)} />
      ) : (
        <>
          <div
            role="application"
            aria-label={t("computer.android.screenAria", { name: deviceLabel(selected) })}
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
                alt={t("computer.android.screenAlt", { name: deviceLabel(selected) })}
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
            <AndroidNavButtons onKey={(key) => send({ type: "key", key })} />
          </div>
          <div className="text-center text-[11px] leading-relaxed text-ink-secondary">
            {t("computer.android.hint")}
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
          <Usb size={15} className="text-accent" /> {t("computer.android.setupTitle")}
        </div>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-relaxed text-ink-secondary">
          <li>{t("computer.android.step1")}</li>
          <li>
            {t("computer.android.step2").split(/(\{buildNumber\}|\{usbDebugging\})/).map((part, index) =>
              part === "{buildNumber}" || part === "{usbDebugging}"
                ? <span key={index} className="text-ink">{t(part === "{buildNumber}" ? "computer.android.buildNumber" : "computer.android.usbDebugging")}</span>
                : part,
            )}
          </li>
          <li>
            {t("computer.android.step3a")}{" "}
            <span className="text-ink">{t("computer.android.allowUsbDebugging")}</span>{" "}
            {t("computer.android.step3b")}
          </li>
        </ol>
        <div className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
          {t("computer.android.agentNote")}
        </div>
        <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[11px] leading-relaxed text-ink-secondary">
          {t("computer.android.harnessNote")}
        </div>
      </div>
    </div>
  );
}
