package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.openmausbot.companion.core.ConnectedAppsRules
import com.openmausbot.companion.core.ConnectorAccount
import com.openmausbot.companion.core.ConnectorCard
import com.openmausbot.companion.core.ConnectorCatalog
import com.openmausbot.companion.core.ConnectorStatus
import com.openmausbot.companion.core.ConnectorStatuses
import kotlinx.coroutines.launch

/**
 * The paired-phone inventory for apps connected on the computer.
 *
 * Authorization deliberately leaves the app for the system browser. The
 * desktop owns provider credentials and revocation, and the paired phone only
 * starts an authorization flow and reports the inventory it was given.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectedAppsScreen(onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var catalog by remember { mutableStateOf<ConnectorCatalog?>(null) }
    var inventory by remember { mutableStateOf(ConnectedAppsInventory()) }
    // Everything typed, and the dialog holding it, outlive a rotation: this
    // Activity is recreated on one, and the catalog behind them is re-fetched.
    var query by rememberSaveable { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var aliasTarget by rememberSaveable(stateSaver = AliasTargetSaver) {
        mutableStateOf<AliasTarget?>(null)
    }
    var alias by rememberSaveable { mutableStateOf("") }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            session.loadAllConnectorStatuses()?.let { response ->
                inventory = ConnectedAppsPolicy.accept(inventory, response)
            }
        } finally {
            if (showProgress) refreshing = false
        }
    }

    fun authorize(slug: String, accountAlias: String?) {
        scope.launch {
            val url = session.authorizeConnector(slug, accountAlias) ?: return@launch
            try {
                // The core client accepts only a well-formed HTTPS URL. ACTION_VIEW
                // keeps provider cookies, redirects and account choice in the
                // browser instead of placing them in our process.
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toASCIIString())))
            } catch (_: ActivityNotFoundException) {
                session.actionError = "This phone has no browser available to open the authorization page."
            } catch (_: SecurityException) {
                session.actionError = "The authorization page could not be opened. Check your browser restrictions and try again."
            }
        }
    }

    LaunchedEffect(Unit) {
        loading = true
        try {
            catalog = session.loadConnectorCatalog()
            refresh()
        } finally {
            loading = false
        }
    }

    // Authorization finishes in the browser, so the answer arrives while this
    // screen is away — iOS re-reads on `scenePhase == .active`
    // (`ios/App/ConnectedAppsView.swift:90-92`), without the full-screen
    // spinner its `load` uses. The first resume is this screen's own entry,
    // which the effect above already loaded, so it is skipped rather than
    // asking twice.
    var entered by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        if (entered) scope.launch { refresh() } else entered = true
        onPauseOrDispose {}
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(stringResource(R.string.mobile_connected_apps_8ab72a8e), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            TextButton(
                onClick = { scope.launch { refresh(showProgress = true) } },
                enabled = !refreshing,
            ) { Text(if (refreshing) stringResource(R.string.mobile_refreshing_96141178) else stringResource(R.string.mobile_refresh_56e3badc)) }
        }
        HorizontalDivider()

        // The same gesture the roster uses for the same question (RosterScreen.kt:167),
        // and iOS's `.refreshable` (ConnectedAppsView.swift:89).
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refresh(showProgress = true) } },
            modifier = Modifier.fillMaxSize(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(stringResource(R.string.mobile_search_apps_ca3ce8f3)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                if (inventory.credentialStoreUnreadable) {
                    CredentialStoreWarning(hasLastKnownInventory = inventory.statuses != null)
                }

                if (ConnectedAppsPolicy.showSetupNotice(catalog, inventory.credentialStoreUnreadable)) {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(stringResource(R.string.mobile_connected_apps_need_setup_2cdb536a), fontWeight = FontWeight.SemiBold)
                            Text(
                                stringResource(R.string.mobile_configure_composio_on_your_compute_4281e8b0),
                                color = secondaryTint,
                                fontSize = 13.sp,
                            )
                        }
                    }
                }

                ConnectedAppsPolicy.filterCards(catalog?.cards.orEmpty(), query).forEach { card ->
                    ConnectorCardView(
                        card = card,
                        status = inventory.statuses?.get(card.slug),
                        hasAuthoritativeInventory = inventory.statuses != null,
                        configured = catalog?.configured == true,
                        onConnect = { authorize(card.slug, ConnectedAppsRules.firstAccountAlias) },
                        onAddAccount = {
                            alias = ""
                            aliasTarget = AliasTarget(slug = card.slug, label = card.label)
                        },
                    )
                }

                if (!loading && catalog?.cards.isNullOrEmpty()) {
                    Text(stringResource(R.string.mobile_no_connected_apps_are_available_fr_0529e71d), color = secondaryTint)
                }

                if (loading) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                    }
                }
            }
        }
    }

    aliasTarget?.let { target ->
        val normalized = ConnectedAppsRules.additionalAccountAlias(alias)
        AlertDialog(
            onDismissRequest = { aliasTarget = null },
            title = { Text(stringResource(R.string.mobile_account_alias_8cf27ca0)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = alias,
                        onValueChange = { alias = it },
                        label = { Text(stringResource(R.string.mobile_work_personal_client_7d6a18a4)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        stringResource(R.string.mobile_an_alias_makes_the_account_explici_725873b3, target.label),
                        color = secondaryTint,
                        fontSize = 13.sp,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = normalized != null,
                    onClick = {
                        aliasTarget = null
                        authorize(target.slug, normalized)
                    },
                ) { Text(stringResource(R.string.mobile_continue_2e026239)) }
            },
            dismissButton = { TextButton(onClick = { aliasTarget = null }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) } },
        )
    }
}

/**
 * What the alias dialog is about: the connector it will authorize and the name
 * it says out loud. Kept apart from [ConnectorCard] because it has to survive a
 * rotation on its own — the catalog it came from is being fetched again at that
 * moment, and a dialog holding typed text cannot wait for the network.
 */
private data class AliasTarget(val slug: String, val label: String)

private val AliasTargetSaver = listSaver<AliasTarget?, String>(
    save = { target -> target?.let { listOf(it.slug, it.label) }.orEmpty() },
    restore = { saved -> saved.takeIf { it.size == 2 }?.let { AliasTarget(it[0], it[1]) } },
)

@Composable
private fun CredentialStoreWarning(hasLastKnownInventory: Boolean) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.mobile_accounts_could_not_be_re_checked_6727be8f), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.tertiary)
            Text(
                if (hasLastKnownInventory) {
                    stringResource(R.string.mobile_showing_what_was_connected_last_ti_62107fa4)
                } else {
                    stringResource(R.string.mobile_your_computer_could_not_open_its_c_fa640d75)
                },
                color = secondaryTint,
                fontSize = 13.sp,
            )
        }
    }
}

@Composable
private fun ConnectorCardView(
    card: ConnectorCard,
    status: ConnectorStatus?,
    hasAuthoritativeInventory: Boolean,
    configured: Boolean,
    onConnect: () -> Unit,
    onAddAccount: () -> Unit,
) {
    val accounts = status?.accounts.orEmpty()
    val connected = status?.connected == true
    val pending = status?.pending == true

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(card.label, fontWeight = FontWeight.SemiBold)
                    Text(card.blurb, color = secondaryTint, fontSize = 13.sp)
                }
                if (pending) Text(stringResource(R.string.mobile_connecting_fd3e7969), color = secondaryTint, fontSize = 13.sp)
            }

            when {
                !hasAuthoritativeInventory -> Text(stringResource(R.string.mobile_connection_unknown_973b0484), color = secondaryTint)
                accounts.isEmpty() && !connected && !pending -> Button(onClick = onConnect, enabled = configured) {
                    Text(stringResource(R.string.mobile_connect_card_label_c9e612b4, card.label))
                }
                accounts.isEmpty() -> {
                    Text(if (pending) stringResource(R.string.mobile_connecting_fd3e7969) else stringResource(R.string.mobile_connected_c2f9b7b4))
                    Text(
                        stringResource(R.string.mobile_account_details_are_unavailable_fr_d9d62172),
                        color = secondaryTint,
                        fontSize = 13.sp,
                    )
                }
                else -> {
                    accounts.forEach { account -> ConnectorAccountRow(account) }
                    // Kept and disabled at the limit, so the limit is legible
                    // (`ios/App/ConnectedAppsView.swift:159-163`); hiding the
                    // button leaves the ceiling to be guessed at.
                    TextButton(
                        onClick = onAddAccount,
                        enabled = ConnectedAppsRules.canAddAnotherAccount(accounts),
                    ) { Text(stringResource(R.string.mobile_add_another_account_5dcc7913)) }
                }
            }
        }
    }
}

@Composable
private fun ConnectorAccountRow(account: ConnectorAccount) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f)) {
            Text(account.displayName)
            Text(localizedMobileCopy(ConnectedAppsPolicy.statusLabel(account.status)), color = secondaryTint, fontSize = 12.sp)
            SelectionContainer { Text(account.id, color = secondaryTint, fontSize = 11.sp) }
        }
        Text(if (account.isActive) stringResource(R.string.mobile_active_a733b809) else stringResource(R.string.mobile_pending_96f608c1), color = secondaryTint, fontSize = 12.sp)
    }
}

/** Pure state transition so an unavailable store can never erase a known inventory. */
data class ConnectedAppsInventory(
    val statuses: Map<String, ConnectorStatus>? = null,
    val credentialStoreUnreadable: Boolean = false,
)

object ConnectedAppsPolicy {
    fun accept(previous: ConnectedAppsInventory, response: ConnectorStatuses): ConnectedAppsInventory =
        if (response.isAuthoritative) {
            ConnectedAppsInventory(statuses = response.services)
        } else {
            previous.copy(credentialStoreUnreadable = true)
        }

    /**
     * The provider's own wire word, made readable —
     * `status.replacingOccurrences(of: "_", with: " ").capitalized` in
     * `ios/App/ConnectedAppsView.swift:144`. Case is fixed, not the phone's
     * locale: these are ASCII protocol words, not prose.
     */
    fun statusLabel(status: String): String =
        status.replace('_', ' ').split(' ').joinToString(" ") { word ->
            word.lowercase().replaceFirstChar(Char::uppercaseChar)
        }

    fun showSetupNotice(catalog: ConnectorCatalog?, credentialStoreUnreadable: Boolean): Boolean =
        catalog?.configured == false && !credentialStoreUnreadable

    fun filterCards(cards: List<ConnectorCard>, query: String): List<ConnectorCard> {
        val needle = query.trim()
        if (needle.isEmpty()) return cards
        return cards.filter { card ->
            card.label.contains(needle, ignoreCase = true) || card.slug.contains(needle, ignoreCase = true)
        }
    }
}
