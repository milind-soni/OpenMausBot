package com.astra.companion.ui

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.vector.PathParser

/**
 * The mascot's body, as geometry: the per-body cache that turns [AstraBodies] into
 * something a canvas can fill — the port of `AstraSilhouette` in
 * `ios/Sources/CompanionCore/AstraSilhouette.swift`.
 *
 * This used to carry one hardcoded path, copied verbatim from the desktop. It now
 * reads ten generated ones from the catalog `scripts/gen-mascot-bodies.ts` emits,
 * which is what stops the phone's placement drifting from the desktop's: the face
 * anchor per body is solved once and written into all three renderers.
 *
 * The caching is the point. These are multi-kilobyte strings and a
 * character-at-a-time parser, and the shape each one produces never changes — but
 * a roster is hundreds of avatars, each redrawn on scroll. What is left per draw is
 * the affine fit into the rect, which is the only part that depends on where the
 * avatar is. The face the body wears is [AstraFaceData]; this is only the shape it is
 * painted on.
 */
internal object AstraSilhouette {
    /** The desktop's viewBox is `-15 -15 258.541 258.541`: room to bob and sway. */
    const val FACE_MARGIN: Float = 15f

    /**
     * The desktop's face box: the square every body's fit is solved into and every
     * face coordinate — the eye anchor, the mouth — is expressed in. Mirrors
     * [AstraFaceData.FACE_BOX], which is the same box seen from the artwork's side.
     */
    const val FACE_BOX: Float = AstraFaceData.FACE_BOX

    /** The shipped mascot, and what anything unrecognised falls back to. */
    val defaultBody: String get() = AstraBodies.DEFAULT_ID

    /** Where the face sits on a body, in face-box units — solved by the generator. */
    data class Anchor(val x: Float, val y: Float, val scale: Float)

    /** One body, parsed and placed, with the bounds the gradient runs across. */
    private class Placed(val path: Path, val bounds: Rect, val anchor: Anchor)

    private val cache = HashMap<String, Placed>()
    private val lock = Any()

    /** The chosen body in the desktop's face box, parsed once per body. */
    fun inFaceBox(id: String?): Path = placed(id).path

    /**
     * The body's own bounds inside the face box, for the gradient's corners. These
     * come from the catalog rather than the path: Android's native path bounds are
     * the cubic control hull, wider than the drawn shape, and the gradient has to
     * end on the shape to match the desktop and iOS pixel for pixel.
     */
    fun faceBoxBounds(id: String?): Rect = placed(id).bounds

    /** Where the face sits on this body. One catalog feeds every renderer. */
    fun anchor(id: String?): Anchor = placed(id).anchor

    private fun placed(id: String?): Placed {
        val body = AstraBodies.body(id)
        synchronized(lock) {
            cache[body.id]?.let { return it }
            // Scale first, then translate — the same order the generator solved.
            val fit = Matrix().apply {
                this[0, 0] = body.fitScale
                this[1, 1] = body.fitScale
                this[3, 0] = body.fitTx
                this[3, 1] = body.fitTy
            }
            val path = parse(body.path).apply { transform(fit) }
            val placed = Placed(
                path = path,
                bounds = Rect(body.left, body.top, body.right, body.bottom),
                anchor = Anchor(body.anchorX, body.anchorY, body.anchorScale),
            )
            cache[body.id] = placed
            return placed
        }
    }

    /**
     * SVG path data into a [Path]. The catalog is absolute `M`, `C` and `Z` with
     * newlines as separators, all of which Compose's parser reads.
     */
    internal fun parse(data: String): Path = PathParser().parsePathString(data).toPath()
}
