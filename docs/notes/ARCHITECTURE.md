# Architecture

## Components

```text
                    REST API
                       |
                       v
              +------------------+
              |  Gateway Server  |
              |------------------|
              | auth             |
              | call state       |
              | command router   |
              | webhook sender   |
              +--------+---------+
                       |
             authenticated WS
                       |
                       v
              +------------------+
              | Android Gateway  |
              |------------------|
              | RoleManager      |
              | TelecomManager   |
              | InCallService    |
              | Call registry    |
              | command client   |
              +--------+---------+
                       |
                 Android Telecom
                       |
                       v
                  SIM / carrier
```

## Design choices

### Server is transport-agnostic

The REST API produces commands and consumes events. It should not know Android
Telecom details. This lets a future Linux/LTE/SIP gateway implement the same
device protocol.

### Android owns telephony state

Android is the source of truth for actual call state. The cloud call record is
an eventually consistent projection of Android Telecom events.

### IDs are gateway IDs, not Android Call objects

`android.telecom.Call` instances are process-local objects. The Android client
maintains a mapping between server `callId` values and live Telecom `Call`
objects.

### Commands are idempotency-friendly

Every server command gets a unique `commandId`. A production Android client can
cache recently applied command IDs so reconnect/retry does not redial.

### Raw call audio is explicitly out of scope

The call-control product remains useful without unsafe or unsupported promises
about cellular call-audio capture. A future audio product should use hardware or
telephony infrastructure where bidirectional media access is explicitly
supported.

