# Android Emulator / Proxy-SIM Validation

Validated on Android API 36.1 using the AVD `Medium_Phone_API_36.1` and the Android emulator GSM console as a fake carrier/SIM.

## What was verified

- APK installs and launches.
- `com.httpgateway.dialer` can hold `android.app.role.DIALER`.
- `ACTION_DIAL tel:` resolves to the gateway dialer and pre-fills the number.
- Emulator GSM incoming calls bind `GatewayInCallService` and open `InCallActivity`.
- Incoming call events reach the gateway server over the authenticated WebSocket.
- REST `answer` changes Telecom and server state from ringing to active.
- REST `hold` and `unhold` change Telecom and server state correctly.
- REST `dtmf` reaches Android; emulator Telecom traces showed matching START_DTMF/STOP_DTMF pairs.
- REST `hangup` disconnects the Telecom call and server state becomes ended.
- REST `reject` rejects the Telecom call and server state becomes rejected.
- Missed/remote-cancelled incoming calls become ended.
- REST outgoing call creation reaches `TelecomManager.placeCall`; the emulator created an active cellular Telecom call.
- Outgoing hold, unhold, DTMF, and hangup passed through REST -> WebSocket -> Android Telecom.

## Bugs found and fixed during emulator iteration

1. Rejected calls were being projected as generic `ended` because Android emits a final disconnected transition. The Android registry now remembers an explicit local reject and emits `call.rejected` for the terminal transition.
2. A drifting emulator clock caused an outgoing call's `updatedAt` to be earlier than its server-side `createdAt`. State projection now uses gateway receive time for ordering while preserving the device timestamp in the event/webhook envelope.
3. Added a debug-build-only intent configuration hook so automated emulator tests can point the APK at a local WebSocket gateway without embedding credentials in production builds.

## Useful commands

```powershell
adb shell cmd role add-role-holder android.app.role.DIALER com.httpgateway.dialer 0
adb shell pm grant com.httpgateway.dialer android.permission.CALL_PHONE
adb emu gsm call 5550001
adb emu gsm cancel 5550001
adb emu gsm list
```

The emulator is useful for call-control behavior, but it does not validate a real carrier, real SIM provisioning, OEM Telecom differences, VoLTE/IMS behavior, dual-SIM selection, or raw cellular audio access.

That physical-device step was subsequently performed on a Vivo V40. See [REAL_DEVICE_VALIDATION.md](REAL_DEVICE_VALIDATION.md).
