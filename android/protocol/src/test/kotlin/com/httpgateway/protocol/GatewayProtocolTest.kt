package com.httpgateway.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class GatewayProtocolTest {
    @Test
    fun `parses a call action command`() {
        val result = GatewayCommandParser.parse(
            """{"type":"command","commandId":"cmd-1","callId":"call-1","action":"answer","payload":{}}""",
        )

        val success = assertIs<CommandParseResult.Success>(result)
        assertEquals("cmd-1", success.command.commandId)
        assertEquals(CommandAction.ANSWER, success.command.action)
        assertEquals("call-1", success.command.callId)
    }

    @Test
    fun `dial requires a number in payload`() {
        val result = GatewayCommandParser.parse(
            """{"type":"command","commandId":"cmd-2","callId":"call-2","action":"dial","payload":{}}""",
        )

        assertEquals(CommandParseResult.Error("number_required"), result)
    }

    @Test
    fun `dtmf validates digits`() {
        val result = GatewayCommandParser.parse(
            """{"type":"command","commandId":"cmd-3","callId":"call-1","action":"dtmf","payload":{"digits":"12X#"}}""",
        )

        assertEquals(CommandParseResult.Error("invalid_dtmf_digits"), result)
    }

    @Test
    fun `rejects malformed scalar fields without throwing`() {
        val result = GatewayCommandParser.parse(
            """{"type":{"bad":true},"commandId":"cmd-4","callId":"call-1","action":"answer"}""",
        )

        assertEquals(CommandParseResult.Error("missing_message_type"), result)
    }

    @Test
    fun `maps android call states`() {
        assertEquals(GatewayCallState.RINGING, CallStateMapper.fromAndroidState(2))
        assertEquals(GatewayCallState.ACTIVE, CallStateMapper.fromAndroidState(4))
        assertEquals(GatewayCallState.DISCONNECTED, CallStateMapper.fromAndroidState(7))
        assertEquals(GatewayCallState.UNKNOWN, CallStateMapper.fromAndroidState(999))
    }
}
