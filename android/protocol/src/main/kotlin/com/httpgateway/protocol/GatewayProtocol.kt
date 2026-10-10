package com.httpgateway.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

enum class CommandAction(val wireName: String) {
    DIAL("dial"),
    ANSWER("answer"),
    REJECT("reject"),
    HANGUP("hangup"),
    HOLD("hold"),
    UNHOLD("unhold"),
    DTMF("dtmf");

    companion object {
        fun fromWireName(value: String): CommandAction? =
            entries.firstOrNull { it.wireName == value.lowercase() }
    }
}

data class GatewayCommand(
    val commandId: String,
    val callId: String,
    val action: CommandAction,
    val to: String? = null,
    val digits: String? = null,
)

sealed interface CommandParseResult {
    data class Success(val command: GatewayCommand) : CommandParseResult
    data class Error(val message: String) : CommandParseResult
}

object GatewayCommandParser {
    private val json = Json { ignoreUnknownKeys = true }
    private val dtmfPattern = Regex("^[0-9*#]+$")

    fun parse(raw: String): CommandParseResult {
        val root = try {
            json.parseToJsonElement(raw).jsonObject
        } catch (_: Exception) {
            return CommandParseResult.Error("invalid_json")
        }

        val type = root.string("type") ?: return CommandParseResult.Error("missing_message_type")
        if (type != "command") {
            return CommandParseResult.Error("unsupported_message_type")
        }

        val commandId = root.string("commandId")?.takeIf { it.isNotBlank() }
            ?: return CommandParseResult.Error("missing_command_id")
        val callId = root.string("callId")?.takeIf { it.isNotBlank() }
            ?: return CommandParseResult.Error("call_id_required")
        val actionName = root.string("action")?.takeIf { it.isNotBlank() }
            ?: return CommandParseResult.Error("missing_action")
        val action = CommandAction.fromWireName(actionName)
            ?: return CommandParseResult.Error("unsupported_action")

        val payload = root["payload"]?.let {
            try {
                it.jsonObject
            } catch (_: Exception) {
                return CommandParseResult.Error("invalid_payload")
            }
        } ?: emptyMap()
        val to = payload.string("to")?.trim()?.takeIf { it.isNotBlank() }
        val digits = payload.string("digits")?.trim()?.takeIf { it.isNotBlank() }

        when (action) {
            CommandAction.DIAL -> {
                if (to == null) return CommandParseResult.Error("number_required")
                if (to.length > 64) return CommandParseResult.Error("number_too_long")
            }

            CommandAction.DTMF -> {
                if (digits == null) return CommandParseResult.Error("digits_required")
                if (digits.length > 64 || !dtmfPattern.matches(digits)) {
                    return CommandParseResult.Error("invalid_dtmf_digits")
                }
            }

            else -> Unit
        }

        return CommandParseResult.Success(
            GatewayCommand(
                commandId = commandId,
                callId = callId,
                action = action,
                to = to,
                digits = digits,
            ),
        )
    }

    private fun Map<String, kotlinx.serialization.json.JsonElement>.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull
}

@Serializable
data class GatewayEvent(
    val type: String = "event",
    val eventId: String,
    val callId: String,
    val event: String,
    val timestamp: String,
    val payload: Map<String, String> = emptyMap(),
)

object GatewayProtocol {
    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
    }

    fun encodeEvent(event: GatewayEvent): String = json.encodeToString(event)
}

enum class GatewayCallState(val wireName: String) {
    NEW("new"),
    CONNECTING("connecting"),
    SELECT_PHONE_ACCOUNT("select_phone_account"),
    DIALING("dialing"),
    RINGING("ringing"),
    ACTIVE("active"),
    HOLDING("holding"),
    DISCONNECTING("disconnecting"),
    DISCONNECTED("disconnected"),
    PULLING("pulling"),
    AUDIO_PROCESSING("audio_processing"),
    SIMULATED_RINGING("simulated_ringing"),
    UNKNOWN("unknown"),
}

/**
 * Maps the public integer values used by android.telecom.Call.STATE_* to the
 * transport state names without depending on android.jar. Keeping this mapper
 * in the JVM-only module makes it directly unit-testable.
 */
object CallStateMapper {
    const val STATE_NEW = 0
    const val STATE_DIALING = 1
    const val STATE_RINGING = 2
    const val STATE_HOLDING = 3
    const val STATE_ACTIVE = 4
    const val STATE_DISCONNECTED = 7
    const val STATE_SELECT_PHONE_ACCOUNT = 8
    const val STATE_CONNECTING = 9
    const val STATE_DISCONNECTING = 10
    const val STATE_PULLING_CALL = 11
    const val STATE_AUDIO_PROCESSING = 12
    const val STATE_SIMULATED_RINGING = 13

    fun fromAndroidState(state: Int): GatewayCallState = when (state) {
        STATE_NEW -> GatewayCallState.NEW
        STATE_CONNECTING -> GatewayCallState.CONNECTING
        STATE_SELECT_PHONE_ACCOUNT -> GatewayCallState.SELECT_PHONE_ACCOUNT
        STATE_DIALING -> GatewayCallState.DIALING
        STATE_RINGING -> GatewayCallState.RINGING
        STATE_ACTIVE -> GatewayCallState.ACTIVE
        STATE_HOLDING -> GatewayCallState.HOLDING
        STATE_DISCONNECTING -> GatewayCallState.DISCONNECTING
        STATE_DISCONNECTED -> GatewayCallState.DISCONNECTED
        STATE_PULLING_CALL -> GatewayCallState.PULLING
        STATE_AUDIO_PROCESSING -> GatewayCallState.AUDIO_PROCESSING
        STATE_SIMULATED_RINGING -> GatewayCallState.SIMULATED_RINGING
        else -> GatewayCallState.UNKNOWN
    }
}
