# HTTP Gateway — Project Status and Complete Work Log

Last updated: 2026-09-07

## Objective

Build a self-hosted voice-call control gateway inspired by httpSMS, but for Android SIM voice calls.

```text
Application / automation
        |
        | REST
        v
HTTP Gateway server
        |
        | authenticated WebSocket
        v
Android phone acting as gateway
        |
        | Android Telecom
        v
SIM / mobile carrier / PSTN
```

The project deliberately separates **call control** from **call audio**.

## Platform research completed

The supported stock-Android path is:

- request `RoleManager.ROLE_DIALER`;
- handle `ACTION_DIAL`;
- implement `InCallService`;
- place outgoing calls through `TelecomManager.placeCall(...)`;
- control live calls through `android.telecom.Call`.

The public Telecom APIs cover the MVP actions:

- outgoing call;
- incoming-call observation;
- answer;
- reject;
- hangup/disconnect;
- hold/unhold;
- DTMF;
- call-state observation.

Stock Android does **not** give an ordinary third-party dialer unrestricted access to cellular uplink/downlink PCM. `VOICE_CALL`, `VOICE_UPLINK`, `VOICE_DOWNLINK`, and `CAPTURE_AUDIO_OUTPUT` require privileged/system access. Therefore raw PSTN audio streaming, hidden call recording, and direct cloud STT/TTS injection are outside this MVP.

## Server implementation

Location: `server/`

Technology:

- Node.js 20+;
- TypeScript;
- Express;
- `ws`;
- Zod;
- Vitest;
- Supertest.

Implemented:

- application API-key auth;
- device registration;
- per-device random token generation;
- token rotation;
- authenticated WebSocket device channel;
- one active socket per device;
- outgoing call creation;
- incoming call creation from Android events;
- in-memory device/call state;
- event deduplication;
- answer/reject/hangup/hold/unhold/DTMF actions;
- REST fallback event ingestion;
- HMAC-SHA256 signed webhooks;
- validation and structured errors.

Main REST routes:

```text
GET    /health
POST   /v1/devices
GET    /v1/devices
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

The alias `/v1/calls/:callId/actions/:action` is also accepted.

## Android implementation

Location: `android/`

Package:

```text
com.httpgateway.dialer
```

Implemented:

- default-dialer role request;
- `ACTION_DIAL` handling;
- `GatewayInCallService`;
- minimal in-call UI;
- outgoing calls through `TelecomManager.placeCall(...)`;
- answer;
- reject;
- hangup;
- hold;
- unhold;
- sequential DTMF;
- gateway call-ID to Android `Call` mapping;
- generated IDs for incoming calls;
- authenticated OkHttp WebSocket client;
- editable WebSocket URL/device ID/device token;
- reconnect backoff;
- bounded event queue;
- emergency-number automation refusal;
- JVM-only protocol module with tests.

The Android app intentionally contains no raw cellular call-audio capture path.

## Simulator implementation

Location: `simulator/`

Files:

- `mock-device.mjs` — fake Android device speaking the real protocol;
- `e2e-client.mjs` — synthetic lifecycle integration test.

Verified lifecycle:

```text
queued -> dialing -> active -> held -> active -> ended
```

including DTMF transport.

## Device protocol

Server -> Android:

```json
{
  "type": "command",
  "commandId": "...",
  "callId": "...",
  "action": "dial",
  "payload": {
    "to": "+91XXXXXXXXXX"
  }
}
```

Actions:

```text
dial
answer
reject
hangup
hold
unhold
dtmf
```

Android -> server:

```json
{
  "type": "event",
  "eventId": "...",
  "callId": "...",
  "event": "call.active",
  "timestamp": "2026-09-07T16:20:00Z",
  "payload": {
    "number": "+91XXXXXXXXXX",
    "direction": "outgoing",
    "state": "active"
  }
}
```

## Automated validation

Backend:

```text
7 tests / 7 passed
npm run build -> PASS
```

Coverage includes:

- API auth;
- token secrecy/rotation;
- offline-device rejection;
- device event auth;
- event dedupe;
- WebSocket command/event flow;
- DTMF command flow;
- invalid WebSocket token rejection;
- webhook HMAC;
- clock-drift-safe server timestamps.

Android:

```text
5 protocol tests / 5 passed
:app:assembleDebug -> BUILD SUCCESSFUL
```

APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Emulator / proxy-SIM validation

AVD:

```text
Medium_Phone_API_36.1
Android API 36.1
```

The emulator GSM console was used as a fake carrier/SIM.

Verified:

- APK install and launch;
- default-dialer role;
- `ACTION_DIAL` routing;
- incoming GSM injection;
- `InCallService` binding;
- in-call UI;
- answer;
- reject;
- hangup;
- hold;
- unhold;
- DTMF;
- incoming events to server;
- REST-triggered outgoing Telecom call;
- outgoing hold/unhold/DTMF/hangup.

The emulator Telecom trace showed matching DTMF start/stop operations.

See [EMULATOR_VALIDATION.md](EMULATOR_VALIDATION.md).

## Bugs found and fixed

### Reject state was lost

Android sends a final disconnected transition after local rejection. Initially this produced:

```text
ringing -> rejected -> disconnected -> ended
```

The Android registry now remembers an explicit local reject and preserves terminal state as `rejected`.

Re-test:

```text
final_state=rejected
```

### Device clock drift broke timestamps

The emulator clock was behind the PC, which allowed a device event timestamp to make `updatedAt` appear earlier than `createdAt`.

The server now uses **server receive time** for projected call ordering and `updatedAt`, while preserving the original device timestamp in the event/webhook payload.

A regression test was added.

### Debug configuration for emulator automation

A debug-only configuration hook was added so automated tests can point the APK at a local WebSocket server without hardcoding production credentials.

## Physical Vivo V40 validation

After emulator validation, a physical **Vivo V40** with a real SIM was tested.

Historical network values from the validation session:

```text
PC Wi-Fi IPv4: 10.29.38.219
Gateway bind:   0.0.0.0:8787
Device ID:      vivo-v40
WebSocket:      ws://10.29.38.219:8787/v1/device-channel
```

The LAN IP is transient and must be re-checked on future networks.

Live API keys, device tokens, and the real destination number are intentionally not recorded in this repository.

### Sideload/default-dialer restriction encountered

The Vivo initially showed Android restricted-settings protection because the APK was sideloaded. Manually selecting it in Default Apps also initially hit the same protection. This was an OEM/platform restriction, not an app crash.

Once HTTP Gateway Dialer was configured as the active dialer and the WebSocket credentials were entered, the real-device tests succeeded.

### WebSocket connection

The Windows host showed an established TCP connection from the phone to port `8787`.

Result: **PASS**.

### REST-triggered real outgoing SIM call

`POST /v1/calls` caused:

```text
REST API
  -> gateway WebSocket
  -> Vivo V40
  -> Android Telecom
  -> physical SIM/carrier
  -> destination phone rang
```

The remote party answered.

Result: **PASS**.

### Remote hangup on outgoing real call

`POST /v1/calls/:callId/hangup` ended the physical call.

Result: **PASS**.

### Incoming real call discovery

Another phone called the Vivo. The Android client generated an incoming gateway ID of the form `call_<uuid>`, and the server exposed it through `GET /v1/calls`.

Result: **PASS**.

### Hold/unhold on real call

The active incoming call was controlled with:

```text
POST /v1/calls/:callId/hold
POST /v1/calls/:callId/unhold
```

The user confirmed both actions worked on the live carrier call.

Result: **PASS**.

### DTMF on real call

`POST /v1/calls/:callId/dtmf` returned `accepted: true` and reached the Android command path.

No controlled IVR endpoint was available, so remote carrier/IVR receipt of the digits was not independently observed on the physical Vivo.

Result: **PARTIAL PASS** — Android command delivery proven; remote IVR receipt not yet proven.

### Remote hangup on incoming real call

The incoming active call was ended through the REST hangup action.

Result: **PASS**.

### Not yet explicitly re-tested on the physical Vivo

- remote answer action;
- remote reject action.

Both are already proven on the emulator/proxy-SIM.

See [REAL_DEVICE_VALIDATION.md](REAL_DEVICE_VALIDATION.md).

## PowerShell templates used

These intentionally use placeholders instead of live secrets or personal phone numbers.

### Create outgoing call and save call ID

```powershell
$c=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls" -Headers @{"X-API-Key"="<API_KEY>";"Content-Type"="application/json"} -Body '{"deviceId":"vivo-v40","to":"<TEST_NUMBER>"}'; $id=$c.call.id; "Call ID: $id"
```

### Find the current call automatically

```powershell
$id=((Invoke-RestMethod -Uri "http://127.0.0.1:8787/v1/calls?deviceId=vivo-v40" -Headers @{"X-API-Key"="<API_KEY>"}).calls | Where-Object {$_.state -in @("ringing","active","held","dialing")} | Sort-Object {[datetime]$_.updatedAt} -Descending | Select-Object -First 1).id; "Call ID: $id"
```

### Hold

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/hold" -Headers @{"X-API-Key"="<API_KEY>"}
```

### Unhold

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/unhold" -Headers @{"X-API-Key"="<API_KEY>"}
```

### DTMF

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/dtmf" -Headers @{"X-API-Key"="<API_KEY>";"Content-Type"="application/json"} -Body '{"digits":"12#"}'
```

### Hangup

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/v1/calls/$id/hangup" -Headers @{"X-API-Key"="<API_KEY>"}
```

## Current call-audio limitation

The current stock-Android APK cannot directly stream both sides of the SIM call to a laptop/server.

Possible future media architectures:

1. privileged/system app on a rooted/custom Android build;
2. dedicated LTE/SIP gateway hardware with explicit media access;
3. move the media path to SIP/VoIP so the server owns the audio;
4. speakerphone + microphone acoustic streaming only as a low-quality research workaround.

For an AI-calling product, SIP/VoIP or dedicated telephony hardware is the cleaner path.

## Security/privacy decisions

- application-facing REST API uses an API key;
- each Android device has a separate random credential;
- device credentials are not exposed by normal reads;
- tokens can be rotated;
- webhooks are HMAC signed;
- production should use HTTPS/WSS;
- phone numbers should be redacted in logs where practical;
- automated emergency-number dialing is blocked;
- hidden/raw call recording is not implemented;
- live test credentials and the real test number are not committed.

## Remaining prototype limitations

- server state is in memory and resets on restart;
- WebSocket is process-bound on Android;
- no foreground-service/FCM production keepalive yet;
- Android battery optimization/OEM process killing not handled yet;
- dual-SIM PhoneAccount selection not implemented;
- broader OEM/carrier coverage needed;
- no public TLS deployment yet;
- no database persistence;
- no durable command retry/idempotency store;
- no admin dashboard;
- physical remote answer not yet independently re-tested;
- physical remote reject not yet independently re-tested;
- physical DTMF receipt by a remote IVR not yet verified;
- no raw SIM-call audio streaming on stock Android.

## Recommended next milestones

### Reliability

- database persistence;
- durable command state/retry/idempotency;
- Android foreground service;
- FCM wake/reconnect;
- heartbeat/connection diagnostics;
- battery-optimization handling.

### Telephony coverage

- physical remote answer test;
- physical remote reject test;
- DTMF test against IVR;
- dual-SIM testing;
- second OEM/device;
- long-call testing;
- Wi-Fi/mobile-data transitions;
- app/process restart during calls.

### Deployment

- TLS + `wss://`;
- database;
- Android Keystore for long-lived credentials;
- phone-number-safe structured logging;
- webhook retry queue;
- rate limiting;
- audit logging.

## Current conclusion

The central hypothesis is proven on both emulator and real hardware:

> A normal Android phone, when selected as the default dialer, can act as a self-hosted SIM call-control gateway controlled from a REST API through an authenticated device channel.

The Vivo V40 was successfully controlled over the LAN to place and manipulate real carrier calls. Remaining work is primarily production hardening, broader carrier/OEM coverage, and choosing a separate media architecture if server-side call audio is required.
