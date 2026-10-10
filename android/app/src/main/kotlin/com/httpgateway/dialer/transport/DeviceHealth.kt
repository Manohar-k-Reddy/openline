package com.httpgateway.dialer.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.telephony.TelephonyManager
import com.httpgateway.dialer.BuildConfig
import com.httpgateway.dialer.audio.CallAudioBridge
import org.json.JSONObject

/** The phone's health report for the server's Connection page. Blocking (checks the audio helper). */
object DeviceHealth {
    fun collect(context: Context): String {
        val json = JSONObject().put("type", "health")
        runCatching {
            val battery = context.getSystemService(BatteryManager::class.java)
            json.put("battery", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            json.put("charging", battery.isCharging)
        }
        json.put("network", networkType(context))
        runCatching {
            val telephony = context.getSystemService(TelephonyManager::class.java)
            telephony.networkOperatorName?.takeIf { it.isNotBlank() }?.let { json.put("carrier", it.take(64)) }
            telephony.signalStrength?.level?.let { json.put("signal", it.coerceIn(0, 4)) }
        }
        runCatching {
            json.put(
                "audio",
                when (CallAudioBridge.status(context)) {
                    CallAudioBridge.Status.READY -> "running"
                    CallAudioBridge.Status.STOPPED -> "stopped"
                    CallAudioBridge.Status.SETUP_REQUIRED -> "pairing_required"
                },
            )
        }
        json.put("appVersion", BuildConfig.VERSION_NAME)
        json.put("android", Build.VERSION.RELEASE)
        json.put("model", "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(64))
        return json.toString()
    }

    fun networkType(context: Context): String {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    fun isOnWifi(context: Context): Boolean = networkType(context) == "wifi"
}
