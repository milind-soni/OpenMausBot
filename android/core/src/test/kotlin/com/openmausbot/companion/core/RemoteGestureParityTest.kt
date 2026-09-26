package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The parity harness.
 *
 * Both platforms run the same fixture file, so a behaviour added on one and
 * not the other fails here rather than in a bug report six weeks later. The
 * file itself lives with the iOS tests and is copied onto this module's test
 * classpath by a Gradle task, so there is exactly one copy to edit.
 */
class RemoteGestureParityTest {
    @Serializable
    data class ParitySuite(val cases: List<ParityCase>)

    @Serializable
    data class ParityCase(
        val name: String,
        val mode: GestureMode,
        val view: List<Double>,
        val frame: List<Double>,
        val driving: Boolean,
        val steps: List<ParityStep>,
        val expect: List<ParityIntent>,
    )

    @Serializable
    data class ParityStep(val touch: TouchSample? = null, val tick: Double? = null)

    /** The fixture's shape, decoded structurally rather than through
     * GestureIntent's polymorphic serializer: one object with exactly one of
     * these keys set, which is what the iOS coder writes. */
    @Serializable
    data class ParityIntent(
        val move: Point? = null,
        val press: Press? = null,
        val release: Release? = null,
        val scroll: Delta? = null,
        val text: String? = null,
        val key: Key? = null,
    )

    @Serializable
    data class Point(val x: Double, val y: Double)

    @Serializable
    data class Delta(val dx: Double, val dy: Double)

    @Serializable
    data class Press(val button: RemoteButton, val clicks: Int)

    @Serializable
    data class Release(val button: RemoteButton)

    @Serializable
    data class Key(val name: String, val modifiers: Int)

    @Test
    fun everyFixtureCaseProducesItsDocumentedIntents() {
        val suite = loadSuite()
        assertTrue(suite.cases.isNotEmpty(), "an empty fixture would pass without proving anything")

        for (case in suite.cases) {
            val core = GestureCore(
                case.mode,
                ViewportMapping(
                    case.view[0], case.view[1],
                    case.frame[0], case.frame[1],
                    ViewTransform.IDENTITY,
                ),
            )
            core.driving = case.driving

            val produced = buildList {
                for (step in case.steps) {
                    step.touch?.let { addAll(core.handle(it)) }
                    step.tick?.let { addAll(core.tick(it)) }
                }
            }

            assertEquals(case.expect.size, produced.size, "${case.name}: $produced")
            case.expect.forEachIndexed { index, expected ->
                assertTrue(
                    matches(produced[index], expected),
                    "${case.name} step $index: ${produced[index]} is not $expected",
                )
            }
        }
    }

    /** The fixture must be reachable, and its absence must fail loudly rather
     * than silently testing nothing. */
    @Test
    fun theFixtureIsOnTheTestClasspath() {
        assertTrue(loadSuite().cases.isNotEmpty())
    }

    private fun loadSuite(): ParitySuite {
        val stream = checkNotNull(javaClass.getResourceAsStream("/gesture-parity.json")) {
            "gesture-parity.json is not on the test classpath — check the copy task in core/build.gradle.kts"
        }
        return Json { ignoreUnknownKeys = true }
            .decodeFromString<ParitySuite>(stream.bufferedReader().readText())
    }

    /** Compared with tolerance, never equality. Normalising a coordinate
     * through a division yields -0.09999999999999998 and a signed -0.0, and
     * Kotlin and Swift will not round identically — an exact match would make
     * the parity gate fail on arithmetic instead of on behaviour. */
    private fun matches(produced: GestureIntent, expected: ParityIntent): Boolean {
        val tolerance = 0.0001
        return when (produced) {
            is GestureIntent.Move -> expected.move?.let {
                abs(produced.x - it.x) < tolerance && abs(produced.y - it.y) < tolerance
            } ?: false

            is GestureIntent.Scroll -> expected.scroll?.let {
                abs(produced.dx - it.dx) < tolerance && abs(produced.dy - it.dy) < tolerance
            } ?: false

            is GestureIntent.Press -> expected.press?.let {
                produced.button == it.button && produced.clicks == it.clicks
            } ?: false

            is GestureIntent.Release -> expected.release?.let { produced.button == it.button } ?: false

            is GestureIntent.Text -> produced.value == expected.text

            is GestureIntent.Key -> expected.key?.let {
                produced.name == it.name && produced.modifiers == it.modifiers
            } ?: false
        }
    }
}
