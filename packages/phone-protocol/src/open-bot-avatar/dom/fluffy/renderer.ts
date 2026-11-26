/**
 * The fluffy renderer: draws a body as a lit coat of fur with the eyes seated in it. Every fluffy
 * avatar on the page shares one WebGL2 context (browsers allow only a handful), which renders one
 * avatar at a time into its own canvas; the 2D painter copies that image into the avatar's canvas
 * (see paint.ts), under the ribbons and marks it draws itself.
 *
 * A frame is three kinds of draw over the same mesh: the solid body, a few shells of pile lifted
 * off it, and the single strands (see shaders.ts). Meshes are built once per shape and kept on
 * the GPU while their avatars keep painting, so a page of avatars only pays for drawing, and a
 * small avatar draws less of each (see fluffyDetail).
 */
import type { EyeMark, SurfaceEye, ViewBasis } from '../../render.ts';
import { DYE_RAMP_SIZE, dyeRamp } from './dye.ts';
import { ROOT_PASSES, buildMesh, halfDepth, rootsIn, type IndexRange, type FluffyShape } from './mesh.ts';
import { FINISH, PASS, fragmentShader, vertexShader } from './shaders.ts';
import { SOCKET_TILE, exposedHeight, socketKey, socketRegion, socketTile } from './socket.ts';

/** MausBot: how the surface is finished. Matte and metallic light the bare body and draw no pile. */
export type FluffyFinish = keyof typeof FINISH;

/** The colors of a coat and the eyes set into it (none for a state mark). */
export interface FluffyLook {
  /** Body color, any CSS color. */
  color: string;
  /** Eye color, any CSS color. */
  ink: string;
  /** Up to two eyes, left first. */
  eyes: SurfaceEye[];
  /** Fluffy when left out. */
  finish?: FluffyFinish;
}

/** A rendered coat. It lasts until the next render: draw or copy it at once. */
export interface FluffyImage {
  /** The renderer's canvas, which may be larger than the image. */
  canvas: HTMLCanvasElement;
  /** The image's square in the canvas, pixels: `size` to the right of and below (x, y). */
  x: number;
  y: number;
  size: number;
  /** The square the image covers, viewBox units: `radius` to each side of (cx, cy). */
  cx: number;
  cy: number;
  radius: number;
}

/** Shells of pile between the body and the strands, at full detail. */
const SHELLS = 5;
/**
 * Pixels per viewBox unit from which a coat is drawn in full: an avatar 128 CSS pixels wide on a
 * 2× display. Below it the pile is finer than the pixels that show it (see fluffyDetail).
 */
const FULL_DETAIL = 2.56;
/** Largest image, pixels a side. */
const MAX_PIXELS = 1024;
const MIN_PIXELS = 32;
/** Pixels around an image that are cleared with it, for the painter's smoothing to read. */
const EDGE_PIXELS = 2;
/** Room around the body for the pile, viewBox units. */
const PILE_REACH = 4;
/** The eyes sit this far above their host's surface at most, viewBox units. */
const SOCKET_RISE = 0.8;
/** A view this close to the last one drawn, in pixels of surface movement, reuses its image. */
const SAME_VIEW = 0.1;
/** This many meshes always stay on the GPU; any more only while they were drawn within IDLE_MS. */
const KEPT_MESHES = 8;
const IDLE_MS = 2000;

/**
 * How much of a coat to draw at `scale` pixels per viewBox unit. A small avatar gets fewer shells,
 * the unrefined triangles around its eyes, and a share of its strands (`strandPasses` of the
 * mesh's ROOT_PASSES), each widened by as much as there are fewer, so they cover the same. The
 * image averages out to the same coat at half to two thirds of the cost.
 */
export function fluffyDetail(scale: number): { shells: number; strandPasses: number; fineSockets: boolean } {
  const detail = Math.min(1, scale / FULL_DETAIL);
  return {
    shells: Math.max(2, Math.ceil(SHELLS * detail)),
    // By the root, not in proportion: strands that get much wider show as wisps along the outline.
    strandPasses: Math.max(ROOT_PASSES / 4, Math.ceil(ROOT_PASSES * Math.sqrt(detail))),
    fineSockets: detail > 0.75,
  };
}

/** A mesh on the GPU, and where its shape sits. */
interface Geometry {
  surface: WebGLVertexArrayObject;
  strands: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  coarse: IndexRange;
  fine: IndexRange;
  strandCount: number;
  cx: number;
  cy: number;
  /** Half extents of the shape, for bending normals across its flat faces. */
  extent: [number, number, number];
  radius: number;
  usedAt: number;
}

type Rgb = [number, number, number];

/** Seeded, so the pile is the same on every page load. */
function randomFrom(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** A tileable texture of short curved fibers, for the compressed pile around the eye sockets. */
function fiberTile(): HTMLCanvasElement {
  const size = 128;
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const g = tile.getContext('2d')!;
  g.fillStyle = '#252525';
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';
  const random = randomFrom(9213);
  for (let i = 0; i < 1400; i++) {
    const x = random() * size, y = random() * size;
    const angle = 2.4 * Math.sin((y * Math.PI) / 32) + 1.4 * Math.cos((x * Math.PI) / 32) + (random() - 0.5) * 3.3;
    const dx = Math.cos(angle), dy = Math.sin(angle), length = 3 + random() * 8, curl = (random() - 0.5) * length;
    const grey = Math.round(55 + 200 * random());
    g.strokeStyle = `rgb(${grey} ${grey} ${grey})`;
    g.lineWidth = 0.8 + random() * 1.5;
    // Draw each fiber on every neighboring tile it reaches into, so the edges wrap.
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      if (x + ox < -12 || x + ox > size + 12 || y + oy < -12 || y + oy > size + 12) continue;
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + dx * length * 0.5 - dy * curl, y + oy + dy * length * 0.5 + dx * curl, x + ox + dx * length, y + oy + dy * length);
      g.stroke();
    }
  }
  return tile;
}

/** Random root density in a repeating cube: a volume has no UV seams or poles. */
function rootVolume(side: number): Uint8Array {
  const roots = new Uint8Array(side ** 3);
  let seed = 73021;
  for (let i = 0; i < roots.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    roots[i] = seed >>> 24;
  }
  return roots;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(kind)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compilation failed');
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'shader linking failed');
  return program;
}

/** Reads any CSS color as RGB bytes. */
function colorReader(): (color: string) => Rgb {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const known = new Map<string, Rgb>();
  return (color) => {
    let rgb = known.get(color);
    if (!rgb) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      rgb = [r, g, b];
      if (known.size >= 64) known.clear();
      known.set(color, rgb);
    }
    return rgb;
  };
}

type Renderer = (shape: FluffyShape, view: ViewBasis, look: FluffyLook, scale: number) => FluffyImage | null;

/** Null without WebGL2. Throws if the shaders don't compile. */
function createRenderer(onContextRestored: () => void): Renderer | null {
  const canvas = document.createElement('canvas');
  // Square, and only ever grown (see below).
  canvas.width = canvas.height = MIN_PIXELS;
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  // A lost context returns no image until the browser restores it; the avatar draws flat meanwhile.
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const program = link(gl, vertexShader, fragmentShader);
  gl.useProgram(program);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    view: uniform('view'), pivot: uniform('pivot'), extent: uniform('extent'), radius: uniform('radius'),
    shell: uniform('shell'), strandWidth: uniform('strandWidth'), pass: uniform('pass'), finish: uniform('finish'), color: uniform('color'), ink: uniform('ink'),
    eyeRegion: uniform('eyeRegion[0]'), eyeSize: uniform('eyeSize[0]'),
  };
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.SCISSOR_TEST);

  // Texture units: 0 fibers, 1 eye distance tiles, 2 root density, 3 dye ramp.
  const texture = (unit: number, sampler: string, target: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, gl.createTexture());
    gl.uniform1i(uniform(sampler), unit);
  };
  const clampLinear = () => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  texture(0, 'pile', gl.TEXTURE_2D);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fiberTile());
  gl.generateMipmap(gl.TEXTURE_2D);
  texture(2, 'brushedPile', gl.TEXTURE_3D);
  const side = 64;
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, side, side, side, 0, gl.RED, gl.UNSIGNED_BYTE, rootVolume(side));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.generateMipmap(gl.TEXTURE_3D);
  texture(3, 'dyeRamp', gl.TEXTURE_2D);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, DYE_RAMP_SIZE, 1);
  clampLinear();
  // Last, so its unit stays active: the eyes' tiles sit side by side, and change the most.
  texture(1, 'eyeField', gl.TEXTURE_2D);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 2 * SOCKET_TILE, SOCKET_TILE);
  clampLinear();

  // --- Meshes -------------------------------------------------------------------------------------

  const geometries = new Map<FluffyShape, Geometry>();
  let sweepPending = false;

  const upload = (shape: FluffyShape): Geometry => {
    const mesh = buildMesh(shape);
    const buffer = (target: number, data: Float32Array | Uint32Array) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    const attributes = (stride: number, sizes: number[], perInstance: boolean) => {
      let offset = 0;
      sizes.forEach((size, location) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        if (perInstance) gl.vertexAttribDivisor(location, 1);
        offset += 4 * size;
      });
    };
    // The body and its shells: position and normal per vertex.
    const surface = gl.createVertexArray();
    gl.bindVertexArray(surface);
    const vertices = buffer(gl.ARRAY_BUFFER, mesh.vertices);
    attributes(24, [3, 3], false);
    const indices = buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    // The strands: one instance per root (position, normal, two random numbers); the shader
    // shapes its eight vertices from gl_VertexID.
    const strands = gl.createVertexArray();
    gl.bindVertexArray(strands);
    const roots = buffer(gl.ARRAY_BUFFER, mesh.roots);
    attributes(32, [3, 3, 2], true);

    const b = shape.bounds, rx = (b.maxX - b.minX) / 2, ry = (b.maxY - b.minY) / 2, rz = halfDepth(shape);
    return {
      surface, strands, buffers: [vertices, indices, roots],
      coarse: mesh.coarse, fine: mesh.fine, strandCount: mesh.roots.length / 8,
      cx: b.minX + rx, cy: b.minY + ry, extent: [rx, ry, rz], radius: Math.ceil(Math.hypot(rx, ry, rz) + PILE_REACH), usedAt: 0,
    };
  };

  /** Free the meshes that have not been drawn for a while, beyond the few most recent. */
  const sweep = () => {
    const now = performance.now();
    for (const [shape, geometry] of geometries) {
      if (geometries.size <= KEPT_MESHES) return;
      if (now - geometry.usedAt < IDLE_MS) continue;
      gl.deleteVertexArray(geometry.surface);
      gl.deleteVertexArray(geometry.strands);
      geometry.buffers.forEach((b) => gl.deleteBuffer(b));
      geometries.delete(shape);
    }
    // Stills paint once: without another frame, nothing else would come back for theirs.
    if (!sweepPending) {
      sweepPending = true;
      setTimeout(() => {
        sweepPending = false;
        sweep();
      }, IDLE_MS);
    }
  };

  const geometryOf = (shape: FluffyShape): Geometry => {
    let geometry = geometries.get(shape);
    if (geometry) geometries.delete(shape);
    else geometry = upload(shape);
    // Most recently drawn last.
    geometries.set(shape, geometry);
    geometry.usedAt = performance.now();
    if (geometries.size > KEPT_MESHES) sweep();
    return geometry;
  };

  // --- Eyes ---------------------------------------------------------------------------------------

  const regions = new Float32Array(8), sizes = new Float32Array(4);
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = SOCKET_TILE;
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;
  /** Distance tiles by contour: both eyes usually share one, and an avatar returns to the same few. */
  const tiles = new Map<string, Uint8Array<ArrayBuffer>>();
  const tileOf = (mark: EyeMark, key: string) => {
    let tile = tiles.get(key);
    if (!tile) {
      tile = socketTile(scratchCtx, mark);
      if (tiles.size >= 48) tiles.delete(tiles.keys().next().value!);
      tiles.set(key, tile);
    }
    return tile;
  };

  // --- What the canvas shows, and what is on the GPU ----------------------------------------------

  const readColor = colorReader();
  const shown = {
    geometry: null as Geometry | null, view: null as ViewBasis | null, pixels: 0, color: '', ink: '', finish: '',
    regions: new Float32Array(8), contours: ['', ''],
  };
  let dye = '';

  return (shape, view, look, scale) => {
    if (gl.isContextLost()) return null;
    const geometry = geometryOf(shape);
    const { cx, cy, radius } = geometry;
    const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, Math.ceil(2 * radius * scale)));
    // Avatars of different sizes take turns in the canvas: it only grows, since resizing it
    // allocates its buffers anew. Each image sits in the corner WebGL counts from, the lower left.
    if (canvas.width < pixels) canvas.width = canvas.height = pixels;
    const image = { canvas, x: 0, y: canvas.height - pixels, size: pixels, cx, cy, radius };
    const finish = look.finish ?? 'fluffy';

    // The sockets: where each eye is, and its contour's distance tile.
    const eyeZ = 'eyeZ' in shape ? shape.eyeZ : [];
    regions.fill(0);
    const contours = ['', ''];
    look.eyes.forEach(({ mark, dx, dy }, slot) => {
      const region = socketRegion(mark);
      regions.set([region.cx + dx, region.cy + dy, region.span, eyeZ[slot] + SOCKET_RISE], 4 * slot);
      sizes.set([region.w, region.h * exposedHeight(region.w, region.h)], 2 * slot);
      contours[slot] = socketKey(mark);
    });

    // Root motion is composited by the painter, so only a turn of the surface or a change of
    // look needs a new image.
    const turn = shown.view
      ? Math.abs(view.cY - shown.view.cY) + Math.abs(view.sY - shown.view.sY) + Math.abs(view.sP - shown.view.sP) + Math.abs(view.cP - shown.view.cP)
      : Infinity;
    if (
      shown.geometry === geometry && shown.pixels === pixels && shown.color === look.color && shown.ink === look.ink && shown.finish === finish &&
      contours.every((key, slot) => key === shown.contours[slot]) && regions.every((value, i) => value === shown.regions[i]) &&
      turn < SAME_VIEW / (radius * scale)
    ) {
      return image;
    }
    shown.geometry = geometry;
    shown.view = view;
    shown.pixels = pixels;
    shown.color = look.color;
    shown.ink = look.ink;
    shown.finish = finish;
    gl.uniform1i(u.finish, FINISH[finish]);
    shown.regions.set(regions);

    look.eyes.forEach(({ mark }, slot) => {
      if (contours[slot] === shown.contours[slot]) return;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, slot * SOCKET_TILE, 0, SOCKET_TILE, SOCKET_TILE, gl.RED, gl.UNSIGNED_BYTE, tileOf(mark, contours[slot]));
    });
    shown.contours = contours;
    gl.uniform4fv(u.eyeRegion, regions);
    gl.uniform2fv(u.eyeSize, sizes);

    const [r, g, b] = readColor(look.color);
    gl.uniform3f(u.color, r / 255, g / 255, b / 255);
    if (dye !== look.color) {
      gl.activeTexture(gl.TEXTURE3);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DYE_RAMP_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, dyeRamp([r, g, b]));
      gl.activeTexture(gl.TEXTURE1);
      dye = look.color;
    }
    const [inkR, inkG, inkB] = readColor(look.ink);
    gl.uniform3f(u.ink, inkR / 255, inkG / 255, inkB / 255);

    gl.uniform3f(u.pivot, cx, cy, 0);
    gl.uniform3fv(u.extent, geometry.extent);
    gl.uniform1f(u.radius, radius);
    // Rotation by yaw, then pitch, as columns.
    gl.uniformMatrix3fv(u.view, false, [view.cY, view.sY * view.sP, -view.sY * view.cP, 0, view.cP, view.sP, view.sY, -view.cY * view.sP, view.facing]);

    gl.viewport(0, 0, pixels, pixels);
    // The painter smooths the image as it scales it, blending in the pixels just past its edge:
    // clear those too, or a larger avatar's image from before shows as a line along its top and right.
    const cleared = Math.min(canvas.width, pixels + EDGE_PIXELS);
    gl.scissor(0, 0, cleared, cleared);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { shells, strandPasses, fineSockets } = fluffyDetail(scale);
    const triangles = fineSockets ? geometry.fine : geometry.coarse;
    gl.bindVertexArray(geometry.surface);
    gl.uniform1i(u.pass, PASS.body);
    gl.drawElements(gl.TRIANGLES, triangles.count, gl.UNSIGNED_INT, 4 * triangles.start);
    if (finish !== 'fluffy') return image;
    gl.uniform1i(u.pass, PASS.shell);
    for (let layer = 1; layer <= shells; layer++) {
      gl.uniform1f(u.shell, layer / shells);
      gl.drawElements(gl.TRIANGLES, triangles.count, gl.UNSIGNED_INT, 4 * triangles.start);
    }
    gl.bindVertexArray(geometry.strands);
    gl.uniform1i(u.pass, PASS.strand);
    gl.uniform1f(u.strandWidth, ROOT_PASSES / strandPasses);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 8, rootsIn(geometry.strandCount, strandPasses));
    return image;
  };
}

let renderer: Renderer | null | undefined;

/**
 * Render `shape` under `view` at `scale` pixels per viewBox unit. Null where fluffy can't be
 * drawn (no WebGL2, or its context is lost): the caller paints flat instead.
 */
export function renderFluffy(shape: FluffyShape, view: ViewBasis, look: FluffyLook, scale: number): FluffyImage | null {
  if (renderer === undefined) {
    renderer = null;
    try {
      // After a restore everything on the GPU is gone: start over on the next frame.
      renderer = createRenderer(() => (renderer = undefined));
    } catch (error) {
      console.warn('open-bot-avatar: fluffy is unavailable, drawing flat', error);
    }
  }
  return renderer?.(shape, view, look, scale) ?? null;
}
