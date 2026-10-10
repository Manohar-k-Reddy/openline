package com.httpgateway.dialer.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.httpgateway.dialer.BuildConfig
import org.lsposed.hiddenapibypass.HiddenApiBypass

/**
 * Starts the shell-UID audio server through this phone's own adbd, the way Shizuku does, so a
 * single APK needs no Shizuku app, root or PC. Blocking; call off the main thread.
 *
 * Wireless debugging only runs on Wi-Fi. So the first start (on Wi-Fi) also switches adbd to its
 * classic TCP mode on [TCP_PORT]; until the next reboot the app then reaches adbd on 127.0.0.1
 * without Wi-Fi, e.g. after an app update on mobile data. adbd still accepts only authorized keys.
 */
object ShellLauncher {
    private const val TAG = "ShellLauncher"
    private const val CONNECT_TIMEOUT_MS = 10_000L
    private const val PROCESS_NAME = "httpgateway_shell"
    private const val TCP_PORT = 5555
    private const val LOOPBACK_TIMEOUT_MS = 4_000L

    sealed interface Result {
        data object Running : Result
        data object PairingRequired : Result
        /** Not running, and starting it needs Wi-Fi (no reachable adbd without it). */
        data object NeedsWifi : Result
        data class Failed(val reason: String) : Result
    }

    fun isPaired(context: Context): Boolean = prefs(context).getBoolean(KEY_PAIRED, false)

    /** One-time pairing with the 6-digit code from "Pair device with pairing code". */
    fun pair(context: Context, port: Int, code: String) {
        prepare()
        check(GatewayAdbManager.get(context).pair("127.0.0.1", port, code.trim())) { "pairing rejected" }
        prefs(context).edit().putBoolean(KEY_PAIRED, true).apply()
    }

    /** Ensures the shell server is running (re-enabling Wireless debugging if allowed). */
    /** Serialized: concurrent launches would kill each other's server (`pkill`) and race for the port. */
    @Synchronized
    fun ensureRunning(context: Context): Result =
        launch(context).also { if (it != Result.Running) Log.w(TAG, "shell server not running: $it") }

    private fun launch(context: Context): Result {
        val client = ShellClient(context)
        if (client.isRunning()) return Result.Running
        if (!isPaired(context)) return Result.PairingRequired

        val adb = GatewayAdbManager.get(context)
        return try {
            prepare()
            if (!adb.isConnected && !connectLoopback(adb)) {
                if (!isOnWifi(context)) return Result.NeedsWifi
                enableWirelessDebugging(context)
                if (!adb.autoConnect(context, CONNECT_TIMEOUT_MS)) {
                    return Result.Failed("Wireless debugging not reachable (is it on and is Wi-Fi connected?)")
                }
                switchToTcpMode(context, adb)
            }
            grantSelfPermissions(adb)
            client.exit() // a stale server from an older install still holds the port
            shell(adb, launchCommand(context, client))
            repeat(30) {
                if (client.isRunning()) return Result.Running
                Thread.sleep(200)
            }
            Result.Failed("shell server did not start")
        } catch (e: io.github.muntashirakon.adb.AdbPairingRequiredException) {
            prefs(context).edit().putBoolean(KEY_PAIRED, false).apply()
            Result.PairingRequired
        } catch (e: Exception) {
            Log.e(TAG, "launch failed", e)
            runCatching { adb.disconnect() } // a dead connection (network switched) would be reused otherwise
            Result.Failed(e.message ?: e.toString())
        }
    }

    private fun launchCommand(context: Context, client: ShellClient): String {
        val apk = context.applicationInfo.sourceDir
        val main = ShellServerMain::class.java.name
        // Process names are truncated to 15 chars (`pkill -x` never matches); match the cmdline
        // instead, anchored so the launching shell's own command line can't match.
        return "pkill -f '^$PROCESS_NAME'; sleep 0.3; " +
            "CLASSPATH='$apk' setsid app_process /system/bin --nice-name=$PROCESS_NAME $main " +
            "${client.port} '${client.token}' ${client.version} </dev/null >/dev/null 2>&1 &"
    }

    /** adbd in classic TCP mode, reachable over loopback on any network. */
    private fun connectLoopback(adb: GatewayAdbManager): Boolean =
        runCatching {
            adb.setTimeout(LOOPBACK_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            adb.connect("127.0.0.1", TCP_PORT)
        }.onFailure { Log.i(TAG, "no adbd on 127.0.0.1:$TCP_PORT (${it.message})") }
            .getOrDefault(false)
            .also { adb.setTimeout(CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS) }

    /**
     * Like `adb tcpip 5555`: adbd restarts listening on TCP as well. Must happen before the server
     * starts, since restarting adbd ends the processes it launched. If this phone refuses (or the
     * loopback connection fails), reconnect over Wireless debugging and carry on as before.
     */
    private fun switchToTcpMode(context: Context, adb: GatewayAdbManager) {
        runCatching { shell(adb, "", service = "tcpip:$TCP_PORT") }
            .onFailure { Log.w(TAG, "tcpip request failed", it) }
        runCatching { adb.disconnect() }
        repeat(10) {
            Thread.sleep(700)
            if (connectLoopback(adb)) {
                Log.i(TAG, "adbd now in TCP mode on $TCP_PORT")
                return
            }
        }
        Log.w(TAG, "adbd TCP mode unavailable; staying on Wireless debugging")
        enableWirelessDebugging(context)
        check(adb.isConnected || adb.autoConnect(context, CONNECT_TIMEOUT_MS)) { "Wireless debugging dropped" }
    }

    private fun isOnWifi(context: Context): Boolean {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    /** WRITE_SECURE_SETTINGS lets the app turn Wireless debugging back on after a reboot. */
    private fun grantSelfPermissions(adb: GatewayAdbManager) {
        shell(adb, "pm grant ${BuildConfig.APPLICATION_ID} ${Manifest.permission.WRITE_SECURE_SETTINGS}")
    }

    private fun enableWirelessDebugging(context: Context) {
        val granted = context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) return
        runCatching {
            if (Settings.Global.getInt(context.contentResolver, ADB_WIFI_ENABLED, 0) != 1) {
                Settings.Global.putInt(context.contentResolver, ADB_WIFI_ENABLED, 1)
                Thread.sleep(1_500) // let adbd start the TLS listener
            }
        }.onFailure { Log.w(TAG, "could not enable wireless debugging", it) }
    }

    /** Runs a command and returns its output; libadb reports normal end-of-output as "Stream closed". */
    private fun shell(adb: GatewayAdbManager, command: String, service: String = "shell:$command"): String {
        val output = StringBuilder()
        val stream = adb.openStream(service)
        try {
            val buffer = ByteArray(4096)
            val input = stream.openInputStream()
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                output.append(String(buffer, 0, n))
            }
        } catch (e: java.io.IOException) {
            if (!stream.isClosed && e.message?.contains("closed", ignoreCase = true) != true) throw e
        } finally {
            runCatching { stream.close() }
        }
        if (output.isNotBlank()) Log.i(TAG, "shell output: ${output.trim()}")
        return output.toString()
    }

    /** libadb reaches the platform Conscrypt through hidden APIs. */
    private fun prepare() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) HiddenApiBypass.addHiddenApiExemptions("L")
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences("shell_server", Context.MODE_PRIVATE)

    private const val KEY_PAIRED = "paired"
    private const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
}
