---
title: Security
description: What's protected, how, and what you should do.
---

Your gateway can place calls on your SIM, so treat its credentials like a payment card.

## What's in place

- **API keys** are random 32-byte tokens, stored only as SHA-256 hashes, revocable one by one.
- **Console accounts** use email and password (scrypt hashes). Sessions are `HttpOnly`,
  `SameSite=Strict` cookies, `Secure` over https, valid for 30 days. Repeated wrong passwords are
  throttled.
- **First account:** creating it through the public address requires the setup key
  (`HTTP_GATEWAY_API_KEY`), so a fresh install exposed by a tunnel can't be claimed by someone
  else.
- **Phones** have their own random token each (hashed on the server), issued through a one-time
  pairing code valid for 10 minutes, with throttling against guessing.
- **Webhooks** are signed with HMAC-SHA256 and a timestamp.
- **Secrets in Settings** (such as the Gemini key) never come back from the API in full, only
  their last four characters.

## What you should do

- Use a long random `HTTP_GATEWAY_API_KEY` and keep `server/.env` private. It's git-ignored.
- Create a separate API key per app and revoke keys you no longer use.
- Verify webhook signatures and reject old timestamps.
- Only stream calls to agents you control. Call audio is personal data, and some places require
  telling callers they're talking to an AI or being recorded.
- Keep `server/data/gateway.db` private and backed up. It has call logs and transcripts.

## On the phone

The call-audio helper runs with Android's `shell` permissions, started through Wireless
debugging with a key only this app holds. After the first start, Android's debugging also
listens on TCP port 5555 until the phone restarts. Only devices you've approved can use it, but
avoid running the phone on untrusted Wi-Fi networks.
