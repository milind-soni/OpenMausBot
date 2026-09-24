package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.storage.ChatPreferences

private val names = mapOf(
    "system" to "System default", "midnight" to "Midnight", "atelier" to "Atelier",
    "foundry" to "Foundry", "lagoon" to "Lagoon", "graphite" to "Graphite",
    "linen" to "Linen", "dusk" to "Dusk", "daylight" to "Daylight",
    "chatgpt" to "ChatGPT", "custom" to "Custom",
)

/** Every color role from the desktop stylesheet is editable on the phone too. */
@Composable
fun ThemeEditor(preferences: ChatPreferences, onDismiss: () -> Unit) {
    val selected by preferences.themeId.collectAsState()
    val saved by preferences.customColors.collectAsState()
    var editing by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(saved.ifEmpty { PresetThemes.colors.getValue("chatgpt") + ("chat-layout" to "chatgpt") }) }
    val valid = PresetThemes.colorRoles.all { role ->
        val value = draft[role].orEmpty()
        value == "transparent" || value.matches(Regex("#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?"))
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (editing) "Custom theme" else "Appearance") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 540.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (!editing) {
                    Text("Choose a look for this phone. Your computer has its own theme setting.")
                    (listOf("system") + PresetThemes.colors.keys + "custom").forEach { id ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = selected == id, onClick = {
                                if (id == "custom") {
                                    draft = saved.ifEmpty { PresetThemes.colors.getValue("chatgpt") + ("chat-layout" to "chatgpt") }
                                    editing = true
                                } else {
                                    preferences.setTheme(id)
                                    onDismiss()
                                }
                            })
                            Text(names[id] ?: id)
                        }
                    }
                    TextButton(onClick = { editing = true }) { Text("Edit custom colors") }
                } else {
                    Text("Start from a preset, then change any color. Hex values support #RRGGBB and #RRGGBBAA; transparent is also allowed.")
                    PresetThemes.colors.keys.forEach { id ->
                        TextButton(onClick = { draft = PresetThemes.colors.getValue(id) + ("chat-layout" to if (id == "chatgpt") "chatgpt" else "standard") }) {
                            Text("Copy ${names[id] ?: id} colors")
                        }
                    }
                    TextButton(onClick = {
                        draft = draft + ("chat-layout" to if (draft["chat-layout"] == "chatgpt") "standard" else "chatgpt")
                    }) { Text("Chat layout: ${if (draft["chat-layout"] == "chatgpt") "ChatGPT" else "Standard"}") }
                    PresetThemes.colorRoles.forEach { role ->
                        val value = draft[role].orEmpty()
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(28.dp).background(
                                if (value == "transparent") MaterialTheme.colorScheme.surface
                                else runCatching { themeColor(value) }.getOrDefault(MaterialTheme.colorScheme.error),
                            ))
                            OutlinedTextField(
                                value = value,
                                onValueChange = { draft = draft + (role to it) },
                                label = { Text(role.replace('-', ' ')) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    if (!valid) Text("Correct invalid colors before saving.", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            if (editing) TextButton(enabled = valid, onClick = {
                preferences.setCustomColors(draft)
                onDismiss()
            }) { Text("Save and use") }
            else TextButton(onClick = onDismiss) { Text("Done") }
        },
        dismissButton = {
            if (editing) TextButton(onClick = { editing = false }) { Text("Back") }
            else TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
