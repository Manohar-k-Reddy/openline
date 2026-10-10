# OpenLine Android app

Kotlin app that turns the phone into an OpenLine line. It becomes the default phone app, connects
to the OpenLine server, carries out call commands, reports call events and phone health, and
streams call audio.

## Build

```bash
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :protocol:test            # protocol unit tests
```

Needs JDK 17+ and the Android SDK. The app installs on Android 10+; call audio needs Android 11+ (Wireless debugging).

## How call audio works

Ordinary apps can't capture or play call audio. The app pairs once with the phone's own Wireless
debugging (via [libadb-android](https://github.com/MuntashirAkon/libadb-android)) and starts a
small helper process with Android's `shell` permissions (`CAPTURE_AUDIO_OUTPUT`,
`MODIFY_PHONE_STATE`). The helper captures the downlink, plays the agent's audio into the call,
and streams both to the server. Calls are put in "audio processing" mode, so the handset stays
silent. No root, Shizuku or PC needed.

| Package | What |
|---|---|
| `telecom/` | `InCallService`, call registry and command handling |
| `transport/` | Server connection, foreground service, health reports |
| `shell/` | Wireless-debugging pairing, helper launcher and helper process |
| `audio/` | Call audio capture/playback and the bridge to the helper |
| `config/` | QR pairing and stored credentials |
| `protocol/` (module) | Wire format shared with the server |

User documentation: https://manohar-k-reddy.github.io/openline/guides/phone/
