package com.httpgateway.dialer.transport

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.httpgateway.dialer.DialerActivity
import com.httpgateway.dialer.R

/**
 * Keeps the app process running so the gateway WebSocket survives in the background. Without it
 * Android (and Vivo's power manager in particular) freezes the app within minutes and the phone
 * drops off the gateway.
 */
class GatewayConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        GatewayRuntime.initialize(applicationContext)
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "OpenLine connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while the phone stays connected to your gateway."
                setShowBadge(false)
            },
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, DialerActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Connected to your gateway. Calls can be placed and answered.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "connection"
        private const val NOTIFICATION_ID = 7002

        /** Safe to call from anywhere; background start restrictions are logged, not thrown. */
        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, GatewayConnectionService::class.java)) }
                .onFailure { Log.w("GatewayConnection", "could not start foreground service", it) }
        }
    }
}
