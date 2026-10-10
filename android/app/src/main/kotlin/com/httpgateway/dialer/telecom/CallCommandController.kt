package com.httpgateway.dialer.telecom

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.TelecomManager
import android.telecom.VideoProfile
import android.telephony.TelephonyManager
import com.httpgateway.protocol.CommandAction
import com.httpgateway.protocol.GatewayCommand

class CallCommandController(context: Context) {
    data class Result(val ok: Boolean, val error: String? = null)

    private val appContext = context.applicationContext
    private val telecomManager = appContext.getSystemService(TelecomManager::class.java)
    private val telephonyManager = appContext.getSystemService(TelephonyManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())

    fun handle(command: GatewayCommand, callback: (Result) -> Unit) {
        mainHandler.post {
            val result = try {
                execute(command)
            } catch (_: SecurityException) {
                Result(false, "telecom_permission_denied")
            } catch (_: Exception) {
                Result(false, "telecom_action_failed")
            }
            callback(result)
        }
    }

    private fun execute(command: GatewayCommand): Result = when (command.action) {
        CommandAction.DIAL -> dial(command.callId, requireNotNull(command.to))
        CommandAction.ANSWER -> withCall(command.callId) {
            it.answer(VideoProfile.STATE_AUDIO_ONLY)
            Result(true)
        }
        CommandAction.REJECT -> withCall(command.callId) {
            CallRegistry.markRejected(command.callId)
            try {
                it.reject(false, null)
                Result(true)
            } catch (error: Exception) {
                CallRegistry.clearRejected(command.callId)
                throw error
            }
        }
        CommandAction.HANGUP -> withCall(command.callId) {
            it.disconnect()
            Result(true)
        }
        CommandAction.HOLD -> withCall(command.callId) {
            it.hold()
            Result(true)
        }
        CommandAction.UNHOLD -> withCall(command.callId) {
            it.unhold()
            Result(true)
        }
        CommandAction.DTMF -> withCall(command.callId) {
            playDtmfSequence(it, requireNotNull(command.digits))
            Result(true)
        }
    }

    private fun dial(callId: String, number: String): Result {
        if (appContext.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            return Result(false, "call_phone_permission_missing")
        }
        if (telephonyManager.isEmergencyNumber(number)) {
            return Result(false, "emergency_number_not_allowed")
        }

        CallRegistry.reserveOutgoing(callId, number)
        return try {
            telecomManager.placeCall(Uri.fromParts("tel", number, null), Bundle())
            Result(true)
        } catch (e: Exception) {
            CallRegistry.cancelOutgoingReservation(callId)
            throw e
        }
    }

    private inline fun withCall(callId: String, action: (Call) -> Result): Result {
        val call = CallRegistry.get(callId) ?: return Result(false, "call_not_found")
        return action(call)
    }

    private fun playDtmfSequence(call: Call, digits: String) {
        fun playAt(index: Int) {
            if (index >= digits.length) return
            call.playDtmfTone(digits[index])
            mainHandler.postDelayed({
                call.stopDtmfTone()
                mainHandler.postDelayed({ playAt(index + 1) }, DTMF_GAP_MS)
            }, DTMF_TONE_MS)
        }
        playAt(0)
    }

    private companion object {
        const val DTMF_TONE_MS = 120L
        const val DTMF_GAP_MS = 70L
    }
}
