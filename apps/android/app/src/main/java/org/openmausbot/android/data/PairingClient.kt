package org.openmausbot.android.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.io.IOException
import java.util.UUID

/** The server response together with the route that actually answered.
 *  Pairing persists the winner, not merely the first address printed in a
 *  QR, or the next launch repeats the same dead route. */
data class PairingOutcome(
    val result: ApiClient.PairResult,
    val connection: PairedComputer,
)

/** The two network operations pairing needs, separated so the route walk can
 *  be tested without a server. */
interface PairingTransport {
    suspend fun healthy(endpoint: CompanionEndpoint): Boolean
    suspend fun redeem(
        endpoint: CompanionEndpoint,
        credential: String,
        deviceName: String,
        pairRequestId: String,
    ): ApiClient.PairResult
}

class HttpPairingTransport : PairingTransport {
    override suspend fun healthy(endpoint: CompanionEndpoint): Boolean {
        val health = ApiClient(
            endpoint.url,
            null,
            connectTimeoutMs = 4_000,
            readTimeoutMs = 4_000,
        ).health()
        return health.optString("app") == "openmausbot"
    }

    override suspend fun redeem(
        endpoint: CompanionEndpoint,
        credential: String,
        deviceName: String,
        pairRequestId: String,
    ): ApiClient.PairResult = ApiClient(
        endpoint.url,
        null,
        connectTimeoutMs = 8_000,
        readTimeoutMs = 8_000,
    ).pair(credential, deviceName, pairRequestId)
}

object PairingClient {
    /** Resolve the multi-address invite before consuming its credential.
     *  Health probes are non-mutating and run together, but the advertised
     *  security order wins: a quick cleartext LAN answer must not outrank an
     *  encrypted tailnet route that answers a moment later.
     *
     *  Only routes the invite consented to are tried. A desktop QR that leads
     *  with a local address consents to each local address it carries; a
     *  protected route is never followed by cleartext. Only the first route
     *  that identifies itself as OpenMausBot receives the one-time pairing
     *  POST. The request id makes that redemption safely replayable if its
     *  response is lost in transit. */
    suspend fun pairFirstReachable(
        invite: PairingInvite,
        deviceName: String,
        pairRequestId: String = UUID.randomUUID().toString(),
        transport: PairingTransport = HttpPairingTransport(),
    ): PairingOutcome {
        val credential = invite.credential ?: throw ApiException(400, "这个邀请没有配对码")
        val seed = invite.seedConnection().establishRoutePolicyFromInvite(everyLocalRoute = true)
        val candidates = seed.pairingEndpoints()
        val attempted = candidates.map { it.url }
        val remaining = candidates.toMutableList()
        while (remaining.isNotEmpty()) {
            val winner = firstHealthy(remaining, transport) ?: break
            remaining.removeAll { it.url == winner.url }
            try {
                val result = transport.redeem(winner, credential, deviceName, pairRequestId)
                var paired = seed.dialing(winner)
                    .pinRouteConsent(winner, seed)
                    .copy(
                        id = result.deviceId,
                        serverName = result.serverName,
                        token = result.token,
                        lastUsedAt = System.currentTimeMillis(),
                        companionDeviceId = result.deviceId,
                        secretPublicKey = invite.secretKey,
                    )
                    .applyPairingAdvertisement(result.hosts, result.endpoints)
                val active = paired.activeEndpoint ?: winner
                paired = paired.copy(
                    baseUrl = active.url,
                    endpoints = paired.endpointRoutes.map { it.url },
                )
                return PairingOutcome(result, paired)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                // Credential/client errors are authoritative and must not be
                // sprayed at another address. Transport failures and gateway
                // errors belong to this route.
                if (!ConnectionAdvice.shouldTryAnotherRoute(e)) throw e
            } catch (e: IOException) {
                // URL loading failures are ambiguous. Keep the logical request
                // id and try another verified route.
            } catch (e: Exception) {
                // A body this build cannot read is likewise ambiguous.
            }
        }
        throw PairingRouteError(attempted, invite.serverName)
    }

    /** Probe every candidate together, but respect the advertised order. A
     *  lower-priority result is selected as soon as every route before it has
     *  conclusively failed. */
    private suspend fun firstHealthy(
        candidates: List<CompanionEndpoint>,
        transport: PairingTransport,
    ): CompanionEndpoint? = coroutineScope {
        val probes = candidates.map { endpoint ->
            async(Dispatchers.IO) {
                try {
                    transport.healthy(endpoint)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    false
                }
            }
        }
        var winner: CompanionEndpoint? = null
        for (index in candidates.indices) {
            if (probes[index].await()) {
                winner = candidates[index]
                break
            }
        }
        probes.forEach { it.cancel() }
        winner
    }
}
