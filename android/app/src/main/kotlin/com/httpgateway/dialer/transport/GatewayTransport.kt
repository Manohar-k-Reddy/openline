package com.httpgateway.dialer.transport

interface GatewayTransport {
    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed()
        fun onFailure()
    }

    fun setListener(listener: Listener?)
    fun connect()
    fun send(text: String): Boolean
    fun close()
}
