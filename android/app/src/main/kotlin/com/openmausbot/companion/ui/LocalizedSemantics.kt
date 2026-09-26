package com.openmausbot.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription

/** Resolve accessibility copy before entering SemanticsPropertyReceiver's non-composable lambda. */
@Composable
internal fun Modifier.localizedSemantics(
    mergeDescendants: Boolean = false,
    contentDescription: (@Composable () -> String)? = null,
    stateDescription: (@Composable () -> String)? = null,
): Modifier {
    val localizedContentDescription = contentDescription?.invoke()
    val localizedStateDescription = stateDescription?.invoke()
    return semantics(mergeDescendants = mergeDescendants) {
        localizedContentDescription?.let { this.contentDescription = it }
        localizedStateDescription?.let { this.stateDescription = it }
    }
}
