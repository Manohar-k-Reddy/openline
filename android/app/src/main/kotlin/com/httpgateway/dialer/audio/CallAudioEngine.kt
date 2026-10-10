package com.httpgateway.dialer.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import com.httpgateway.protocol.MediaStream
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Runs in the shell-UID server process (CAPTURE_AUDIO_OUTPUT + MODIFY_PHONE_STATE). Captures
 * VOICE_DOWNLINK (remote party), plays agent audio into the TELEPHONY output (call uplink) and
 * exchanges both directly with the gateway media WebSocket. Validated on Vivo V40 / Android 16.
 */
class CallAudioEngine(private val context: Context?) {
    data class Target(val callId: String, val mediaUrl: String, val deviceId: String, val deviceToken: String)

    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private var session: Session? = null

    @Synchronized
    fun start(target: Target) {
        if (session?.target?.callId == target.callId) return
        stop()
        session = Session(target).also(Session::start)
    }

    @Synchronized
    fun stop(callId: String? = null) {
        val current = session ?: return
        if (callId != null && current.target.callId != callId) return
        current.close()
        session = null
    }

    @Synchronized
    fun activeCallId(): String? = session?.target?.callId

    private inner class Session(val target: Target) : WebSocketListener() {
        private val record = buildRecord()
        private val track = buildTrack()
        private val playbackQueue = LinkedBlockingQueue<ByteArray>()

        @Volatile
        private var running = true

        @Volatile
        private var socket: WebSocket? = null
        private val threads = mutableListOf<Thread>()

        fun start() {
            record.startRecording()
            track.play()
            Log.i(TAG, "audio started for ${target.callId}; playback routed to type=${track.routedDevice?.type}")
            threads += thread("capture", ::captureLoop)
            threads += thread("playback", ::playbackLoop)
            connect()
        }

        fun close() {
            running = false
            socket?.close(1000, "call_ended")
            threads.forEach(Thread::interrupt)
            runCatching { record.stop() }
            runCatching { track.stop() }
            threads.forEach { it.join(500) }
            record.release()
            track.release()
            Log.i(TAG, "audio stopped for ${target.callId}")
        }

        private fun connect() {
            if (!running) return
            val request = Request.Builder()
                .url(target.mediaUrl)
                .header("X-Device-Id", target.deviceId)
                .header("X-Device-Token", target.deviceToken)
                .build()
            socket = client.newWebSocket(request, this)
        }

        /** Phone -> gateway: remote party audio in 20 ms frames (dropped while disconnected). */
        private fun captureLoop() {
            val frame = ByteArray(MediaStream.FRAME_BYTES)
            while (running) {
                var read = 0
                while (read < frame.size && running) {
                    val n = record.read(frame, read, frame.size - read)
                    if (n <= 0) return
                    read += n
                }
                socket?.send(frame.toByteString(0, read))
            }
        }

        private fun playbackLoop() {
            while (running) {
                val chunk = try {
                    playbackQueue.poll(100, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    return
                } ?: continue
                track.write(chunk, 0, chunk.size)
            }
        }

        /** Gateway -> phone: agent audio queued for injection. */
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (running) playbackQueue.offer(bytes.toByteArray())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!MediaStream.isClearMessage(text)) return
            playbackQueue.clear()
            runCatching {
                track.pause()
                track.flush()
                track.play()
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "media socket failed for ${target.callId} (http ${response?.code}); retrying", t)
            retry(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (running) retry(webSocket)
        }

        private fun retry(failed: WebSocket) {
            if (!running || socket !== failed) return
            socket = null
            Thread {
                Thread.sleep(1_000)
                connect()
            }.start()
        }

        private fun thread(name: String, body: () -> Unit) =
            Thread({ runCatching(body).onFailure { Log.w(TAG, "$name loop ended", it) } }, "callaudio-$name")
                .apply { start() }

        @SuppressLint("MissingPermission")
        private fun buildRecord(): AudioRecord {
            val minBuf = AudioRecord.getMinBufferSize(
                MediaStream.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val builder = AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_DOWNLINK)
                .setAudioFormat(pcmFormat(AudioFormat.CHANNEL_IN_MONO))
                .setBufferSizeInBytes(maxOf(minBuf, MediaStream.FRAME_BYTES) * 4)
            if (context != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setContext(context)
            val record = builder.build()
            check(record.state == AudioRecord.STATE_INITIALIZED) {
                record.release()
                "VOICE_DOWNLINK capture unavailable"
            }
            return record
        }

        private fun buildTrack(): AudioTrack {
            val minBuf = AudioTrack.getMinBufferSize(
                MediaStream.SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val builder = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(pcmFormat(AudioFormat.CHANNEL_OUT_MONO))
                .setBufferSizeInBytes(maxOf(minBuf, MediaStream.FRAME_BYTES * 4))
                .setTransferMode(AudioTrack.MODE_STREAM)
            if (context != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                builder.setContext(context)
            }
            val track = builder.build()
            val telephony = telephonyOutput() ?: run {
                track.release()
                throw IllegalStateException("TELEPHONY output device not found")
            }
            track.setPreferredDevice(telephony)
            return track
        }
    }

    private companion object {
        const val TAG = "CallAudioEngine"

        fun pcmFormat(channelMask: Int): AudioFormat = AudioFormat.Builder()
            .setSampleRate(MediaStream.SAMPLE_RATE)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(channelMask)
            .build()

        fun telephonyOutput(): AudioDeviceInfo? {
            val getDevices = AudioManager::class.java
                .getDeclaredMethod("getDevicesStatic", Int::class.javaPrimitiveType)
                .apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            val devices = getDevices.invoke(null, AudioManager.GET_DEVICES_OUTPUTS) as Array<AudioDeviceInfo>
            return devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_TELEPHONY }
        }
    }
}
