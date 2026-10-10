package com.httpgateway.dialer.telecom

import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.InCallService
import android.util.Log
import com.httpgateway.dialer.InCallActivity
import com.httpgateway.dialer.audio.CallAudioBridge
import com.httpgateway.dialer.transport.GatewayRuntime
import org.lsposed.hiddenapibypass.HiddenApiBypass

class GatewayInCallService : InCallService() {
    private companion object {
        const val TAG = "GatewayInCallService"
    }

    private val callbacks = mutableMapOf<Call, Call.Callback>()

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        val entry = CallRegistry.register(call)
        val callback = object : Call.Callback() {
            override fun onStateChanged(call: Call, state: Int) {
                GatewayRuntime.emitCallState(entry.callId, call)
                syncCallAudio(entry.callId, call)
                CallRegistry.notifyChanged()
            }

            override fun onDetailsChanged(call: Call, details: Call.Details) {
                GatewayRuntime.emitCallState(entry.callId, call)
                CallRegistry.notifyChanged()
            }
        }
        callbacks[call] = callback
        call.registerCallback(callback)

        GatewayRuntime.emitCallAdded(entry.callId, call)
        syncCallAudio(entry.callId, call)
        showInCallUi()
    }

    override fun onCallRemoved(call: Call) {
        val callId = CallRegistry.callIdFor(call)
        callbacks.remove(call)?.let(call::unregisterCallback)
        if (callId != null) {
            CallAudioBridge.onCallEnded(callId)
            GatewayRuntime.emitCallRemoved(callId, call)
        }
        CallRegistry.remove(call)
        super.onCallRemoved(call)
    }

    /**
     * Router mode: an active call is moved into background audio processing (the call-screening
     * mode, default dialer only), so Telecom neither plays it on the phone nor uses the phone's mic.
     * Audio then streams only between the call and the gateway until the call disconnects.
     */
    private fun syncCallAudio(callId: String, call: Call) {
        when (CallRegistry.androidState(call)) {
            Call.STATE_ACTIVE -> {
                val routed = runCatching { enterBackgroundAudioProcessing(call) }
                    .onFailure { Log.w(TAG, "background audio processing refused for $callId", it) }
                    .isSuccess
                if (!routed) CallAudioBridge.onCallActive(callId)
            }
            Call.STATE_AUDIO_PROCESSING -> CallAudioBridge.onCallActive(callId)
            Call.STATE_DISCONNECTING, Call.STATE_DISCONNECTED -> CallAudioBridge.onCallEnded(callId)
        }
    }

    /** `Call.enterBackgroundAudioProcessing()` is @SystemApi; Telecom only requires the default dialer. */
    private fun enterBackgroundAudioProcessing(call: Call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) HiddenApiBypass.addHiddenApiExemptions("Landroid/telecom/Call;")
        Call::class.java.getMethod("enterBackgroundAudioProcessing").invoke(call)
    }

    private fun showInCallUi() {
        startActivity(
            Intent(this, InCallActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }
}
