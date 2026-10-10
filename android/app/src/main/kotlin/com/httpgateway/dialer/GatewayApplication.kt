package com.httpgateway.dialer

import android.app.Application
import com.httpgateway.dialer.audio.CallAudioBridge
import com.httpgateway.dialer.transport.GatewayConnectionService
import com.httpgateway.dialer.transport.GatewayRuntime

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CallAudioBridge.initialize(this)
        GatewayRuntime.initialize(this)
        GatewayConnectionService.start(this)
    }
}
