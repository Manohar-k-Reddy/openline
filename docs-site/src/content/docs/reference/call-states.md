---
title: Call states and events
description: Every call state and every event the phone reports.
---

## States

| State | Meaning |
|---|---|
| `queued` | Created; the phone is starting the call. |
| `dialing` | Outgoing call is connecting. |
| `ringing` | Incoming call is ringing on the phone. |
| `active` | Connected. Audio flows. |
| `held` | On hold. |
| `ended` | Finished normally (either side hung up). |
| `rejected` | Incoming call declined. |
| `failed` | Couldn't be placed or a command failed (see the event's `reason`). |

`ended`, `rejected` and `failed` are final. A call that has been `active` has `answeredAt`; a
finished call has `endedAt`.

```text
outgoing:  queued → dialing → active ⇄ held → ended
                           ↘ ended / failed        (no answer, busy, error)
incoming:  ringing → active ⇄ held → ended
                   ↘ rejected / ended              (declined, caller gave up)
```

## Events

Sent as webhooks and listed by `GET /v1/calls/{id}/events`.

| Event | State after | When |
|---|---|---|
| `call.new` | `queued` | The phone created the call. |
| `call.connecting`, `call.select_phone_account`, `call.dialing`, `call.pulling` | `dialing` | Outgoing call in progress. |
| `call.ringing`, `call.simulated_ringing` | `ringing` | Incoming call ringing. |
| `call.active` | `active` | Answered. |
| `call.audio_processing` | `active` | Answered and routed to the gateway (phone silent). |
| `call.holding` | `held` | Put on hold. |
| `call.disconnecting`, `call.disconnected` | `ended` | Call ended. `payload.disconnectCause` has Android's cause code. |
| `call.rejected` | `rejected` | Incoming call declined. |
| `call.failed` | `failed` | A command failed; `payload.reason` says why. |

The phone also sends `command.ack` and `command.completed` for commands; these don't change the
call and aren't sent to webhooks.

Each event's `payload` usually carries `number`, `direction` and `state` as the phone sees them.
