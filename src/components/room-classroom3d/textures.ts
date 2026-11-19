import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

function createWoodCanvas(baseHex: string, grainHex: string, plankLines: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);

  // Subtle wood grain streaks
  for (let i = 0; i < 160; i++) {
    const y = (i * 3.2) % 512;
    const alpha = 0.04 + ((i * 37) % 10) * 0.008;
    ctx.strokeStyle = grainHex;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1 + (i % 3);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(170, y + ((i % 5) - 2) * 3, 340, y - ((i % 7) - 3) * 2, 512, y);
    ctx.stroke();
  }

  if (plankLines) {
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = grainHex;
    ctx.lineWidth = 2;
    const plankCount = 4;
    const plankHeight = 512 / plankCount;
    for (let p = 0; p < plankCount; p++) {
      const py = p * plankHeight;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(512, py);
      ctx.stroke();

      const jointX = ((p * 193 + 96) % 420) + 46;
      ctx.beginPath();
      ctx.moveTo(jointX, py);
      ctx.lineTo(jointX, py + plankHeight);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  return canvas;
}

export function createWoodTexture(baseHex = "#c79a6b", grainHex = "#8f6239", repeatX = 1, repeatY = 1) {
  const texture = new CanvasTexture(createWoodCanvas(baseHex, grainHex, false));
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

export function createFloorPlankTexture(repeatX = 4, repeatY = 4) {
  const texture = new CanvasTexture(createWoodCanvas("#cbb08a", "#9c7e56", true));
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function createNameBadgeTexture({
  name,
  roleLabel,
  statusLabel,
  statusColor,
  isCoordinator,
  active,
}: {
  name: string;
  roleLabel?: string;
  statusLabel?: string;
  statusColor: string;
  isCoordinator: boolean;
  active: boolean;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hasRole = Boolean(roleLabel);
    const hasStatus = Boolean(statusLabel);

    ctx.font = "600 32px Inter, system-ui, -apple-system, sans-serif";
    const nameWidth = ctx.measureText(name).width;
    ctx.font = "600 20px Inter, system-ui, -apple-system, sans-serif";
    const roleWidth = roleLabel ? ctx.measureText(roleLabel.toUpperCase()).width : 0;
    ctx.font = "500 24px Inter, system-ui, -apple-system, sans-serif";
    const statusWidth = statusLabel ? ctx.measureText(statusLabel).width + 26 : 0;

    const pillWidth = Math.min(480, Math.max(170, Math.max(nameWidth, roleWidth, statusWidth) + 56));
    const pillHeight = 76 + (hasRole ? 28 : 0) + (hasStatus ? 36 : 0);
    const x = (canvas.width - pillWidth) / 2;
    const y = (canvas.height - pillHeight) / 2;

    drawRoundedRect(ctx, x, y, pillWidth, pillHeight, 22);
    ctx.fillStyle = isCoordinator
      ? "rgba(255, 251, 240, 0.96)"
      : active
        ? "rgba(15, 23, 42, 0.90)"
        : "rgba(15, 23, 42, 0.78)";
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = isCoordinator
      ? (active ? "#10b981" : "rgba(180, 140, 80, 0.85)")
      : (active ? "rgba(52, 211, 153, 0.80)" : "rgba(255, 255, 255, 0.28)");
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let cursorY = y + 26;
    if (roleLabel) {
      ctx.font = "700 18px Inter, system-ui, -apple-system, sans-serif";
      ctx.fillStyle = isCoordinator ? "rgba(31, 41, 55, 0.65)" : "rgba(248, 250, 252, 0.65)";
      ctx.fillText(roleLabel.toUpperCase(), canvas.width / 2, cursorY, pillWidth - 36);
      cursorY += 32;
    } else {
      cursorY += 12;
    }

    ctx.font = "600 32px Inter, system-ui, -apple-system, sans-serif";
    ctx.fillStyle = isCoordinator ? "#111827" : "#f8fafc";
    ctx.fillText(name, canvas.width / 2, cursorY, pillWidth - 36);

    if (statusLabel) {
      cursorY += 38;
      ctx.font = "500 24px Inter, system-ui, -apple-system, sans-serif";
      const textW = ctx.measureText(statusLabel).width;
      const dotRadius = 7;
      const gap = 12;
      const totalW = dotRadius * 2 + gap + textW;
      const startX = (canvas.width - totalW) / 2;

      ctx.beginPath();
      ctx.arc(startX + dotRadius, cursorY, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#34d399" : statusColor;
      ctx.fill();

      ctx.textAlign = "left";
      ctx.fillStyle = isCoordinator ? "#1f2937" : "#e2e8f0";
      ctx.fillText(statusLabel, startX + dotRadius * 2 + gap, cursorY, pillWidth - 52);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, aspect: canvas.width / canvas.height };
}

