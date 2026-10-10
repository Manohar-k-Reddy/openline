package com.httpgateway.dialer.shell

import android.os.Process
import android.util.Log
import com.httpgateway.dialer.audio.CallAudioEngine
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.system.exitProcess

/**
 * Entry point of the shell-UID server, launched by [ShellLauncher] through wireless ADB:
 *   app_process /system/bin --nice-name=httpgateway_shell ...ShellServerMain <port> <token> <version>
 *
 * Control protocol: one JSON object per line on 127.0.0.1:<port>, each carrying the token.
 *   {"op":"ping"} -> {"ok":true,"uid":2000,"version":N,"callId":...}
 *   {"op":"start","callId","mediaUrl","deviceId","deviceToken"} / {"op":"stop","callId"} / {"op":"exit"}
 */
object ShellServerMain {
    private const val TAG = "HttpGatewayShell"

    @JvmStatic
    fun main(args: Array<String>) {
        val port = args.getOrNull(0)?.toIntOrNull() ?: exitWith("missing port")
        val token = args.getOrNull(1) ?: exitWith("missing token")
        val version = args.getOrNull(2)?.toLongOrNull() ?: 0L

        val context = runCatching { ShellRuntime.install() }
            .onFailure { Log.e(TAG, "shell context unavailable", it) }
            .getOrNull()
        val engine = CallAudioEngine(context)
        val server = try {
            ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"))
        } catch (e: Exception) {
            exitWith("cannot bind 127.0.0.1:$port: $e")
        }
        Log.i(TAG, "listening on 127.0.0.1:$port uid=${Process.myUid()} version=$version")

        while (true) {
            val socket = server.accept()
            Thread({ serve(socket, token, version, engine) }, "shell-control").start()
        }
    }

    private fun serve(socket: Socket, token: String, version: Long, engine: CallAudioEngine) {
        socket.use {
            socket.soTimeout = 10_000
            val reader = socket.getInputStream().bufferedReader()
            val writer = socket.getOutputStream().bufferedWriter()
            val reply = runCatching {
                val request = JSONObject(reader.readLine() ?: return)
                if (request.optString("token") != token) return
                handle(request, version, engine)
            }.getOrElse { JSONObject().put("ok", false).put("error", it.message ?: it.toString()) }
            writer.write(reply.toString())
            writer.newLine()
            writer.flush()
        }
    }

    private fun handle(request: JSONObject, version: Long, engine: CallAudioEngine): JSONObject {
        val ok = JSONObject().put("ok", true)
        when (request.getString("op")) {
            "ping" -> ok.put("uid", Process.myUid()).put("version", version).put("callId", engine.activeCallId())
            "start" -> engine.start(
                CallAudioEngine.Target(
                    callId = request.getString("callId"),
                    mediaUrl = request.getString("mediaUrl"),
                    deviceId = request.getString("deviceId"),
                    deviceToken = request.getString("deviceToken"),
                ),
            )
            "stop" -> engine.stop(request.optString("callId").takeIf { it.isNotEmpty() })
            "exit" -> Thread {
                engine.stop()
                Thread.sleep(200)
                exitProcess(0)
            }.start()
            else -> return JSONObject().put("ok", false).put("error", "unknown op")
        }
        return ok
    }

    private fun exitWith(message: String): Nothing {
        Log.e(TAG, message)
        System.err.println(message)
        exitProcess(1)
    }
}
