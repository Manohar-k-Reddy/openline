---
title: Connect an AI agent
description: Connect AI voice agents (Pipecat, LiveKit workers, custom code) to real phone calls. OpenLine streams calls to your WebSocket in raw PCM or Twilio Media Streams format.
---

The simplest way to put an AI agent on a phone call: tell the gateway where your agent listens,
and it connects the call to it. Your agent runs a WebSocket server; the gateway is the client,
just like Twilio's `<Connect><Stream>`.

## Outgoing calls

Add `stream` when placing the call:

```bash
curl -X POST $OPENLINE_URL/v1/calls \
  -H "Authorization: Bearer $OPENLINE_KEY" -H "content-type: application/json" \
  -d '{
    "deviceId": "phone-7f3a91c2",
    "to": "+919876543210",
    "stream": {
      "url": "wss://agent.example.com/ws",
      "format": "twilio",
      "parameters": { "customerId": "c_123" }
    }
  }'
```

When the callee answers, the gateway opens `wss://agent.example.com/ws` and streams the call.
Nothing connects if nobody picks up.

## Incoming calls

In the console, **Settings → Incoming calls → Stream to your agent**, or by API:

```bash
curl -X PUT $OPENLINE_URL/v1/settings \
  -H "Authorization: Bearer $OPENLINE_KEY" -H "content-type: application/json" \
  -d '{"incomingStreamUrl":"wss://agent.example.com/ws","incomingStreamFormat":"twilio"}'
```

Every incoming call is answered after about a second and connected to your agent. The built-in
assistant stays out of these calls. Clear the URL (`""`) to stop.

## A call that's already live

Attach an agent to any live call, for example one your code answered after a webhook:

```bash
curl -X POST $OPENLINE_URL/v1/calls/$CALL_ID/stream \
  -H "Authorization: Bearer $OPENLINE_KEY" -H "content-type: application/json" \
  -d '{"url":"wss://agent.example.com/ws","format":"raw"}'
```

A ringing incoming call is answered first. `GET` the same path for the status (`waiting`,
`connecting`, `live`, `ended`, `error`); `DELETE` disconnects your agent but keeps the call.

## Ending the call

Close the WebSocket. The gateway hangs up. If your agent can't be reached at all, the gateway
also hangs up, so a caller is never left in silence. When the other person hangs up, your agent
gets a `stop` message and the socket closes.

## Formats

| | `raw` | `twilio` |
|---|---|---|
| Audio | Binary frames, 16 kHz mono s16le, 20 ms (640 bytes) | JSON `media` messages, base64 8 kHz mu-law |
| Start | `{"type":"start", ...}` | `connected`, then `start` |
| Interrupt | `{"type":"clear"}` | `{"event":"clear"}` |
| Playback markers | — | `mark`, echoed back once played |
| Best for | Your own code, best quality | Pipecat and anything built for Twilio |

Full message shapes: [Stream protocol](../../reference/stream-protocol/).

## Example: Pipecat

Pipecat's Twilio integration reads the `connected` and `start` messages and speaks the Twilio
format, so point your Pipecat WebSocket endpoint at the gateway with `"format": "twilio"`. The
start message carries the gateway call id as `callSid` and your `parameters` as
`customParameters`.

```python
# FastAPI endpoint for a Pipecat bot (names follow Pipecat's Twilio example; check the
# Pipecat docs for your version).
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    _, call_data = await parse_telephony_websocket(websocket)   # reads "connected" + "start"
    serializer = TwilioFrameSerializer(
        stream_sid=call_data["stream_id"],
        call_sid=call_data["call_id"],
        # No Twilio account here: let the gateway hang up when the socket closes.
        params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
    )
    await run_bot(websocket, serializer)   # your STT -> LLM -> TTS pipeline
```

When your pipeline ends and closes the socket, the call hangs up.

## Example: raw format in Node

```js
import { WebSocketServer } from "ws";

new WebSocketServer({ port: 9000 }).on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(data);
      if (msg.type === "start") console.log("call", msg.callId, "from", msg.remoteNumber);
      return;
    }
    // data: 20 ms of the caller, 16 kHz s16le. Send your agent's speech back the same way:
    // ws.send(pcmBuffer, { binary: true })
  });
});
```

A complete echo agent for both formats is in `simulator/echo-agent.mjs`.

## Tips

- **Latency:** send audio as soon as you have it. The gateway splits it into 20 ms frames and the
  phone buffers it.
- **Barge-in:** when the caller starts talking over your agent, send `clear` to drop speech that
  hasn't played yet.
- **Exposing a local agent:** your agent needs an address the server can reach. If the agent
  runs on the same machine as the server, `ws://127.0.0.1:9000` works.
- **Who's calling:** the start message includes `callId`, `direction`, `remoteNumber`,
  `deviceId` and your `parameters`.
