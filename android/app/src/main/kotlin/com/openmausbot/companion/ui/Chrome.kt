package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The one material the floating chrome is made of — where `ios/App/Glass.swift`
 * sits in the port, done the way Android does it.
 *
 * iOS floats its bars on real glass: Liquid Glass on iOS 26, `.ultraThinMaterial`
 * before that, both of which refract whatever scrolls beneath. Android has no
 * counterpart this app can use. The only backdrop blur the platform offers is
 * `RenderEffect`, which `androidx.compose.ui.graphics.BlurEffect` gates at
 * `SDK_INT >= 31`; this app starts at 26, so five API levels would get no chrome
 * at all. Blurring by hand instead — capturing the backdrop into a layer every
 * frame, over a roster of animated mascots — buys a look at the price of the
 * scroll, which is the wrong trade on a list.
 *
 * So the chrome is not translucent at all. It is what a Material app floats over
 * a list: an opaque `surfaceContainerHigh` tile with a real elevation shadow, in
 * the shape of the control. That reads as a native app rather than a transplanted
 * one, it is legible over any content by construction, it looks the same on API
 * 26 and on 37, and it costs nothing in the draw phase — `shadow` and `background`
 * both cache their outline against size, layout direction and shape.
 */

/** Below this, a control is hard to hit; Android asks for 48 dp either way. */
internal val MIN_TOUCH_TARGET: Dp = 48.dp

private val CHROME_ELEVATION: Dp = 3.dp

/** A capsule of chrome — pills and round buttons. */
@Composable
internal fun Modifier.chromeCapsule(elevation: Dp = CHROME_ELEVATION): Modifier =
    chrome(CircleShape, elevation)

/** A rounded sheet of chrome. */
@Composable
internal fun Modifier.chromeSheet(cornerRadius: Dp = 28.dp, elevation: Dp = 6.dp): Modifier =
    chrome(RoundedCornerShape(cornerRadius), elevation)

@Composable
internal fun Modifier.chrome(shape: Shape, elevation: Dp = CHROME_ELEVATION): Modifier = this
    .shadow(elevation, shape, clip = false)
    .background(MaterialTheme.colorScheme.surfaceContainerHigh, shape)

/**
 * A round chrome button with one glyph — the shape of every action in the chrome
 * that is not a pill.
 *
 * The tile keeps the size the design draws it at; the clickable area around it is
 * always at least [MIN_TOUCH_TARGET], so a 44 dp tile does not hand back a target
 * Android considers too small.
 */
@Composable
internal fun ChromeButton(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    glyph: Dp = 20.dp,
    enabled: Boolean = true,
    tint: Color = Color.Unspecified,
) {
    ChromeButton(modifier, size, enabled, onClick) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint,
            modifier = Modifier.size(glyph),
        )
    }
}

/** The same button for a glyph the core icon set does not carry. */
@Composable
internal fun ChromeButton(
    painter: Painter,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    glyph: Dp = 20.dp,
    enabled: Boolean = true,
    tint: Color = Color.Unspecified,
) {
    ChromeButton(modifier, size, enabled, onClick) {
        Icon(
            painter = painter,
            contentDescription = contentDescription,
            tint = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint,
            modifier = Modifier.size(glyph),
        )
    }
}

@Composable
private fun ChromeButton(
    modifier: Modifier,
    size: Dp,
    enabled: Boolean,
    onClick: () -> Unit,
    glyph: @Composable () -> Unit,
) {
    // No description on the target: the glyph inside carries it, and `clickable`
    // merges its descendants, so naming it twice is how a control gets read twice.
    TouchTarget(modifier = modifier, size = size, enabled = enabled, onClick = onClick) {
        Box(
            modifier = Modifier
                .size(size)
                .chromeCapsule(),
            contentAlignment = Alignment.Center,
            content = { glyph() },
        )
    }
}

/**
 * Leaving a flat header — Settings and the screens it opens.
 *
 * The glyph keeps the 32 dp tile the header is drawn with; the target around it
 * is [MIN_TOUCH_TARGET], because a 32 dp target is one Android considers too
 * small to hit.
 */
@Composable
internal fun HeaderBackButton(onBack: () -> Unit, modifier: Modifier = Modifier) {
    TouchTarget(onClick = onBack, modifier = modifier, contentDescription = stringResource(R.string.mobile_back_b52b36b7)) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = null,
            modifier = Modifier
                .size(32.dp)
                .background(secondaryTint.copy(alpha = 0.16f), CircleShape)
                .padding(6.dp),
        )
    }
}

/**
 * A control drawn at [size] but hit at [MIN_TOUCH_TARGET]: the visual stays where
 * the design puts it while the target stays where Android's guidance puts it.
 *
 * [contentDescription] is for a target whose content says nothing on its own — a
 * bare glyph, a face. Where the content is already a labelled icon or a line of
 * text, leave it null and let that name the button.
 */
@Composable
internal fun TouchTarget(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = MIN_TOUCH_TARGET,
    enabled: Boolean = true,
    contentDescription: String? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = modifier
            .size(if (size > MIN_TOUCH_TARGET) size else MIN_TOUCH_TARGET)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .then(
                if (contentDescription == null) {
                    Modifier
                } else {
                    Modifier.semantics { this.contentDescription = contentDescription }
                },
            ),
        contentAlignment = Alignment.Center,
        content = content,
    )
}
