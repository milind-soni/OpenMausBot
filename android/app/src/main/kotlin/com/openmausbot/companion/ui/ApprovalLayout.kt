package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class ApprovalLayout(val wireValue: String, val label: String, val caption: String) {
    STANDARD("standard", "Standard", "Approval buttons start on the left."),
    RIGHT_ALIGNED("right", "Right-aligned", "Approval buttons sit on the right for easier one-handed use."),
    COMPACT("compact", "Compact", "Smaller right-aligned buttons, with full labels and touch targets."),
    ;

    companion object {
        fun fromWire(value: String?): ApprovalLayout = entries.firstOrNull { it.wireValue == value } ?: STANDARD
    }
}

@Composable
internal fun UpdateApprovalButtons(
    options: List<String>,
    layout: ApprovalLayout,
    enabled: Boolean,
    onChoose: (String) -> Unit,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(
            if (layout == ApprovalLayout.COMPACT) 4.dp else 8.dp,
            if (layout == ApprovalLayout.STANDARD) Alignment.Start else Alignment.End,
        ),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { option ->
            Button(
                onClick = { onChoose(option) },
                enabled = enabled,
                modifier = Modifier.heightIn(min = 48.dp).defaultMinSize(
                    minWidth = if (layout == ApprovalLayout.COMPACT) 48.dp else ButtonDefaults.MinWidth,
                ),
                contentPadding = if (layout == ApprovalLayout.COMPACT) {
                    PaddingValues(horizontal = 10.dp, vertical = 4.dp)
                } else ButtonDefaults.ContentPadding,
                colors = if (ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY) {
                    ButtonDefaults.filledTonalButtonColors()
                } else {
                    ButtonDefaults.buttonColors()
                },
            ) { Text(option, fontSize = 13.sp) }
        }
    }
}
