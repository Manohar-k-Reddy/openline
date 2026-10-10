package com.httpgateway.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MediaStreamTest {
    @Test
    fun `frames are 20 ms of 16 kHz mono pcm16`() {
        assertEquals(640, MediaStream.FRAME_BYTES)
    }

    @Test
    fun `derives media url from device channel url`() {
        assertEquals(
            "ws://192.168.1.5:8787/v1/device-media?callId=call_1",
            MediaStream.deviceMediaUrl("ws://192.168.1.5:8787/v1/device-channel", "call_1"),
        )
    }

    @Test
    fun `keeps proxy prefix and drops channel query`() {
        assertEquals(
            "wss://example.com/gw/v1/device-media?callId=a%2Fb",
            MediaStream.deviceMediaUrl("wss://example.com/gw/v1/device-channel/?x=1", "a/b"),
        )
    }

    @Test
    fun `recognizes clear control message`() {
        assertTrue(MediaStream.isClearMessage("""{"type":"clear"}"""))
        assertFalse(MediaStream.isClearMessage("""{"type":"start"}"""))
        assertFalse(MediaStream.isClearMessage("not json"))
    }
}
