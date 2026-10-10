package com.httpgateway.dialer.config

import android.content.Context
import com.httpgateway.dialer.BuildConfig
import java.util.UUID

data class GatewayConfig(
    val wsUrl: String,
    val deviceId: String,
    val deviceToken: String,
)

class GatewayConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("gateway_config", Context.MODE_PRIVATE)

    fun load(): GatewayConfig {
        var deviceId = prefs.getString(KEY_DEVICE_ID, null).orEmpty()
        if (deviceId.isBlank()) {
            deviceId = "device_${UUID.randomUUID()}"
            prefs.edit().putString(KEY_DEVICE_ID, deviceId).apply()
        }

        return GatewayConfig(
            wsUrl = prefs.getString(KEY_WS_URL, BuildConfig.DEFAULT_GATEWAY_WS_URL)
                ?.takeIf { it.isNotBlank() }
                ?: BuildConfig.DEFAULT_GATEWAY_WS_URL,
            deviceId = deviceId,
            deviceToken = prefs.getString(KEY_DEVICE_TOKEN, "").orEmpty(),
        )
    }

    fun save(config: GatewayConfig) {
        prefs.edit()
            .putString(KEY_WS_URL, config.wsUrl.trim())
            .putString(KEY_DEVICE_ID, config.deviceId.trim())
            .putString(KEY_DEVICE_TOKEN, config.deviceToken.trim())
            .commit() // synchronous: the runtime reconnects with this config right after
    }

    private companion object {
        const val KEY_WS_URL = "ws_url"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_TOKEN = "device_token"
    }
}
