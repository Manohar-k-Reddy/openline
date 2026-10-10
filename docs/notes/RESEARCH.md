# HTTP Gateway — Android SIM Voice Gateway Research

## Goal

Build a self-hosted voice-call control gateway similar in spirit to httpSMS:

```text
Application / API client
        |
        | HTTPS + WebSocket
        v
Gateway server
        |
        | authenticated device command channel
        v
Android default dialer
        |
        | Android Telecom framework
        v
SIM / carrier / PSTN
```

The first production target is **call control**, not cloud call-audio streaming.

## What stock Android supports

An app can become the user-selected default dialer by requesting
`RoleManager.ROLE_DIALER`. Android requires a default-dialer candidate to:

- handle `Intent.ACTION_DIAL`;
- implement `InCallService`;
- provide incoming-call and ongoing-call UI behavior.

Official reference:

- https://developer.android.com/reference/android/telecom/InCallService
- https://developer.android.com/reference/android/app/role/RoleManager

Outgoing calls can be initiated with `TelecomManager.placeCall(...)`.

- https://developer.android.com/reference/android/telecom/TelecomManager

Once Android exposes a managed call to the app through `InCallService`, the
`android.telecom.Call` object provides useful controls including:

- `answer(...)`
- `reject(...)`
- `disconnect()`
- `hold()` / `unhold()`
- `playDtmfTone(...)` / `stopDtmfTone()`

Reference:

- https://developer.android.com/reference/android/telecom/Call

## What stock Android does NOT provide to an ordinary app

The useful telephony audio sources (`VOICE_CALL`, `VOICE_UPLINK`, and
`VOICE_DOWNLINK`) require audio-output capture privileges that are not granted
to normal third-party applications. `CAPTURE_AUDIO_OUTPUT` is explicitly
documented as not for third-party apps.

Reference:

- https://developer.android.com/reference/android/Manifest.permission#CAPTURE_AUDIO_OUTPUT
- https://developer.android.com/reference/android/media/MediaRecorder.AudioSource

Therefore the MVP does **not** claim to provide:

- remote PCM streaming of both sides of a cellular call;
- cloud STT/TTS injection into a normal SIM call;
- hidden call recording.

Those features need a different architecture such as a privileged/system app,
custom Android build, carrier/OEM integration, or dedicated cellular/SIP
gateway hardware.

## MVP capabilities

1. Register an Android device with a device token.
2. Keep an authenticated WebSocket connection from device to server.
3. Create an outgoing call via REST.
4. Deliver the command to the selected Android device.
5. Receive call-state events from Android.
6. Expose call status through REST.
7. Control an active/ringing call:
   - answer
   - reject
   - hang up
   - hold
   - unhold
   - send DTMF
8. Dispatch signed HTTP webhooks for call events.

## Proposed protocol

### Server -> Android

```json
{
  "type": "command",
  "commandId": "cmd_...",
  "callId": "call_...",
  "action": "dial",
  "payload": {
    "to": "+919876543210"
  }
}
```

Other actions: `answer`, `reject`, `hangup`, `hold`, `unhold`, `dtmf`.

### Android -> server

```json
{
  "type": "event",
  "eventId": "evt_...",
  "callId": "call_...",
  "event": "call.active",
  "timestamp": "2026-09-07T16:20:00.000Z",
  "payload": {
    "number": "+919876543210",
    "direction": "outgoing"
  }
}
```

Suggested state events:

- `call.new`
- `call.ringing`
- `call.dialing`
- `call.active`
- `call.holding`
- `call.disconnected`
- `call.failed`

## Security baseline

- A public API key protects application-facing REST routes.
- Each Android device receives its own credential; do not reuse the public API
  key as the device credential.
- The WebSocket connection must be TLS (`wss://`) outside local development.
- Commands must be scoped to the authenticated device.
- Webhooks should include an HMAC signature and timestamp.
- Phone numbers and call metadata are sensitive; logs should avoid unnecessary
  full-number exposure.
- Do not silently place or record calls. Deployment must follow local consent,
  telecom, anti-spam, and privacy requirements.

## Device test plan

1. Build/install the Android app on a real SIM-capable Android phone.
2. Grant runtime call permission if requested.
3. Select the app as the default dialer when Android prompts.
4. Configure the server URL and device credential.
5. Confirm WebSocket device status becomes `online`.
6. POST a test outgoing call to the REST API.
7. Confirm the physical phone starts the call through its SIM.
8. Answer on a second phone and verify `call.active` reaches the server.
9. Test DTMF against an IVR or controlled test endpoint.
10. Test hold/unhold and hangup.
11. Call the gateway phone from a second phone and verify incoming call events.

## Practical limitations to expect

- OEM dialer/Telecom behavior can differ between Android manufacturers.
- Dual-SIM selection needs explicit PhoneAccount handling and real-device tests.
- Background networking can be constrained by Android battery optimizations;
  production transport should use a foreground strategy and/or FCM wake-up.
- Emergency calls are intentionally handled specially by Android and should not
  be automated by this project.
- Emulator testing validates protocol/UI logic but cannot prove real carrier
  telephony behavior.

