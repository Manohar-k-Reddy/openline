package com.httpgateway.dialer.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Restarts the shell server after a reboot or app update (needs Wi-Fi; pairing is remembered). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in HANDLED) return
        com.httpgateway.dialer.transport.GatewayConnectionService.start(context)
        if (!ShellLauncher.isPaired(context)) return
        val pending = goAsync()
        Thread {
            try {
                Log.i("BootReceiver", "${intent.action}: ${ShellLauncher.ensureRunning(context)}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    private companion object {
        val HANDLED = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)
    }
}
