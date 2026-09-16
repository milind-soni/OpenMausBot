package com.astra.companion.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.astra.companion.avatar.AvatarImageRules
import com.astra.companion.core.AvatarCrop
import com.astra.companion.core.Bot
import com.astra.companion.core.Chat

/**
 * An agent's identity image, or its mascot — the port of
 * `ios/App/BotAvatarView.swift`.
 *
 * The image is an app-owned attachment on the paired computer, fetched with this
 * phone's bearer token, so it never goes through a URL-loading composable that
 * could not attach one. Every way that can fail — no URL, the mascot crop, a
 * fetch that did not answer, bytes that would not decode — lands on the same
 * deterministic mascot, because an agent's identity must never become an empty
 * placeholder.
 */
@Composable
internal fun BotAvatar(
    bot: Bot,
    size: Dp,
    state: AstraState = AstraState.IDLE,
    animated: Boolean = true,
    /**
     * Left null where the name is already beside the face — the row would
     * otherwise be read out twice, which is why [AstraAvatar] clears its own
     * semantics. Set it where the face stands alone.
     */
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
) {
    val crop = bot.avatarCrop ?: AvatarCrop.MASCOT
    val path = bot.avatarUrl
    val store = LocalCompanion.current.avatars

    // `BotAvatarView` keys its fetch on the attachment and the crop together, and
    // clears the rendered image whenever either changes. Keying the state itself
    // means a recycled row never paints the previous agent's face for a frame.
    val identity = remember(path, crop) { BotAvatarRules.identity(path, crop) }
    var image by remember(identity) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(identity) { mutableStateOf(false) }

    LaunchedEffect(identity) {
        if (crop == AvatarCrop.MASCOT || path == null) return@LaunchedEffect
        val decoded = store.bitmapFor(bot)
        if (decoded == null) {
            failed = true
            return@LaunchedEffect
        }
        image = decoded
    }

    // `BotAvatarView` puts its accessibility outside the image/mascot branch, so
    // the agent is announced whichever one draws — a missing attachment or a
    // failed fetch must not also cost the avatar its name.
    val named = if (contentDescription == null) {
        modifier
    } else {
        modifier.semantics { this.contentDescription = contentDescription }
    }

    val painted = image
    if (painted != null && AvatarImageRules.usesImage(crop, path, failed)) {
        val bitmap = remember(painted) { painted.asImageBitmap() }
        Image(
            bitmap = bitmap,
            // Named by [named] above; naming it here as well reads it twice.
            contentDescription = null,
            // `.resizable().scaledToFill().frame(size).clipShape(mask)`.
            contentScale = ContentScale.Crop,
            modifier = named.size(size).clip(BotAvatarRules.shape(crop, size)),
        )
    } else {
        AstraAvatar(
            color = bot.color,
            bodyId = bot.mascotBody,
            size = size,
            state = state,
            animated = animated,
            modifier = named,
        )
    }
}

/** `ChatAvatarView`: a room has no identity image, only the blue mascot. */
@Composable
internal fun ChatAvatar(
    chat: Chat,
    size: Dp,
    state: AstraState = AstraState.IDLE,
    animated: Boolean = true,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
) {
    when (chat) {
        is Chat.BotChat -> BotAvatar(
            bot = chat.bot,
            size = size,
            state = state,
            animated = animated,
            contentDescription = contentDescription,
            modifier = modifier,
        )
        is Chat.RoomChat -> AstraAvatar(
            color = "blue",
            size = size,
            state = state,
            animated = animated,
            modifier = modifier,
        )
    }
}

internal object BotAvatarRules {
    /**
     * What `BotAvatarView` keys `.task(id:)` on: the attachment and the crop
     * together, joined the same way, so changing either restarts the fetch and
     * clears whatever the previous identity had painted.
     */
    fun identity(avatarUrl: String?, crop: AvatarCrop): String =
        "${avatarUrl.orEmpty()}|${crop.name.lowercase()}"

    /** The mask each crop wears — `BotAvatarView.mask`. */
    fun shape(crop: AvatarCrop, size: Dp): Shape = when (crop) {
        AvatarCrop.CIRCLE -> CircleShape
        AvatarCrop.ROUNDED -> RoundedCornerShape(
            AvatarImageRules.roundedCornerRadius(size.value).dp,
        )
        AvatarCrop.SQUARE, AvatarCrop.MASCOT -> RectangleShape
    }
}
