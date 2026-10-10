package com.httpgateway.dialer.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import io.github.muntashirakon.adb.android.AdbMdns
import java.util.concurrent.Executors

/**
 * One-time setup. While the user has "Pair device with pairing code" open in Settings, this
 * service discovers the pairing port over mDNS and collects the 6-digit code through a
 * notification reply (switching apps would close the system pairing dialog), then pairs and
 * starts the shell server.
 */
class PairingService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private var mdns: AdbMdns? = null

    @Volatile
    private var pairingPort = -1

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CODE -> RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(KEY_CODE)?.toString()
                ?.let(::pairWith)
            ACTION_STOP -> stopSelf()
            else -> begin()
        }
        return START_NOT_STICKY
    }

    private fun begin() {
        createChannel()
        val notification = status("Open Settings › Developer options › Wireless debugging › Pair device with pairing code")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (mdns != null) return
        mdns = AdbMdns(this, AdbMdns.SERVICE_TYPE_TLS_PAIRING) { _, port ->
            if (port <= 0 || port == pairingPort) return@AdbMdns
            pairingPort = port
            notify(codePrompt())
        }.also(AdbMdns::start)
    }

    private fun pairWith(code: String) {
        val port = pairingPort
        if (port <= 0) return notify(status("Pairing service not found yet; keep the pairing dialog open."))
        notify(status("Pairing…"))
        worker.execute {
            val message = try {
                ShellLauncher.pair(this, port, code)
                notify(status("Paired. Starting call-audio service…"))
                when (val result = ShellLauncher.ensureRunning(this)) {
                    ShellLauncher.Result.Running -> "Call audio ready. You can close Settings."
                    ShellLauncher.Result.PairingRequired -> "Pairing was not accepted. Try again."
                    ShellLauncher.Result.NeedsWifi -> "Paired. Connect to a Wi-Fi network to start call audio."
                    is ShellLauncher.Result.Failed -> "Paired, but start failed: ${result.reason}"
                }
            } catch (e: Exception) {
                "Pairing failed: ${e.message ?: e}. Check the code and try again."
            }
            notify(status(message, done = true))
            stopForeground(STOP_FOREGROUND_DETACH)
            stopSelf()
        }
    }

    @Deprecated("Android 14 variant of the short-service timeout")
    override fun onTimeout(startId: Int) = timedOut()

    override fun onTimeout(startId: Int, fgsType: Int) = timedOut()

    private fun timedOut() {
        notify(status("Pairing timed out. Tap Set up again in the app.", done = true))
        stopSelf()
    }

    override fun onDestroy() {
        mdns?.stop()
        worker.shutdown()
        super.onDestroy()
    }

    private fun codePrompt(): Notification {
        val input = RemoteInput.Builder(KEY_CODE).setLabel("6-digit pairing code").build()
        val reply = PendingIntent.getService(
            this,
            1,
            Intent(this, PairingService::class.java).setAction(ACTION_CODE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val action = Notification.Action.Builder(null, "Enter code", reply).addRemoteInput(input).build()
        return builder("Pairing service found. Tap \"Enter code\" and type the code shown in Settings.")
            .addAction(action)
            .build()
    }

    private fun status(text: String, done: Boolean = false): Notification =
        builder(text).setOngoing(!done).setAutoCancel(done).build()

    private fun builder(text: String) = Notification.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_phone_call)
        .setContentTitle("OpenLine setup")
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setOnlyAlertOnce(false)

    private fun notify(notification: Notification) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Setup", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    companion object {
        private const val CHANNEL_ID = "setup"
        private const val NOTIFICATION_ID = 7001
        private const val KEY_CODE = "code"
        private const val ACTION_CODE = "com.httpgateway.dialer.PAIRING_CODE"
        private const val ACTION_STOP = "com.httpgateway.dialer.PAIRING_STOP"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, PairingService::class.java))
        }
    }
}
