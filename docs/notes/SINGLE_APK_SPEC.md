# Spec: single-APK call audio (no Shizuku app, no PC)

Status: proposed · 2026-10-05

## Goal

A developer or user installs **one APK** (HTTP Gateway Dialer) and, after a one-time on-phone
setup, the phone works as a silent call-audio router: SIM call audio flows only between the call
and the gateway server. No Shizuku app, no root, no PC, no extra hardware.

## Why this works

Call audio needs the shell UID (`CAPTURE_AUDIO_OUTPUT`, `MODIFY_PHONE_STATE`). Shizuku obtains
it by connecting to the phone's own `adbd` over **Wireless debugging** and launching a process
with `app_process`. The app can do the same itself with an embedded ADB client
([libadb-android](https://github.com/MuntashirAkon/libadb-android), Apache-2.0 option). Validated
already: the shell-UID path captures `VOICE_DOWNLINK` and injects via the `TELEPHONY` output on
Vivo V40 / Android 16.

## Architecture

```
HTTP Gateway app (untrusted_app UID)                Shell server (uid 2000, same APK code)
 ├─ InCallService: call lifecycle                    ├─ AudioRecord(VOICE_DOWNLINK)
 ├─ ShellLauncher: wireless-ADB pair/connect ──adb──▶├─ AudioTrack → TELEPHONY (uplink)
 │    runs `app_process … ShellServerMain`           ├─ router mode: mic mute + earpiece silent
 └─ ShellClient ──TCP 127.0.0.1 + token (control)──▶ └─ media WebSocket ⇄ gateway server
```

- **Audio no longer passes through the app.** The shell server opens the gateway media
  WebSocket itself; the app only sends control messages (`start`, `stop`, `ping`). This replaces
  the Shizuku user service, AIDL interface and pipes.
- **Control channel:** the shell server listens on `127.0.0.1:<port>`; the app passes port and a
  random token on the launch command line (not readable by other apps). JSON lines:
  `{"op":"start","token","callId","mediaUrl","deviceId","deviceToken"}`, `{"op":"stop","callId"}`,
  `{"op":"ping"}` → `{"ok":true,...}`.
- **Process lifetime:** launched with `setsid` so it survives the ADB stream and app restarts;
  exits if its APK is updated (version mismatch on `ping` → app relaunches it).

## One-time setup (in-app wizard)

1. Connect Wi-Fi; enable Developer options → **Wireless debugging**.
2. Tap **Pair device with pairing code** in system settings. The app finds the pairing port via
   mDNS (`_adb-tls-pairing._tcp`) and shows a **notification with a reply field**; the user types
   the 6-digit code there, so the system dialog stays open.
3. The app pairs, connects (`_adb-tls-connect._tcp`), launches the shell server, and grants
   itself `WRITE_SECURE_SETTINGS` (via `pm grant`) for automatic restarts.

## After reboot (automatic)

`BOOT_COMPLETED` / Wi-Fi-connected → app sets `adb_wifi_enabled=1` (needs the granted
`WRITE_SECURE_SETTINGS`), discovers the connect port, connects with the stored key (already
paired, no code), relaunches the shell server. Requires Wi-Fi to be connected (any network).

## Router mode (phone stays silent)

When a call becomes active, the dialer calls `Call.enterBackgroundAudioProcessing()` (the
call-screening mode; `@SystemApi`, invoked via reflection, Telecom only requires the default
dialer). The call stays connected, enters `STATE_AUDIO_PROCESSING`, and Telecom stops playing it
on the phone and stops using the phone's mic; streaming starts in that state. Verified on Vivo
V40: earpiece silent, `VOICE_DOWNLINK` capture still works. (Lowering `STREAM_VOICE_CALL` was
rejected: its minimum on Vivo is 1, still audible.)

## Changes

| Area | Change |
|---|---|
| Gradle | remove `dev.rikka.shizuku:*`; add libadb-android (JitPack), Conscrypt, BouncyCastle `bcpkix` (self-signed ADB cert) |
| New (app) | `shell/AdbKeyStore`, `shell/AdbPairing` (mDNS + RemoteInput notification), `shell/ShellLauncher`, `shell/ShellClient`, `BootReceiver` |
| New (shell side) | `shell/ShellServerMain` (entry point, control server); `audio/CallAudioEngine` (from `CallAudioUserService` + direct media WebSocket) |
| Removed | `CallAudioUserService` (Shizuku), `ICallAudioService.aidl`, `CallAudioBridge` pipes/relay, Shizuku provider |
| UI | "Shell access" setup wizard and status replace the Shizuku section |
| Manifest | `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE` |
| Server / protocol | no change |

## Risks

- Wireless debugging needs Wi-Fi; on Vivo it may switch off on network change → auto re-enable.
- OEM process killers may kill the shell server → app pings it and relaunches.
- Google could restrict shell permissions in a future Android version (same risk as Shizuku).
