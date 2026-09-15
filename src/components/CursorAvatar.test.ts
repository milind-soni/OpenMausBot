import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CursorAvatar, FACE_BOX, MOTION, POOLS, bodyTransform, type CursorAvatarProps } from './CursorAvatar'

const render = (props: CursorAvatarProps) => renderToStaticMarkup(createElement(CursorAvatar, props))
const eyes = (markup: string) => Array.from(markup.matchAll(/<path[^>]*data-avatar-eye="[01]"[^>]* d="([^"]+)"/g), match => match[1])

describe('CursorAvatar resting face', () => {
  it('paints the chosen state before animation effects can run', () => {
    const sleeping = eyes(render({ state: 'sleeping', paused: true }))
    const surprised = eyes(render({ state: 'surprised', paused: true }))
    expect(sleeping).toHaveLength(2)
    expect(surprised).toHaveLength(2)
    expect(sleeping).not.toEqual(surprised)
    for (const path of [...sleeping, ...surprised]) {
      expect(path).toMatch(/^M.+Z$/)
      expect(path).not.toMatch(/NaN|Infinity/)
    }
  })

  it('uses a pinned expression instead of the habitual state face', () => {
    const pinned = eyes(render({ state: 'sleeping', expression: POOLS.surprised[0], paused: true }))
    expect(pinned).toEqual(eyes(render({ state: 'surprised', paused: true })))
    expect(pinned).not.toEqual(eyes(render({ state: 'sleeping', paused: true })))
  })

  it('keeps a visible mouth in a static preview unless the caller hides it', () => {
    expect(render({ state: 'happy', paused: true })).toMatch(/<path d="M[^"]+ Q[^"]+" fill="none"/)
    expect(render({ state: 'happy', paused: true, showMouth: false })).not.toContain('stroke-linecap="round"')
  })
})

describe('CursorAvatar body motion', () => {
  it('holds every state still when motion is disabled', () => {
    for (const motion of Object.values(MOTION)) {
      for (const elapsed of [0, 140, 820, 3000]) {
        expect(bodyTransform(motion, elapsed, 0)).toBe('')
      }
    }
  })

  it('starts an entrance small and settles at the original body size', () => {
    const entrance = { enter: [0.02, 820] as [number, number] }
    expect(bodyTransform(entrance, 0, 1)).toContain('scale(0.0200)')
    expect(bodyTransform(entrance, 820, 1)).toBe('')
    expect(bodyTransform(entrance, 5000, 1)).toBe('')
  })

  it('squashes against the ground so a landing carries the face with the body', () => {
    const landing = bodyTransform({ bob: [12, 560], squash: 0.45 }, 420, 1)
    expect(landing).toContain('translate(0.00 12.00)')
    expect(landing).toContain(`translate(${FACE_BOX / 2} ${FACE_BOX}) scale(1.2250 0.7750)`)
  })

  it('keeps every authored motion finite throughout its cycle', () => {
    for (const motion of Object.values(MOTION)) {
      for (const elapsed of [0, 16, 140, 420, 820, 1400, 5000]) {
        expect(bodyTransform(motion, elapsed, 1)).not.toMatch(/NaN|Infinity/)
      }
    }
  })
})
