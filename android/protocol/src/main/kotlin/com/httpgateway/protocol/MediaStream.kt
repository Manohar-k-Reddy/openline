package com.httpgateway.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI
import java.net.URLEncoder

/** Live call audio stream between the phone and the gateway (see docs/notes/PROTOCOL.md). */
object MediaStream {
    const val SAMPLE_RATE = 16_000
    const val FRAME_MS = 20

    /** 16-bit mono PCM, little-endian. */
    const val FRAME_BYTES = SAMPLE_RATE / 1000 * FRAME_MS * 2

    private const val DEVICE_CHANNEL_PATH = "/v1/device-channel"
    private const val DEVICE_MEDIA_PATH = "/v1/device-media"

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Derives the per-call media URL from the configured device-channel URL, keeping any
     * reverse-proxy path prefix: ws://h/gw/v1/device-channel -> ws://h/gw/v1/device-media?callId=...
     */
    fun deviceMediaUrl(deviceChannelUrl: String, callId: String): String {
        val uri = URI(deviceChannelUrl.trim())
        val prefix = uri.rawPath.orEmpty().trimEnd('/').removeSuffix(DEVICE_CHANNEL_PATH)
        return "${uri.scheme}://${uri.rawAuthority}$prefix$DEVICE_MEDIA_PATH" +
            "?callId=${URLEncoder.encode(callId, Charsets.UTF_8)}"
    }

    /** True for the server's `{"type":"clear"}` control message (drop queued agent audio). */
    fun isClearMessage(text: String): Boolean = runCatching {
        val type = (json.parseToJsonElement(text) as? JsonObject)?.get("type") as? JsonPrimitive
        type?.content == "clear"
    }.getOrDefault(false)
}
