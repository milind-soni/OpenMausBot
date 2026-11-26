/**
 * The fluffy shaders. One program draws three kinds of geometry, chosen by `pass`: the body's
 * solid surface with the eyes seated in it, shells of pile lifted off that surface, and single
 * strands on top. All three sample the same model-space pile, so the coat holds together as the
 * avatar turns.
 */
import { DYE_RAMP_RANGE } from './dye.ts';
import { SOCKET_PAD } from './socket.ts';

/** The values of the `pass` uniform. */
export const PASS = { body: 0, shell: 1, strand: 2 } as const;

/** MausBot: the values of the `finish` uniform. Matte and metallic draw the body pass alone. */
export const FINISH = { fluffy: 0, matte: 1, metallic: 2 } as const;

/** A number as a GLSL float literal. */
const float = (n: number) => (Number.isInteger(n) ? `${n}.` : `${n}`);

const passes = `const int BODY = ${PASS.body}, SHELL = ${PASS.shell}, STRAND = ${PASS.strand};`;

// Distance to the nearer eye's contour, viewBox units, from the eyes' distance tiles (see
// socket.ts). Coordinates stay on the avatar's front surface, so a socket turns with the head.
const socketField = `
uniform highp sampler2D eyeField;
uniform vec4 eyeRegion[2]; // face-plane center, square span, maximum host depth
uniform vec2 eyeSize[2];
const float FAR = ${float(SOCKET_PAD)};

float socketDistance(vec3 p, vec3 normal, out vec2 uv, out vec3 local) {
  uv = vec2(0.);
  local = vec3(0.);
  if (normal.z < .03 || p.z < -.05) return FAR;
  for (int i = 0; i < 2; i++) {
    vec4 e = eyeRegion[i];
    vec2 delta = p.xy - e.xy;
    if (e.z > 0. && p.z <= e.w && max(abs(delta.x), abs(delta.y)) < e.z * .49) {
      vec2 coords = delta / e.z;
      vec2 sampleUV = (coords + .5 + vec2(float(i), 0.)) * vec2(.5, 1.);
      float d = (textureLod(eyeField, sampleUV, 0.).r - .5) * ${float(2 * SOCKET_PAD)};
      if (d >= 3.77) continue;
      uv = sampleUV;
      local.xy = 2. * delta / max(eyeSize[i], vec2(.01));
      // As lids close, the pressed lip narrows with the expression.
      local.z = smoothstep(.35, 1.5, eyeSize[i].y / max(.01, eyeSize[i].x));
      return d * mix(1.5, 1., local.z);
    }
  }
  return FAR;
}`;

// MausBot: the body with no pile. `d` is the distance to the nearer eye's contour.
const bareSurface = `
vec3 bareSurface(vec3 n, vec3 light, float d) {
  float lambert = dot(n, light);
  float socket = 1. - smoothstep(-.1, 1.7, d);
  if (finish == ${FINISH.matte}) {
    // Clay: light wraps far round the body, and nothing shines.
    float wrap = clamp((lambert + .8) / 1.8, 0., 1.);
    float sky = .5 - .5 * n.y;
    vec3 lit = color * (.66 + .40 * wrap * wrap + .05 * sky);
    // Shadows keep their hue: darker, not greyer.
    lit = mix(lit * lit, lit, .55 + .45 * wrap);
    return lit * (1. - .22 * socket);
  }
  // Polished metal: the body color tints everything it reflects. The surroundings are looked up
  // by the normal, not the mirrored view: a flat front face would otherwise swing from sky to
  // ground with every small turn.
  float up = -n.y;
  // A light body (all three channels high) would mirror the white page: soften its horizon,
  // narrow its range and darken its rim so it reads as silver, not as a hole in the page.
  float pale = smoothstep(.62, .92, min(color.r, min(color.g, color.b)));
  float sky = mix(1., .58, smoothstep(.08, .95, up));
  float ground = mix(.46, .68, smoothstep(.12, .95, -up));
  float surroundings = mix(ground, sky, smoothstep(mix(-.24, -.75, pale), mix(.08, .50, pale), up));
  surroundings = mix(surroundings, .70, .40 * pale);
  float fresnel = pow(1. - clamp(n.z, 0., 1.), 3.);
  vec3 tint = mix(color, vec3(1.), (.10 + .45 * fresnel) * (1. - .6 * pale));
  vec3 metal = tint * (.14 + .20 * clamp(lambert, 0., 1.) + .90 * surroundings);
  vec3 halfway = normalize(light + vec3(0., 0., 1.));
  float highlight = pow(clamp(dot(n, halfway), 0., 1.), 48.);
  metal += mix(color, vec3(1.), .75) * (.85 * highlight + .22 * fresnel * (1. - .7 * pale));
  metal *= 1. - .28 * pale * fresnel;
  return metal * (1. - .30 * socket);
}`;

export const vertexShader = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 seed;
uniform mat3 view;
uniform vec3 pivot, extent;
uniform float radius, shell;
uniform float strandWidth; // 1 at full detail; wider where fewer strands are drawn
uniform int pass;
out vec3 P, N, V, pilePosition, lean;
out float tip, variation, across, pocketDepth;
${passes}
${socketField}

void main() {
  vec3 n = normalize(normal), p = position;
  vec3 rounded = (position - pivot) / extent;
  // Broadly bend the lighting normals across flat front faces of inflated paths.
  vec3 shadingNormal = normalize(n + .78 * rounded);
  pilePosition = position;
  // Sweep across the visible surface. A downwards bias keeps the front from parting at a point.
  // Project without normalizing, so foreshortened locks get shorter continuously at a grazing angle.
  float wave = .21 * sin(dot(position, vec3(.11, .045, .08))) + .14 * sin(.13 * position.y - .07 * position.z);
  float angle = .22 + .94 * (view * shadingNormal).x + wave;
  vec3 sweep = transpose(view) * vec3(sin(angle), cos(angle), .18);
  lean = sweep - n * dot(n, sweep);

  vec2 uv;
  vec3 local;
  float d = socketDistance(position, n, uv, local);
  float seat = min(1.55, max(0., position.z) * .40);
  // The rounded cap sits below the packed pile at the mouth of the socket. At grazing angles the
  // near lip progressively hides the bead.
  float dome = sqrt(max(0., 1. - dot(local.xy, local.xy)));
  float cap = mix(smoothstep(0., 1.3, -d), dome, local.z) * smoothstep(-.15, .38, -d);
  float floorDepth = 1. - smoothstep(-.15, 1.65, d);
  p.z += seat * (.56 * cap - .98 * floorDepth);
  // Compressed fibers lie along the lip. The packed undercoat fills most of their height here, so
  // the opening has a continuous, softly fuzzy edge.
  float loft = mix(.07, 1., smoothstep(.75, 3.7, d));
  float lip = smoothstep(-.10, 1., d) * (1. - smoothstep(1., 2.85, d));
  if (pass == BODY) p.z += seat * .15 * lip;
  pilePosition.z = p.z;

  tip = 0.;
  variation = .5;
  across = 0.;
  if (pass == SHELL) {
    p += n * shell * 1.10 * loft;
    p += lean * (1.05 * shell * loft);
  }
  if (pass == STRAND) {
    // Four cross-sections make a bent, tapered strand. Roots are fixed in model space.
    tip = float(gl_VertexID / 2) / 3.;
    across = float(gl_VertexID % 2) * 2. - 1.;
    vec3 tangent = normalize(cross(n, abs(n.y) < .93 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
    vec3 bitangent = cross(n, tangent);
    float flow = 2.3 * sin(.24 * p.x + .13 * p.z + sin(.22 * p.y)) + 1.3 * sin(.32 * p.y - .15 * p.x);
    float angle = flow + (seed.x - .5) * 2.6;
    vec3 comb = lean + .24 * (tangent * cos(angle) + bitangent * sin(angle));
    if (d < 3.5) {
      // Around a socket the strands lie along its edge.
      vec2 radial = normalize(local.xy * vec2(1.7, 1.) + vec2(.001));
      vec2 alongEdge = vec2(-radial.y, radial.x);
      comb.xy = mix(comb.xy, alongEdge * (dot(comb.xy, alongEdge) < 0. ? -1. : 1.), .88 * (1. - smoothstep(.4, 3.5, d)));
    }
    vec3 bend = cross(n, comb);
    float len = mix(1.6, 3.8, seed.y) * loft;
    vec3 direction = n * (.30 + .18 * tip) + comb * (.93 - .12 * tip) + bend * (seed.x - .5) * .45 * tip;
    pilePosition += comb * (.7 * len * tip);
    p += n * .52 * loft;
    float width = (.073 + .11 * seed.y) * strandWidth;
    p += .065 * n + len * tip * direction;
    vec3 screenDir = view * (direction + .06 * comb);
    vec2 widthDir = normalize(vec2(-screenDir.y, screenDir.x) + vec2(.0001, 0));
    p += transpose(view) * vec3(widthDir * across * width * (1. - .94 * tip), 0);
    shadingNormal = normalize(shadingNormal + .19 * comb);
    variation = seed.x;
  }

  vec3 projected = view * (p - pivot);
  pocketDepth = dot(position - p, n) / max(.01, seat);
  // Test displaced shells and strand tips in the socket's model-space footprint. Their visibility
  // against the bead follows actual depth.
  P = vec3(p.xy, position.z);
  N = view * shadingNormal;
  V = normal;
  gl_Position = vec4(projected.x, -projected.y, -projected.z, radius) / radius;
}`;

export const fragmentShader = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D pile;
uniform sampler2D dyeRamp;
uniform highp sampler3D brushedPile;
uniform vec3 color, ink;
uniform mat3 view;
uniform int pass, finish;
uniform float shell;
in vec3 P, N, V, pilePosition, lean;
in float tip, variation, across, pocketDepth;
out vec4 result;
${passes}
${socketField}

float fiberMap(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(5.));
  w /= max(.001, w.x + w.y + w.z);
  return dot(w, vec3(texture(pile, p.zy / 16.).r, texture(pile, p.xz / 16.).r, texture(pile, p.xy / 16.).r));
}

// Sample the same model-space roots at every view: only the direction of the short filter
// changes. The solid coat, the shells and the strands all use this one field.
float brushedHeight() {
  vec3 uvw = pilePosition / 15.;
  vec3 stepUV = lean * .019;
  float locks = 4. * texture(brushedPile, uvw).r;
  for (int i = 1; i <= 3; i++) {
    vec3 delta = float(i) * stepUV;
    locks += (4. - float(i)) * (texture(brushedPile, uvw + delta).r + texture(brushedPile, uvw - delta).r);
  }
  float tuft = texture(brushedPile, uvw * .42).r;
  return clamp(.5 + 1.65 * (locks / 16. - .5) + .16 * (tuft - .5), 0., 1.);
}

${bareSurface}

void main() {
  vec3 n = normalize(N);
  vec3 light = normalize(vec3(-.52, -.83, .62));
  float diffuse = dot(n, light);
  float wrap = clamp((diffuse + .65) / 1.65, 0., 1.);
  float facingLight = clamp(.66 + .34 * diffuse, 0., 1.);
  float diffuseLevel = .87 + .13 * wrap;
  float sheen = .014 * wrap * wrap;
  float rimExposure = 1.;

  // Pile gives way to the eye.
  vec2 uv;
  vec3 local;
  float d = socketDistance(P, normalize(V), uv, local);
  if (pass == SHELL && d < .1) discard;
  if (pass == STRAND && d < .10 - .08 * variation) discard;

  float height = brushedHeight();
  // Density variation survives rim lighting even when the strongest dye channel is saturated.
  float pileFill = .925 + .075 * smoothstep(.22, .81, height);
  if (pass == STRAND) {
    // MSAA can evaluate a subpixel ribbon outside its edges at the pixel center.
    float edge = min(1., abs(across));
    float glint = smoothstep(.08, .82, tip) * (1. - .32 * edge * edge);
    diffuseLevel *= .935 + .11 * variation + .035 * clamp(tip, 0., 1.);
    sheen += (.012 + .20 * glint) * (.44 + .56 * variation) * facingLight;
  } else {
    float layer = pass == SHELL ? shell : 0.;
    // A shell keeps only the locks that reach its height.
    if (pass == SHELL && height < .21 + .59 * layer) discard;
    // The solid backing is dyed as brightly as the roots. Relief is mostly from the softly lit
    // crests of neighboring locks.
    diffuseLevel *= .895 + .16 * height + .035 * layer;
    sheen += (.012 + .13 * smoothstep(.41, .86, height) + .022 * layer) * facingLight;
    rimExposure = .80 + .34 * layer;
  }

  // A soft light behind the right shoulder grazes the pile. Weighting by view angle confines it
  // to the silhouette as the avatar turns.
  float grazing = 1. - smoothstep(.09, .83, abs(n.z));
  float backlit = smoothstep(-.20, .79, dot(n.xy, vec2(.66, -.75)));

  // Around a socket: a crease where the pile is pressed down, and light on its rolled lip.
  float upper = 0., crease = 0., pileRelief = 0., contact = 0., lipLight = 0.;
  if (d < 3.7) {
    vec2 texel = 1. / vec2(textureSize(eyeField, 0));
    vec2 g = vec2(texture(eyeField, uv + vec2(texel.x, 0)).r - texture(eyeField, uv - vec2(texel.x, 0)).r,
                  texture(eyeField, uv + vec2(0, texel.y)).r - texture(eyeField, uv - vec2(0, texel.y)).r);
    vec2 outward = g / max(length(g), .001);
    upper = dot(outward, normalize(vec2(.96, -.28)));
    float fibers = fiberMap(P, normalize(V));
    // Only material below the mouth picks up the deep socket color. Tips which cover the eye in
    // profile keep the dye of the exposed coat.
    float buried = smoothstep(-.12, .82, pocketDepth);
    crease = (1. - smoothstep(-.12, 1.65 + 1.30 * upper + .6 * (fibers - .5), d)) * mix(.24, 1., buried);
    if (pass == STRAND) {
      // The rolled lip reveals brighter tips above a darker, compressed undercoat.
      pileRelief = ((tip - .46) * .16 + (fibers - .48) * .11) * (1. - smoothstep(1.5, 3.65, d));
    }
    contact = (1. - smoothstep(-.04, .38, d)) * mix(.35, 1., buried);
    float lip = smoothstep(.03, .49, d) * (1. - smoothstep(1.10, 3.65, d));
    float gathered = clamp(.22 - .52 * outward.x + 1.14 * outward.y, 0., 1.22);
    float tipLight = .14 + .22 * fibers;
    lipLight = tipLight * gathered * lip * mix(.40, 1., local.z);
  }
  float occlusion = crease * (.76 + .18 * upper);
  float fiberLight = (sheen + .46 * grazing * backlit * rimExposure) * (1. - crease) + lipLight;
  diffuseLevel = (diffuseLevel * (1. - .48 * occlusion) + pileRelief) * (1. - (.36 + .04 * upper) * contact);

  // Light falling on the body reveals its curvature. Light caught by raised fibers can carry on
  // above the nominal exposure of the dye.
  float backing = diffuseLevel * pileFill;
  float exposure = backing * backing * (.72 + .39 * wrap) + 1.45 * fiberLight * pileFill;
  vec4 ramp = texture(dyeRamp, vec2(exposure / ${float(DYE_RAMP_RANGE)}, .5));
  vec3 base = ramp.rgb;
  if (ramp.a > 0.) {
    // On yellow, the dyed roots and the light scattered by the tips can have the same lightness
    // and still differ in color.
    float value = max(color.r, max(color.g, color.b));
    vec3 dye = color / max(value, .001);
    float weakest = min(dye.r, min(dye.g, dye.b));
    vec3 scatter = (1. - dye) * (.09 + .91 * (dye - weakest)) * clamp(1.85 * fiberLight, 0., 1.);
    float brightness = clamp(value * diffuseLevel + (.35 + .65 * value) * fiberLight, 0., 1.);
    base = mix(base, (dye + scatter) * brightness * pileFill, ramp.a);
  }

  if (finish != ${FINISH.fluffy}) base = bareSurface(n, light, d);

  if (pass == BODY && d < 3.7) {
    // The eye: a glossy bead in the socket.
    vec2 curve = local.xy * .94;
    vec3 dome = normalize(vec3(curve, sqrt(max(.02, 1. - dot(curve, curve)))));
    vec3 beadNormal = normalize(view * dome);
    // The high strip reflects mostly the light source. The softer side fill picks up more of the
    // nearby coat as the bead turns.
    vec2 key = beadNormal.xy - vec2(.59, -.865);
    key = vec2(key.x - .76 * key.y, key.y) / vec2(.55, .70);
    vec2 fill = beadNormal.xy - vec2(.61, -.195);
    fill = vec2(fill.x - .37 * fill.y, fill.y) / vec2(.47, 1.01);
    float stripLight = .38 * exp(-dot(key, key));
    float sideLight = .13 * exp(-dot(fill, fill));
    float coatBounce = .003 + .018 * pow(1. - clamp(beadNormal.z, 0., 1.), 1.6);
    float inkValue = max(ink.r, max(ink.g, ink.b));
    vec3 bead = ink * sqrt(inkValue) * (.40 + .24 * beadNormal.z + .24 * inkValue) + color * coatBounce;
    vec3 reflection = mix(vec3(1.), color, .28) * stripLight + mix(vec3(1.), color, .72) * sideLight;
    bead += reflection * smoothstep(-.12, .55, -d);
    float aa = max(.15, fwidth(d));
    base = mix(bead, base, smoothstep(-aa * .5, aa * .5, d));
  }
  result = vec4(base, 1.);
}`;
