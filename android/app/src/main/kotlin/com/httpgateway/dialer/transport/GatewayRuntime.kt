package com.httpgateway.dialer.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.DisconnectCause
import com.httpgateway.dialer.config.GatewayConfig
import com.httpgateway.dialer.config.GatewayConfigStore
import com.httpgateway.dialer.telecom.CallCommandController
import com.httpgateway.dialer.telecom.CallRegistry
import com.httpgateway.protocol.CommandParseResult
import com.httpgateway.protocol.GatewayCommand
import com.httpgateway.protocol.GatewayCommandParser
import com.httpgateway.protocol.GatewayEvent
import com.httpgateway.protocol.GatewayProtocol
import java.time.Instant
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min

object GatewayRuntime {
    private const val MAX_QUEUED_EVENTS = 100
    private const val HEALTH_INTERVAL_SECONDS = 60L

    private val lock = Any()
    private val pendingEvents = ArrayDeque<String>()
    private val reconnectHandler = Handler(Looper.getMainLooper())

    private var appContext: Context? = null
    private var configStore: GatewayConfigStore? = null
    private var controller: CallCommandController? = null
    private var transport: GatewayTransport? = null
    private var connected = false
    private var reconnectAttempt = 0
    private var intentionallyClosed = false
    private var connectStartedAt = 0L
    private var currentNetwork: Network? = null
    private val healthWorker = Executors.newSingleThreadScheduledExecutor { Thread(it, "gateway-health") }

    fun initialize(context: Context) {
        synchronized(lock) {
            if (appContext != null) return
            appContext = context.applicationContext
            configStore = GatewayConfigStore(context.applicationContext)
            controller = CallCommandController(context.applicationContext)
        }
        connectFromStoredConfig()
        watchNetwork(context.applicationContext)
        healthWorker.scheduleWithFixedDelay(::sendHealth, HEALTH_INTERVAL_SECONDS, HEALTH_INTERVAL_SECONDS, TimeUnit.SECONDS)
    }

    /** Sends a health report now (off the calling thread). */
    fun reportHealthSoon() {
        healthWorker.execute(::sendHealth)
    }

    private fun sendHealth() {
        val context = synchronized(lock) { appContext.takeIf { connected } } ?: return
        val report = runCatching { DeviceHealth.collect(context) }.getOrNull() ?: return
        synchronized(lock) { if (connected) transport?.send(report) }
    }

    /**
     * Reconnects at once when the phone switches networks (Wi-Fi <-> mobile data) instead of waiting
     * for the old socket to time out, and when a network comes back while offline.
     */
    private fun watchNetwork(context: Context) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        runCatching {
            connectivity.registerDefaultNetworkCallback(
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        val switched = synchronized(lock) {
                            val previous = currentNetwork
                            currentNetwork = network
                            previous != null && previous != network
                        }
                        reconnectHandler.post { reconnectNow(force = switched) }
                        reportHealthSoon()
                    }

                    override fun onLost(network: Network) {
                        reportHealthSoon()
                    }
                },
                reconnectHandler,
            )
        }
    }

    private fun reconnectNow(force: Boolean) {
        synchronized(lock) {
            if (appContext == null || intentionallyClosed) return
            if (!force && (connected || System.currentTimeMillis() - connectStartedAt < 5_000)) return
            reconnectHandler.removeCallbacksAndMessages(null)
            reconnectAttempt = 0
            transport?.setListener(null)
            transport?.close()
            transport = null
            connected = false
        }
        connectFromStoredConfig()
    }

    fun isConnected(): Boolean = synchronized(lock) { connected }

    fun reconfigure() {
        synchronized(lock) {
            intentionallyClosed = true
            reconnectHandler.removeCallbacksAndMessages(null)
            transport?.setListener(null)
            transport?.close()
            transport = null
            connected = false
            reconnectAttempt = 0
            intentionallyClosed = false
        }
        connectFromStoredConfig()
    }

    fun emitCallAdded(callId: String, call: Call) {
        emit(
            callId = callId,
            event = "call.new",
            payload = callPayload(call),
        )
        emitCallState(callId, call)
    }

    fun emitCallState(callId: String, call: Call) {
        val state = CallRegistry.stateWireName(call)
        if (state == "unknown") return
        val event = if (state == "disconnected" && CallRegistry.wasRejected(callId)) {
            "call.rejected"
        } else {
            "call.$state"
        }
        emit(
            callId = callId,
            event = event,
            payload = callPayload(call),
        )
    }

    fun emitCallRemoved(callId: String, call: Call) {
        val disconnectCause = call.details.disconnectCause
        emit(
            callId = callId,
            event = if (
                CallRegistry.wasRejected(callId) ||
                disconnectCause.code == DisconnectCause.REJECTED
            ) {
                "call.rejected"
            } else {
                "call.disconnected"
            },
            payload = callPayload(call) + mapOf(
                "disconnectCause" to disconnectCause.code.toString(),
            ),
        )
    }

    private fun connectFromStoredConfig() {
        val config = synchronized(lock) { configStore?.load() } ?: return
        if (!config.isConnectable()) return

        val newTransport = OkHttpGatewayTransport(config)
        newTransport.setListener(
            object : GatewayTransport.Listener {
                override fun onOpen() {
                    synchronized(lock) {
                        connected = true
                        reconnectAttempt = 0
                    }
                    flushPendingEvents()
                    reportHealthSoon()
                }

                override fun onMessage(text: String) {
                    when (val parsed = GatewayCommandParser.parse(text)) {
                        is CommandParseResult.Success -> execute(parsed.command)
                        is CommandParseResult.Error -> Unit
                    }
                }

                override fun onClosed() {
                    synchronized(lock) { connected = false }
                    scheduleReconnect()
                }

                override fun onFailure() {
                    synchronized(lock) { connected = false }
                    scheduleReconnect()
                }
            },
        )

        synchronized(lock) {
            transport = newTransport
            connectStartedAt = System.currentTimeMillis()
        }
        newTransport.connect()
    }

    private fun execute(command: GatewayCommand) {
        val commandController = synchronized(lock) { controller } ?: return
        commandController.handle(command) { result ->
            emit(
                callId = command.callId,
                event = if (result.ok) "command.completed" else "call.failed",
                payload = buildMap {
                    put("commandId", command.commandId)
                    put("action", command.action.wireName)
                    result.error?.let { put("reason", it) }
                },
            )
        }
    }

    private fun emit(callId: String, event: String, payload: Map<String, String>) {
        val encoded = GatewayProtocol.encodeEvent(
            GatewayEvent(
                eventId = "evt_${UUID.randomUUID()}",
                callId = callId,
                event = event,
                timestamp = Instant.now().toString(),
                payload = payload,
            ),
        )

        synchronized(lock) {
            if (connected && transport?.send(encoded) == true) return
            while (pendingEvents.size >= MAX_QUEUED_EVENTS) pendingEvents.removeFirst()
            pendingEvents.addLast(encoded)
        }
    }

    private fun flushPendingEvents() {
        synchronized(lock) {
            val activeTransport = transport ?: return
            while (pendingEvents.isNotEmpty()) {
                val next = pendingEvents.first()
                if (!activeTransport.send(next)) return
                pendingEvents.removeFirst()
            }
        }
    }

    private fun scheduleReconnect() {
        val delay = synchronized(lock) {
            if (intentionallyClosed || appContext == null) return
            reconnectAttempt += 1
            min(30_000L, 1_000L shl min(reconnectAttempt - 1, 5))
        }
        reconnectHandler.postDelayed({
            synchronized(lock) {
                transport?.setListener(null)
                transport?.close()
                transport = null
            }
            connectFromStoredConfig()
        }, delay)
    }

    private fun callPayload(call: Call): Map<String, String> {
        val details = call.details
        val direction = when (details.callDirection) {
            Call.Details.DIRECTION_INCOMING -> "incoming"
            Call.Details.DIRECTION_OUTGOING -> "outgoing"
            else -> "unknown"
        }
        return buildMap {
            details.handle?.schemeSpecificPart?.takeIf { it.isNotBlank() }?.let { put("number", it) }
            put("direction", direction)
            put("state", CallRegistry.stateWireName(call))
            put(
                "canHold",
                ((details.callCapabilities and Call.Details.CAPABILITY_HOLD) != 0).toString(),
            )
        }
    }

    private fun GatewayConfig.isConnectable(): Boolean =
        wsUrl.isNotBlank() && deviceId.isNotBlank() && deviceToken.isNotBlank()
}
