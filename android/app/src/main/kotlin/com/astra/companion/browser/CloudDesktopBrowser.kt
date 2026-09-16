package com.astra.companion.browser

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import java.net.URI

/**
 * The cloud provider's noVNC viewer, opened without teaching AstraMobile how
 * to speak VNC or retain the provider's session token — the port of
 * `ios/App/CloudDesktopBrowser.swift`, where the same job is done by
 * `SFSafariViewController`.
 *
 * Chrome Custom Tabs is that control's Android counterpart: a hardened browser
 * process with its own visible origin, cookie jar and WebSocket support, which
 * noVNC needs. The alternative — a `WebView` — would put the provider's session
 * inside this app's process, make us responsible for its JavaScript, storage and
 * permission prompts, and hide the origin from the person about to hand it full
 * control of a cloud machine. §20 rules out the WebView shape for the desktop UI
 * for related reasons.
 *
 * The URL is passed straight through from the join response to the browser and
 * kept nowhere: not in saved state, not in a field, not in a log. It is minted
 * per join, so the next one asks the harness again.
 */
class CloudDesktopBrowser(private val context: Context) {

    /**
     * @return null on success, or a human-readable reason nothing opened.
     */
    fun open(url: URI): String? = try {
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .build()
            .launchUrl(context, Uri.parse(url.toASCIIString()))
        null
    } catch (error: Exception) {
        // No browser at all, or one that refused the launch. Custom Tabs already
        // falls back to a plain browser Intent on its own, so reaching here means
        // there is nothing on the device that can show a web page.
        "This phone has no browser available to open the cloud desktop."
    }
}
