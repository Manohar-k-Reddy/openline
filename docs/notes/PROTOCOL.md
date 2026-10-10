# Device Protocol v0

This protocol intentionally separates the public REST API from the device
transport. A future Android, Linux/LTE, or SIP gateway can implement the same
contract.

## Device authentication

Each device has:

- `deviceId`: public identifier such as `dev_pixel_01`;
- `deviceToken`: random secret unique to that device.

The development WebSocket transport may carry these as query parameters. A
production deployment should use `wss://` and prefer an authorization header or
short-lived signed token where the client library allows it.

## Command envelope

Server -> device:

```json
{
  "type": "command",
  "commandId": "cmd_01J...",
  "callId": "call_01J...",
  "action": "dial",
  "payload": {
    "to": "+919876543210"
  }
}
```

Supported MVP actions:

| Action | Required payload | Meaning |
| --- | --- | --- |
| `dial` | `{ "to": "..." }` | Place an outgoing SIM call |
| `answer` | none | Answer a ringing call |
| `reject` | none | Reject a ringing call |
| `hangup` | none | Disconnect a call |
| `hold` | none | Hold an active call |
| `unhold` | none | Resume a held call |
| `dtmf` | `{ "digits": "12#" }` | Send DTMF digits sequentially |

## Command acknowledgement

Device -> server:

```json
{
  "type": "ack",
  "commandId": "cmd_01J...",
  "callId": "call_01J...",
  "ok": true,
  "timestamp": "2026-09-07T16:20:00.000Z"
}
```

Failure example:

```json
{
  "type": "ack",
  "commandId": "cmd_01J...",
  "callId": "call_01J...",
  "ok": false,
  "error": "call_not_found",
  "timestamp": "2026-09-07T16:20:00.000Z"
}
```

## Call event envelope

Device -> server:

```json
{
  "type": "event",
  "eventId": "evt_01J...",
  "callId": "call_01J...",
  "event": "call.active",
  "timestamp": "2026-09-07T16:20:01.000Z",
  "payload": {
    "number": "+919876543210",
    "direction": "outgoing"
  }
}
```

MVP events:

- `call.new`
- `call.ringing`
- `call.dialing`
- `call.active`
- `call.holding`
- `call.disconnected`
- `call.failed`

## Public REST surface

Target shape:

```text
GET    /health
GET    /v1/devices
POST   /v1/devices
GET    /v1/devices/:deviceId

POST   /v1/calls
GET    /v1/calls
GET    /v1/calls/:callId

POST   /v1/calls/:callId/answer
POST   /v1/calls/:callId/reject
POST   /v1/calls/:callId/hangup
POST   /v1/calls/:callId/hold
POST   /v1/calls/:callId/unhold
POST   /v1/calls/:callId/dtmf
```

Also implemented: `GET /v1/calls/:callId/events`, `GET /v1/calls/:callId/transcript`,
`GET /v1/webhook-deliveries`, API keys (`/v1/api-keys`), settings (`/v1/settings`) and console
sign-in (`/v1/auth/*`). See the README.

The REST server should respond once a command has been queued/delivered, not
pretend that the carrier operation already succeeded. Actual state arrives from
the Android `InCallService` event stream.

## Agent streams (server connects to your agent)

The usual way to put an AI agent on a call. Instead of your code joining the media WebSocket,
the gateway opens a WebSocket **to your agent** once the call connects, like Twilio's
`<Connect><Stream>`. Works for outgoing and incoming calls.

```text
POST   /v1/calls                { deviceId, to, stream: { url, format, parameters? } }
POST   /v1/calls/:callId/stream { url, format, parameters? }   attach to a live call (answers a ringing one)
GET    /v1/calls/:callId/stream                                status: off | waiting | connecting | live | ended | error
DELETE /v1/calls/:callId/stream                                detach
```

`url` is `ws://` or `wss://`. For every incoming call, set **Settings → Incoming calls** (or
`PUT /v1/settings { incomingStreamUrl, incomingStreamFormat }`): the gateway answers and streams
it; the built-in assistant then stays out.

Formats:

- `raw` (default): first a text message
  `{"type":"start","callId","direction","remoteNumber","deviceId",...parameters,"format":{...}}`,
  then binary 16 kHz mono s16le frames both ways. Send `{"type":"clear"}` to drop queued speech.
  A final `{"type":"stop"}` arrives when the call ends.
- `twilio`: Twilio Media Streams messages, so Twilio integrations (e.g. Pipecat's
  `TwilioFrameSerializer`) work unchanged: `connected`, `start` (with `callSid` = gateway call
  id, `customParameters` = call details plus `parameters`), `media` (base64 8 kHz mu-law),
  `mark` and `stop`. Your agent may send `media`, `mark` (echoed back once the audio before it has
  played) and `clear`.

Closing the socket from your side hangs up the call. If the agent can't be reached, the call is
hung up too, so a caller is never left in silence. Example: `simulator/echo-agent.mjs`.

## Phone health

Besides events, the phone sends a health report on connect, every 60 s and when its network
changes. The server stores the latest one and shows it on the Connection page and in
`GET /v1/devices` (`device.health`). All fields are optional.

```json
{"type":"health","battery":82,"charging":false,"network":"cellular","signal":3,
 "carrier":"Jio","audio":"running","appVersion":"0.1.0","android":"16","model":"Vivo V2348"}
```

`network` is `wifi`, `cellular`, `ethernet`, `other` or `none`. `audio` is the call-audio helper:
`running`, `stopped` or `pairing_required`. The server also pings the phone every 20 s; the
round trip is `device.latencyMs`, and a phone that misses two pings is dropped as offline.

## Live call audio (media stream)

While a call is `active`, the phone streams call audio through the gateway. Developers and AI
agents connect to one WebSocket per call and receive what the remote party says, and send audio
that is injected into the call.

Audio format, both directions: raw PCM, signed 16-bit little-endian, 16 kHz, mono
(`pcm_s16le`). The phone sends 20 ms frames (640 bytes); clients may send any even-sized chunk,
but should pace sends at roughly real time so `clear` stays effective.

### Client leg: `GET /v1/calls/{callId}/media` (WebSocket)

Authenticate with `x-api-key`, `Authorization: Bearer <key>`, or `?apiKey=` (for clients that
cannot set headers). `GET /v1/calls/{callId}` returns the path and `streaming` flag under `media`.

| Direction | Frame | Meaning |
|---|---|---|
| server → client | binary | remote party audio |
| server → client | `{"type":"start","callId","format":{...}}` | phone audio is live (sent on connect if already live) |
| server → client | `{"type":"stop","callId","reason"}` | phone audio ended |
| client → server | binary | audio to inject into the call |
| client → server | `{"type":"clear"}` | drop queued injected audio (barge-in) |

One client per call; a newer connection replaces the older one (close code 4000).

### Phone leg: `GET /v1/device-media?callId=...` (WebSocket)

Authenticated like the device channel (`X-Device-Id` / `X-Device-Token` or query). The call must
belong to the device. The phone opens it when the call becomes active and closes it when the call
disconnects; it receives client binary frames and `{"type":"clear"}`.

On Android the call is first moved into background audio processing (call-screening mode), so
the phone itself neither plays the call nor uses its mic. The audio runs in the app's own
shell-UID server (launched via built-in wireless ADB, see `docs/SINGLE_APK_SPEC.md`): `VOICE_DOWNLINK` capture
and playback routed to the `TELEPHONY` output device (call uplink). Injected audio is not present
in the captured stream, so agents do not hear themselves.

## Idempotency

For production:

- accept an `Idempotency-Key` on `POST /v1/calls`;
- never execute the same `commandId` twice on a device;
- retain recent command IDs across short reconnects;
- treat Android Telecom state as authoritative over optimistic cloud state.

