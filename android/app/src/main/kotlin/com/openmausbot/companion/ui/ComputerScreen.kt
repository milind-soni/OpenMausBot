package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * A bot's computer, live — the port of `ios/App/ComputerView.swift`.
 *
 * Watch-only: no clicking, no typing, no zoom. The frame is fit to the bounds and
 * lands as a letterbox, because the desktop is wider than the phone.
 *
 * Frames are expensive — hundreds of kilobytes of base64 each — so `Session` only
 * asks for them while this screen is on. [ScreenWatch] holds exactly one watcher
 * for the composable's lifetime.
 */
@Composable
fun ComputerScreen(botId: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val state by session.state.collectAsState()

    val bot = remember(state, botId) { state.bot(botId) }
    if (bot == null) {
        LaunchedEffect(botId) { onBack() }
        return
    }

    // Enter asks the stream for screens, leave asks it to stop and drops the
    // frame. Backgrounding does not pass through here: the stream is torn down
    // whole and resumes with screens still on, which is what iOS does.
    DisposableEffect(botId) {
        val watch = ScreenWatch(
            start = session::watchScreen,
            stop = session::stopWatchingScreen,
        )
        watch.watch(botId)
        onDispose { watch.release() }
    }

    var confirming by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    val frame = state.screens[botId]
    val image: ImageBitmap? = remember(frame) {
        frame?.data
            ?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size) }.getOrNull() }
            ?.asImageBitmap()
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = stringResource(R.string.mobile_bot_name_s_computer_7637def1, bot.name),
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Waiting(
                headline = ComputerPolicy.waitingHeadline(bot),
                explanation = ComputerPolicy.IDLE_EXPLANATION.takeIf {
                    ComputerPolicy.explainsIdle(bot)
                },
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = stringResource(R.string.mobile_back_b52b36b7),
                tint = Color.White,
                modifier = Modifier
                    .size(32.dp)
                    .background(Color.White.copy(alpha = 0.18f), CircleShape)
                    .clickable(onClick = onBack)
                    .padding(6.dp),
            )
            Text(
                text = bot.name,
                color = Color.White,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = localizedMobileCopy(ComputerPolicy.statusLabel(bot)),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (bot.busy == true) {
                    Color(MausPalette.argb("green"))
                } else {
                    Color.White.copy(alpha = 0.6f)
                },
            )
        }

        if (ComputerPolicy.showsCloudDesktop(bot)) {
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = 18.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                failure?.let {
                    Text(
                        text = localizedMobileCopy(it),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }
                Button(
                    onClick = { confirming = true },
                    enabled = !opening,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (opening) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(localizedMobileCopy(ComputerPolicy.OPEN_DESKTOP))
                    }
                }
                Text(
                    text = localizedMobileCopy(ComputerPolicy.VNC_NOTE),
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = 0.6f),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(localizedMobileCopy(ComputerPolicy.CONFIRM_TITLE)) },
            text = { Text(localizedMobileCopy(ComputerPolicy.CONFIRM_MESSAGE)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = false
                        opening = true
                        failure = null
                        scope.launch {
                            try {
                                // Minted per join, handed straight to the browser
                                // and kept nowhere: no field, no saved state, no
                                // log. The next join asks the harness again.
                                failure = environment.openCloudDesktop(session.cloudDesktop(bot))
                            } catch (error: Throwable) {
                                if (error is kotlinx.coroutines.CancellationException) throw error
                                failure = error.message ?: "Could not open the cloud desktop."
                            } finally {
                                opening = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.mobile_open_desktop_cd6f8218)) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        )
    }
}

@Composable
private fun Waiting(headline: String, explanation: String?) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            strokeWidth = 2.dp,
            color = Color.White,
        )
        Text(
            text = localizedMobileCopy(headline),
            fontSize = 15.sp,
            color = Color.White.copy(alpha = 0.7f),
        )
        explanation?.let {
            Text(
                text = localizedMobileCopy(it),
                fontSize = 13.sp,
                color = Color.White.copy(alpha = 0.45f),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 32.dp),
            )
        }
    }
}
