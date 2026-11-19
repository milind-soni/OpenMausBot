import { useEffect, useState } from "react";
import { Color } from "three";

export interface ClassroomColors {
  accent: string;
  app: string;
  board: string;
  boardFrame: string;
  boardInk: string;
  card: string;
  chair: string;
  control: string;
  desk: string;
  floor: string;
  hairline: string;
  ink: string;
  panel: string;
  raised: string;
  success: string;
  wall: string;
  warning: string;
  danger: string;
}

export function mixColor(from: string, to: string, amount: number) {
  return new Color(from).lerp(new Color(to), amount).getStyle();
}

function luminance(value: string) {
  const color = new Color(value);
  return (0.2126 * color.r) + (0.7152 * color.g) + (0.0722 * color.b);
}

function readColors(): ClassroomColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const app = read("--color-app");
  const accent = read("--color-accent");
  const card = read("--color-card");
  const control = read("--color-control");
  const hairline = read("--color-hairline");
  const ink = read("--color-ink");
  const panel = read("--color-panel");
  const raised = read("--color-raised");
  const board = luminance(app) < luminance(ink) ? app : ink;
  const boardInk = luminance(panel) > luminance(ink) ? panel : ink;
  return {
    accent,
    app,
    board,
    boardFrame: mixColor(control, ink, 0.28),
    boardInk,
    card,
    chair: mixColor(control, accent, 0.16),
    control,
    desk: mixColor(card, accent, 0.22),
    floor: mixColor(board, control, 0.3),
    hairline,
    ink,
    panel,
    raised,
    success: read("--color-success"),
    wall: mixColor(panel, accent, 0.08),
    warning: read("--color-warning"),
    danger: read("--color-danger"),
  };
}

export function useClassroomColors() {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(readColors()));
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return colors;
}
