package com.httpgateway.dialer.shell

import android.content.Context
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64

/** App-side client for the shell server's local control channel. Call off the main thread. */
class ShellClient(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("shell_server", Context.MODE_PRIVATE)

    /** Changes on every APK install/update, so a server running stale code gets replaced. */
    val version: Long = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime

    val port: Int = DEFAULT_PORT

    /** Shared secret passed on the launch command line; app-private, not visible to other apps. */
    val token: String
        get() = prefs.getString(KEY_TOKEN, null) ?: newToken().also {
            prefs.edit().putString(KEY_TOKEN, it).apply()
        }

    /** Server reply, or null when no compatible server is running. */
    fun ping(): JSONObject? = request(JSONObject().put("op", "ping"))
        ?.takeIf { it.optBoolean("ok") && it.optLong("version") == version }

    fun isRunning(): Boolean = ping() != null

    fun start(callId: String, mediaUrl: String, deviceId: String, deviceToken: String): JSONObject? =
        request(
            JSONObject()
                .put("op", "start")
                .put("callId", callId)
                .put("mediaUrl", mediaUrl)
                .put("deviceId", deviceId)
                .put("deviceToken", deviceToken),
        )

    fun stop(callId: String): JSONObject? = request(JSONObject().put("op", "stop").put("callId", callId))

    fun exit(): JSONObject? = request(JSONObject().put("op", "exit"))

    private fun request(body: JSONObject): JSONObject? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", port), 1_000)
            socket.soTimeout = 10_000
            val writer = socket.getOutputStream().bufferedWriter()
            writer.write(body.put("token", token).toString())
            writer.newLine()
            writer.flush()
            socket.getInputStream().bufferedReader().readLine()?.let(::JSONObject)
        }
    }.getOrNull()

    private fun newToken(): String = ByteArray(24).also(SecureRandom()::nextBytes)
        .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    private companion object {
        const val DEFAULT_PORT = 47_811
        const val KEY_TOKEN = "token"
    }
}
