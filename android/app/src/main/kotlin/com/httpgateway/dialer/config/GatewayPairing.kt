package com.httpgateway.dialer.config

import android.content.Context
import android.net.Uri
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * QR pairing: the admin console shows `httpgateway://pair?url=<server>&code=<one-time code>`.
 * The app exchanges the code for device credentials and derives the WebSocket endpoint from the
 * server URL (https -> wss), so nothing has to be typed.
 */
object GatewayPairing {
    data class Invite(val serverUrl: String, val code: String)

    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()

    fun parse(text: String): Invite? {
        val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
        if (uri.scheme != "httpgateway" || uri.host != "pair") return null
        val server = uri.getQueryParameter("url")?.trimEnd('/') ?: return null
        val code = uri.getQueryParameter("code") ?: return null
        if (!server.startsWith("http://") && !server.startsWith("https://")) return null
        return Invite(server, code)
    }

    /** Blocking network call; returns the saved config or throws with a user-readable message. */
    fun pair(context: Context, invite: Invite): GatewayConfig {
        val body = JSONObject()
            .put("code", invite.code)
            .put("name", "${Build.MANUFACTURER.replaceFirstChar(Char::uppercase)} ${Build.MODEL}")
            .toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("${invite.serverUrl}/v1/pair").post(body).build()
        val json = client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val parsed = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            if (!response.isSuccessful) {
                val message = parsed.optJSONObject("error")?.optString("message")
                throw IllegalStateException(message?.takeIf { it.isNotBlank() } ?: "server answered HTTP ${response.code}")
            }
            parsed
        }
        val config = GatewayConfig(
            wsUrl = invite.serverUrl.replaceFirst(Regex("^http"), "ws") +
                json.optString("deviceChannelPath", "/v1/device-channel"),
            deviceId = json.getJSONObject("device").getString("id"),
            deviceToken = json.getString("deviceToken"),
        )
        GatewayConfigStore(context).save(config)
        return config
    }
}
