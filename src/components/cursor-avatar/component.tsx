/**
 * CursorAvatar — an animated mascot built on the "cursor" silhouette.
 *
 * Self-contained: React is the only dependency. Drop this file in and use it.
 *
 *   import CursorAvatar from './CursorAvatar'
 *
 *   <CursorAvatar state="thinking" silhouette={MASCOT_BODIES.cursor} size={160} />
 *
 * The state drives everything — which expressions cycle, how often, and when it blinks.
 * Set `state` and it animates itself; see CURSOR_STATES for the full list.
 *
 * Props of note:
 *   state        one of CURSOR_STATES
 *   expression   pin a single face and stop the cycling
 *   lookAround   how much each expression glances around. 0 = always straight ahead
 *   gaze / turn  aim the eyes, or rotate the head around its implied sphere
 *   showMouth    false for an eyes-only face
 *
 * Made with Blob Studio.
 */

import React, { useEffect, useId, useMemo, useRef } from 'react'

import {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
  type Ring,
} from '../cursor-face-data'
import { updateEffects } from './effects'
import { BLINK, EXPR_CADENCE, POOLS, mouthPath, type CursorState } from './expressions'
import { MOTION, SPHERE_C, SPHERE_R, VIEW_BOX, anchorTransform, bodyTransform } from './motion'
import { DEFAULT_GRADIENT, DEFAULT_SILHOUETTE, type CursorSilhouette } from './silhouette'

/* ------------------------------------------------------------------- maths */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const noTimestamp = (): number | null => null

const toPath = (ring: Ring) =>
  'M' + ring.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'

const clone = (rings: Ring[]): Ring[] =>
  rings.map(r => r.map((p): [number, number] => [p[0], p[1]]))

/** Ring centroid — same computation cursor-face-data.ts uses for mouthFrame, needed here too for eye projection. */
const ringCentre = (ring: Ring): [number, number] => {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

/* --------------------------------------------------------------- component */

export interface CursorAvatarProps {
  state?: CursorState
  /** Pin a specific expression. Stops the state's own cycling. */
  expression?: number
  size?: number | string
  /** Eye offset, each axis -1…1. */
  gaze?: { x?: number; y?: number }
  /** Head turn in degrees; the eyes wrap around the implied sphere. */
  turn?: number
  /** How much of each expression's own look-direction to apply. 0 = always forward. */
  lookAround?: number
  flip?: boolean
  spring?: number
  eyeScale?: number
  showMouth?: boolean
  mouthStroke?: number
  /** How strongly the body itself moves. 0 holds it perfectly still, 1 is full motion. */
  motion?: number
  /** Confetti and motion ribbons. */
  effects?: boolean
  /** Let states like alerting replace the mascot with a symbol. */
  glyphs?: boolean
  autoBlink?: boolean
  autoExpression?: boolean
  paused?: boolean
  /** Silhouette to wear. Defaults to the baked-in mascot silhouette. */
  silhouette?: CursorSilhouette
  gradient?: [string, string, string]
  eyeColor?: string
  title?: string | null
  className?: string
  style?: React.CSSProperties
}

export interface CursorAvatarHandle {
  blink: () => void
  spin: (durationMs?: number) => void
  setExpression: (index: number) => void
}

export const CursorAvatar = React.forwardRef<CursorAvatarHandle, CursorAvatarProps>(
  function CursorAvatar(
    {
      state = 'idle',
      expression,
      size = 160,
      gaze,
      turn = 0,
      lookAround = 0.5,
      flip = false,
      spring = 7,
      eyeScale = 1,
      showMouth = true,
      mouthStroke = MOUTH_STROKE,
      motion,
      effects = true,
      glyphs = true,
      autoBlink = true,
      autoExpression = true,
      paused = false,
      silhouette = DEFAULT_SILHOUETTE,
      gradient = DEFAULT_GRADIENT,
      eyeColor = "#ffffff",
      title,
      className,
      style,
    },
    ref
  ) {
    const reactId = useId()
    const uid = useMemo(() => 'mascot' + reactId.replace(/[^a-zA-Z0-9]/g, ''), [reactId])
    const eye0 = useRef<SVGPathElement | null>(null)
    const eye1 = useRef<SVGPathElement | null>(null)
    const mouth = useRef<SVGPathElement | null>(null)
    const bodyGroup = useRef<SVGGElement | null>(null)
    const bodyContent = useRef<SVGGElement | null>(null)
    const trailLayer = useRef<SVGGElement | null>(null)
    const confettiLayer = useRef<SVGGElement | null>(null)
    const glyphLayer = useRef<SVGGElement | null>(null)

    // Respect the OS setting unless the caller states a preference explicitly.
    const prefersReducedMotion = useMemo(
      () => globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      []
    )
    const motionStrength = motion ?? (prefersReducedMotion ? 0 : 1)
    const lastState: CursorState = state

    // Frame-loop state lives in a ref so prop changes never restart a morph.
    const engine = useRef({
      current: clone(EXPRESSIONS[0]),
      target: EXPRESSIONS[0],
      currentMouth: MOUTHS[0].slice(),
      targetMouth: MOUTHS[0],
      currentGaze: [...GAZE[0]],
      targetGaze: [...GAZE[0]],
      expression: 0,
      morph: 1,
      velocity: 0,
      blinkStart: noTimestamp(),
      spinStart: noTimestamp(),
      spinDuration: 900,
      last: 0,
      stateStart: 0,
      lastState,
      lastBodyTransform: '',
      // what the parked loop last painted; '' means "never" so a mascot that
      // mounts paused still gets its one resting-face paint
      pausedPaint: '',
      props: {
        state,
        expression,
        gaze,
        turn,
        spring,
        eyeScale,
        paused,
        lookAround,
        motionStrength,
        effects,
        glyphs,
      },
    })
    engine.current.props = {
      state,
      expression,
      gaze,
      turn,
      spring,
      eyeScale,
      paused,
      lookAround,
      motionStrength,
      effects,
      glyphs,
    }

    const selectExpression = (index: number) => {
      const e = engine.current
      const i = ((index % EXPRESSION_COUNT) + EXPRESSION_COUNT) % EXPRESSION_COUNT
      if (i === e.expression && e.morph >= 1) return
      e.current = displayed(e)
      e.currentMouth = displayedMouth(e)
      e.currentGaze = displayedGaze(e)
      e.target = EXPRESSIONS[i]
      e.targetMouth = MOUTHS[i]
      e.targetGaze = GAZE[i]
      e.expression = i
      e.morph = 0
      e.velocity = 0
    }

    React.useImperativeHandle(
      ref,
      () => ({
        blink: () => {
          engine.current.blinkStart = performance.now()
        },
        spin: (durationMs = 900) => {
          engine.current.spinDuration = durationMs
          engine.current.spinStart = performance.now()
        },
        setExpression: selectExpression,
      }),
      []
    )

    useEffect(() => {
      selectExpression(expression ?? POOLS[state][0])
    }, [state, expression])

    useEffect(() => {
      if (!autoExpression || expression !== undefined || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        const [lo, hi] = EXPR_CADENCE[state]
        timer = setTimeout(() => {
          const pool = POOLS[state]
          const alternatives = pool.filter(x => x !== engine.current.expression)
          selectExpression(
            alternatives.length
              ? alternatives[Math.floor(Math.random() * alternatives.length)]
              : pool[0]
          )
          tick()
        }, lo + Math.random() * (hi - lo))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoExpression, expression, paused])

    useEffect(() => {
      const cadence = BLINK[state]
      if (!autoBlink || !cadence || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        timer = setTimeout(() => {
          engine.current.blinkStart = performance.now()
          tick()
        }, cadence[0] + Math.random() * (cadence[1] - cadence[0]))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoBlink, paused])

    useEffect(() => {
      let frame = 0
      let wake: ReturnType<typeof setTimeout> | undefined
      engine.current.last = performance.now()

      const draw = (e: typeof engine.current, now: number, spinTurn: number) => {
        const p = e.props
        // Re-apply a fraction of this expression's own look-direction.
        const g = displayedGaze(e)
        const look = p.lookAround ?? 0.35
        const ox = g[0] * look
        const oy = g[1] * look
        const rings = displayed(e).map(ring =>
          ring.map((pt): [number, number] => [pt[0] + ox, pt[1] + oy])
        )
        const gx = clamp(p.gaze?.x ?? 0, -1, 1) * GAZE_TRAVEL.x
        const gy = clamp(p.gaze?.y ?? 0, -1, 1) * GAZE_TRAVEL.y
        const radians = (((p.turn ?? 0) + spinTurn) * Math.PI) / 180
        const base = p.eyeScale ?? 1
        const blink = blinkScale(e, now)

        rings.forEach((ring, index) => {
          const el = index === 0 ? eye0.current : eye1.current
          if (!el) return
          const c = ringCentre(ring)
          const baseLongitude = Math.asin(clamp((c[0] - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          el.setAttribute('d', toPath(ring))
          el.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              c[1] + gy
            ).toFixed(2)}) scale(${clamp(perspective * base, 0.02, 2.4).toFixed(4)} ${clamp(
              blink * base,
              0.02,
              2.4
            ).toFixed(4)}) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`
          )
          el.style.opacity = depth > 0.02 ? '1' : '0'
        })

        // Mouth: same sphere projection as the eyes, but blinking never touches it.
        const mouthEl = mouth.current
        if (mouthEl) {
          const spec = displayedMouth(e)
          const frameGeom = mouthFrame(rings, spec)
          const baseLongitude = Math.asin(clamp((frameGeom.x - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          mouthEl.setAttribute('d', mouthPath(frameGeom, spec))
          mouthEl.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              frameGeom.y + gy
            ).toFixed(2)}) scale(${clamp(perspective, 0.02, 2.4).toFixed(4)} 1) translate(${(
              -frameGeom.x
            ).toFixed(2)} ${(-frameGeom.y).toFixed(2)})`
          )
          mouthEl.style.opacity = depth > 0.02 ? '1' : '0'
        }

        // The body. One-shot entrances need time since the state began, so track that here
        // rather than in an effect — the loop already has the clock.
        const bodyEl = bodyGroup.current
        if (bodyEl) {
          if (p.state !== e.lastState) {
            e.lastState = p.state
            e.stateStart = now
          }
          const transform = bodyTransform(
            MOTION[p.state] ?? {},
            now - e.stateStart,
            p.motionStrength ?? 1
          )
          if (transform !== e.lastBodyTransform) {
            e.lastBodyTransform = transform
            if (transform) bodyEl.setAttribute('transform', transform)
            else bodyEl.removeAttribute('transform')
          }
        }

        updateEffects({
          trails: trailLayer.current,
          confetti: confettiLayer.current,
          glyph: glyphLayer.current,
          bodyContent: bodyContent.current,
          state: p.state,
          elapsed: now - e.stateStart,
          strength: p.motionStrength ?? 1,
          paint: paintRef.current,
          showEffects: p.effects !== false,
          showGlyphs: p.glyphs !== false,
        })
      }

      const step = (now: number) => {
        const e = engine.current
        const p = e.props
        // A paused mascot must not wake at display rate: re-arming BEFORE the
        // pause check once had N idle sidebar faces ticking at 60fps forever.
        // While paused, poll for unpause at 4Hz — but the resting face must
        // still be PAINTED: the SVG layers hold no expression until the first
        // draw, so a mascot that mounts paused would otherwise stay blank.
        // One draw per change of what the still face shows, then park.
        if (p.paused) {
          e.last = now
          const still = `${p.state}|${p.expression ?? ''}|${paintRef.current}`
          if (e.pausedPaint !== still) {
            e.pausedPaint = still
            draw(e, now, 0)
          }
          wake = setTimeout(() => {
            frame = requestAnimationFrame(step)
          }, 250)
          return
        }
        e.pausedPaint = ''
        frame = requestAnimationFrame(step)
        const dt = Math.min((now - e.last) / 1000, 0.1)
        e.last = now

        const f = p.spring ?? 7
        e.velocity += (-2 * f * e.velocity - f * f * (e.morph - 1)) * dt
        e.morph += e.velocity * dt
        if (!Number.isFinite(e.morph)) {
          e.morph = 1
          e.velocity = 0
        }

        let spinTurn = 0
        if (e.spinStart !== null) {
          const tt = (now - e.spinStart) / e.spinDuration
          if (tt >= 1) e.spinStart = null
          else spinTurn = 360 * tt
        }

        draw(e, now, spinTurn)
      }

      frame = requestAnimationFrame(step)
      return () => {
        cancelAnimationFrame(frame)
        if (wake !== undefined) clearTimeout(wake)
      }
    }, [])

    const paint = `url(#${uid}-grad)`
    const paintRef = useRef(paint)
    paintRef.current = paint

    const dimension = size.constructor === Number ? `${size}px` : size
    const label = title === undefined ? `${silhouette.name} mascot` : title
    const body = silhouette.body.replace(/\{\{GRADIENT\}\}/g, `url(#${uid}-grad)`)

    return (
      <svg
        viewBox={VIEW_BOX}
        width={dimension}
        height={dimension}
        className={className}
        style={style}
        role={label ? 'img' : undefined}
        aria-label={label ?? undefined}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <linearGradient id={`${uid}-grad`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="55%" stopColor={gradient[1]} />
            <stop offset="100%" stopColor={gradient[2]} />
          </linearGradient>
          {/* The fit goes on the clipPath itself: a <g> inside one is ignored by browsers,
              which is also why silhouette.clip is pre-flattened to bare shapes. */}
          <clipPath
            id={`${uid}-clip`}
            transform={silhouette.fit || undefined}
            dangerouslySetInnerHTML={{ __html: silhouette.clip }}
          />
        </defs>
        <g transform={flip ? `translate(${FACE_BOX} 0) scale(-1 1)` : undefined}>
          {/* Ribbons sit behind the mascot, confetti in front of it. */}
          <g ref={trailLayer} />
          {/* Body and face move together — the face is painted on the body, not floating
              in front of it, so a squash or a tilt has to carry both. The glyph rides the
              same motion but is not faded with them, since it replaces them. */}
          <g ref={bodyGroup}>
          <g ref={bodyContent}>
          <g transform={silhouette.fit || undefined} dangerouslySetInnerHTML={{ __html: body }} />
          <g clipPath={`url(#${uid}-clip)`}>
            <g transform={anchorTransform(silhouette.anchor)}>
              <path ref={eye0} fill={eyeColor} />
              <path ref={eye1} fill={eyeColor} />
              {showMouth && (
                <path
                  ref={mouth}
                  fill="none"
                  stroke={eyeColor}
                  strokeWidth={mouthStroke}
                  strokeLinecap="round"
                />
              )}
            </g>
          </g>
          </g>
          <g ref={glyphLayer} style={{ opacity: 0 }} />
          </g>
          <g ref={confettiLayer} />
        </g>
      </svg>
    )
  }
)

/* ----------------------------------------------------------------- helpers */

function displayed(e: { current: Ring[]; target: Ring[]; morph: number }): Ring[] {
  const m = clamp(e.morph, 0, 1)
  return e.current.map((ring, eye) =>
    ring.map((p, i): [number, number] => [
      p[0] + (e.target[eye][i][0] - p[0]) * m,
      p[1] + (e.target[eye][i][1] - p[1]) * m,
    ])
  )
}

function displayedMouth(e: { currentMouth: number[]; targetMouth: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentMouth.map((v, i) => v + (e.targetMouth[i] - v) * m)
}

function displayedGaze(e: { currentGaze: number[]; targetGaze: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentGaze.map((v, i) => v + (e.targetGaze[i] - v) * m)
}

function blinkScale(e: { blinkStart: number | null }, now: number) {
  if (e.blinkStart === null) return 1
  const t = (now - e.blinkStart) / 320
  if (t >= 1) {
    e.blinkStart = null
    return 1
  }
  // Fast close, slower open.
  return Math.max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
}

export default CursorAvatar
