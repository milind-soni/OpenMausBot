package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The three first-run surfaces — the behavioural port of
 * `ios/App/OnboardingViews.swift`.
 *
 * What is ported is the **timing and the routing**: the app says what it is
 * before it asks for anything, offers a way to defer that leads somewhere
 * useful, and explains notifications only once a pairing has made approvals and
 * finished work real. The gradient, the hero avatar, the glass inset and the
 * `DisclosureGroup` are not ported — Material is the right idiom here, and the
 * standing policy is that behaviour mirrors iOS while painting goes native.
 */

/** The sentences these screens are made of, named so a test can look them up. */
object OnboardingCopy {
    const val WELCOME_TITLE = "Take your bots with you"
    const val WELCOME_SUBTITLE =
        "Open chats, approve actions, and send new work from your phone."
    const val WELCOME_CONNECT = "Connect my computer"
    const val NOT_NOW = "Not now"

    const val UNPAIRED_HOME_TITLE = "Connect when you're ready"
    const val UNPAIRED_HOME_BODY =
        "Pair this phone with OpenMausBot to see your chats and respond to your bots."
    const val UNPAIRED_HOME_HINT =
        "On your computer, open OpenMausBot → Settings → Phone."
    const val UNPAIRED_HOME_CONNECT = "Connect computer"

    const val NOTIFICATIONS_TITLE = "Stay in the loop"

    /**
     * The limit is stated here rather than softened, and it is the same sentence
     * Settings shows, from [SettingsPolicy.NOTIFICATIONS_FOOTER]: someone
     * deciding whether to grant this should be told what it can and cannot do
     * before the system sheet appears, not after.
     */
    const val NOTIFICATIONS_BODY = SettingsPolicy.NOTIFICATIONS_FOOTER
    const val NOTIFICATIONS_APPROVALS = "Approvals that are waiting for you"
    const val NOTIFICATIONS_FINISHED = "Finished work and important updates"
    const val NOTIFICATIONS_ENABLE = "Enable notifications"
}

/**
 * First launch. Says what the app is, then offers exactly two answers — and the
 * second one is real: "Not now" leads to [UnpairedHomeScreen], not back here.
 *
 * Nothing on this screen asks the system for anything. That is the whole point
 * of it existing.
 */
@Composable
fun WelcomeScreen(onConnect: () -> Unit, onSkip: () -> Unit) {
    OnboardingLayout(
        actions = {
            Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.mobile_onboarding_welcome_connect))
            }
            TextButton(onClick = onSkip, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.mobile_onboarding_not_now))
            }
        },
    ) {
        OnboardingHero(Icons.AutoMirrored.Filled.Send)
        Text(
            text = stringResource(R.string.mobile_onboarding_welcome_title),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.mobile_onboarding_welcome_subtitle),
            style = MaterialTheme.typography.bodyLarge,
            color = secondaryTint,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Benefit(
            icon = Icons.AutoMirrored.Filled.Send,
            title = stringResource(R.string.mobile_your_chats_in_your_pocket_91291d76),
            detail = stringResource(R.string.mobile_onboarding_conversations),
        )
        Benefit(
            icon = Icons.Filled.CheckCircle,
            title = stringResource(R.string.mobile_respond_when_a_bot_needs_you_96973325),
            detail = stringResource(R.string.mobile_onboarding_approvals),
        )
        Benefit(
            icon = Icons.Filled.Lock,
            title = stringResource(R.string.mobile_private_by_design_3aaa9fd1),
            detail = stringResource(R.string.mobile_onboarding_trusted_computer),
        )
    }
}

/**
 * Where "Not now" leads. A home that is useful without a pairing: it says how to
 * get one, offers the way in, and — the part iOS puts in a toolbar and this puts
 * in a header — reaches Settings, so notifications can be recovered later
 * without first entering a pairing flow the person just declined.
 */
@Composable
fun UnpairedHomeScreen(onConnect: () -> Unit, onOpenSettings: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.mobile_openmausbot_befe710d),
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f).padding(start = 10.dp),
            )
            ChromeButton(
                icon = Icons.Filled.Settings,
                contentDescription = stringResource(R.string.mobile_settings_c7f73bb5),
                onClick = onOpenSettings,
            )
        }
        HorizontalDivider()
        OnboardingLayout(
            actions = {
                Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.mobile_onboarding_connect_computer))
                }
            },
        ) {
            OnboardingHero(Icons.Filled.Phone)
            Text(
                text = stringResource(R.string.mobile_onboarding_unpaired_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )
            Text(
                text = stringResource(R.string.mobile_onboarding_unpaired_body),
                style = MaterialTheme.typography.bodyLarge,
                color = secondaryTint,
                textAlign = TextAlign.Center,
            )
            Text(
                text = stringResource(R.string.mobile_onboarding_unpaired_hint),
                fontSize = 13.sp,
                color = secondaryTint,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * The only screen in this app that asks for the notification permission, and it
 * is reached only after a first pairing has committed.
 *
 * Both buttons end the step: [onEnable] fires the system prompt through the one
 * object allowed to fire it, and "Not now" declines without one. Either way the
 * step is answered once — see the marker's lifecycle in
 * [com.openmausbot.companion.core.NotificationOnboardingPolicy].
 */
@Composable
fun NotificationOnboardingScreen(
    enabling: Boolean,
    onEnable: () -> Unit,
    onSkip: () -> Unit,
) {
    OnboardingLayout(
        actions = {
            Button(
                onClick = onEnable,
                enabled = !enabling,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (enabling) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.mobile_onboarding_enable_notifications))
                }
            }
            TextButton(
                onClick = onSkip,
                enabled = !enabling,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.mobile_onboarding_not_now))
            }
        },
    ) {
        OnboardingHero(Icons.Filled.Notifications)
        Text(
            text = stringResource(R.string.mobile_onboarding_notifications_title),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.mobile_settings_notifications_footer),
            style = MaterialTheme.typography.bodyMedium,
            color = secondaryTint,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Benefit(
            icon = Icons.Filled.CheckCircle,
            title = stringResource(R.string.mobile_onboarding_notifications_approvals),
            detail = null,
        )
        Benefit(
            icon = Icons.AutoMirrored.Filled.Send,
            title = stringResource(R.string.mobile_onboarding_notifications_finished),
            detail = null,
        )
    }
}

/** Scrolling body, actions pinned to the bottom — the same frame for all three. */
@Composable
private fun OnboardingLayout(
    actions: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            content()
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            actions()
        }
    }
}

/**
 * A tinted disc behind one glyph. iOS draws a hero mascot here; Android draws
 * the shape Material draws, which is this.
 */
@Composable
private fun OnboardingHero(icon: ImageVector) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = CircleShape,
        modifier = Modifier.size(104.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.size(44.dp),
            )
        }
    }
}

@Composable
private fun Benefit(icon: ImageVector, title: String, detail: String?) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(24.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            detail?.let {
                Text(text = it, fontSize = 13.sp, color = secondaryTint)
            }
        }
    }
}
