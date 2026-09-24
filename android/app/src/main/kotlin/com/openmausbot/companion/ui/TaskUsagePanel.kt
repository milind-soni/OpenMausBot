package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.TaskUsage
import java.text.NumberFormat
import java.util.Locale

/** Keep the provider's three token classes separate; unknown cache accounting is not zero. */
internal fun taskUsageLines(usage: TaskUsage, locale: Locale = Locale.getDefault()): List<String> {
    val number = NumberFormat.getIntegerInstance(locale)
    val lines = mutableListOf<String>()
    val cached = usage.cachedInput?.takeIf { it >= 0 && it <= usage.input }
    if (cached == null) {
        lines += "Input: ${number.format(usage.input)} (cache split unavailable)"
    } else {
        lines += "Uncached input: ${number.format(usage.input - cached)}"
        lines += "Cached input: ${number.format(cached)}"
    }
    lines += "Output: ${number.format(usage.output)}"
    usage.costUsd?.takeIf { it.isFinite() && it >= 0 }?.let {
        lines += "Reported cost: ${String.format(Locale.US, "$%.4f", it)}"
    }
    usage.context?.let { context ->
        val window = context.window
        if (window != null && window > 0) {
            lines += "Context: ${number.format(context.tokens)} / ${number.format(window)}"
        }
    }
    return lines
}

@Composable
internal fun TaskUsagePanel(usage: TaskUsage) {
    Column(
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("This thread's usage", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        taskUsageLines(usage).forEach { line ->
            Text(line, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
