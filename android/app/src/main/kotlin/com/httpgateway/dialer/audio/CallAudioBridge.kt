package com.httpgateway.dialer.audio

import android.content.Context
import android.util.Log
import com.httpgateway.dialer.config.GatewayConfigStore
import com.httpgateway.dialer.shell.ShellClient
import com.httpgateway.dialer.shell.ShellLauncher
import com.httpgateway.protocol.MediaStream
import java.util.concurrent.Executors

/**
 * App side of call audio: tells the shell server which call to stream. Audio itself flows
 * directly between the shell server and the gateway; it never passes through this process.
 */
object CallAudioBridge {
    private const val TAG = "CallAudioBridge"

    enum class Status { SETUP_REQUIRED, STOPPED, READY }

    private val worker = Executors.newSingleThreadExecutor { Thread(it, "callaudio-bridge") }

    @Volatile
    private var appContext: Context? = null

    fun initialize(context: Context) {
        appContext = context.applicationContext
        worker.execute { ShellLauncher.ensureRunning(context.applicationContext) }
    }

    /** Blocking (local socket); call off the main thread. */
    fun status(context: Context): Status = when {
        ShellClient(context).isRunning() -> Status.READY
        !ShellLauncher.isPaired(context) -> Status.SETUP_REQUIRED
        else -> Status.STOPPED
    }

    fun restart(context: Context, onResult: (ShellLauncher.Result) -> Unit) {
        worker.execute {
            ShellClient(context).exit()
            Thread.sleep(300)
            onResult(ShellLauncher.ensureRunning(context.applicationContext))
        }
    }

    /** Call became ACTIVE: stream its audio. */
    fun onCallActive(callId: String) {
        val context = appContext ?: return
        worker.execute {
            val config = GatewayConfigStore(context).load()
            if (config.wsUrl.isBlank() || config.deviceToken.isBlank()) return@execute
            val launch = ShellLauncher.ensureRunning(context)
            if (launch != ShellLauncher.Result.Running) {
                Log.w(TAG, "call audio unavailable for $callId: $launch")
                return@execute
            }
            val reply = ShellClient(context).start(
                callId = callId,
                mediaUrl = MediaStream.deviceMediaUrl(config.wsUrl, callId),
                deviceId = config.deviceId,
                deviceToken = config.deviceToken,
            )
            Log.i(TAG, "start $callId -> $reply")
        }
    }

    fun onCallEnded(callId: String) {
        val context = appContext ?: return
        worker.execute { ShellClient(context).stop(callId) }
    }
}
