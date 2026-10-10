---
title: Stream protocol
description: Exact messages exchanged with your agent's WebSocket, in raw and Twilio formats.
---

When a call has a `stream`, the gateway connects to `stream.url` as a WebSocket **client** when
the call is answered. These are the messages on that socket.

## Raw format (`"format": "raw"`)

**OpenLine → agent**

```json
{"type":"start","callId":"8c1d…","direction":"outgoing","remoteNumber":"+919876543210",
 "deviceId":"phone-7f3a91c2","customerId":"c_123",
 "format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"frameMs":20}}
```

Your `parameters` are merged into the start message. Then binary frames: the other person's
voice, 16 kHz mono s16le, 640 bytes (20 ms) each. When the call ends:

```json
{"type":"stop","callId":"8c1d…"}
```

**Agent → gateway**

- Binary PCM in the same format, any length. Played in order.
- `{"type":"clear"}` drops audio that hasn't played yet.

## Twilio format (`"format": "twilio"`)

Matches Twilio Media Streams for a bidirectional `<Connect><Stream>`.

**OpenLine → agent**

```json
{"event":"connected","protocol":"Call","version":"1.0.0"}
```

```json
{"event":"start","sequenceNumber":"1","streamSid":"MZ8c1d…",
 "start":{"streamSid":"MZ8c1d…","accountSid":"local","callSid":"8c1d…","tracks":["inbound"],
          "customParameters":{"callId":"8c1d…","direction":"outgoing","remoteNumber":"+919876543210",
                              "deviceId":"phone-7f3a91c2","customerId":"c_123"},
          "mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1}}}
```

```json
{"event":"media","sequenceNumber":"2","streamSid":"MZ8c1d…",
 "media":{"track":"inbound","chunk":"1","timestamp":"20","payload":"<base64 mu-law, 160 bytes = 20 ms>"}}
```

```json
{"event":"mark","sequenceNumber":"9","streamSid":"MZ8c1d…","mark":{"name":"turn-1"}}
```

```json
{"event":"stop","sequenceNumber":"120","streamSid":"MZ8c1d…","stop":{"accountSid":"local","callSid":"8c1d…"}}
```

**Agent → gateway**

```json
{"event":"media","streamSid":"MZ8c1d…","media":{"payload":"<base64 8 kHz mu-law>"}}
{"event":"mark","streamSid":"MZ8c1d…","mark":{"name":"turn-1"}}
{"event":"clear","streamSid":"MZ8c1d…"}
```

- A `mark` is sent back once all audio you sent before it has played.
- `clear` drops unplayed audio; pending marks are sent back at once, as on Twilio.
- `streamSid` on incoming messages isn't checked.

## Lifecycle

| Situation | What happens |
|---|---|
| Call answered | OpenLine connects, sends `start` (and `connected` first for Twilio). |
| Other person hangs up | OpenLine sends `stop` and closes the socket. |
| Agent closes the socket | OpenLine hangs up the call. |
| Agent unreachable or socket errors | OpenLine hangs up the call; `GET /v1/calls/{id}/stream` shows the error. |
| `DELETE /v1/calls/{id}/stream` | OpenLine closes the socket; the call continues. |

## Audio conversion

Twilio format converts on the fly: 16 kHz PCM → 8 kHz mu-law towards your agent (pairs of
samples averaged), and 8 kHz mu-law → 16 kHz PCM towards the call (linear interpolation). Use
`raw` for the best quality.
