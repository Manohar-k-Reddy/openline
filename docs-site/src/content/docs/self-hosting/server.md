---
title: Run the server
description: Install, configure and run the OpenLine server, and where its data lives.
---

The server is a Node.js app in `server/`. It needs **Node.js 22.13+** (it uses the built-in
`node:sqlite`) and nothing else: no database server, no Redis.

## Install and start

```bash
cd server
cp .env.example .env      # then set HTTP_GATEWAY_API_KEY
npm install
npm run build
npm start                 # http://localhost:8787
```

On Windows, `run-server.bat` in the repo root creates `.env` on first run, installs, builds,
opens Tailscale Funnel on port 8787 and starts the server. `run-server.bat nofunnel` skips the
Funnel.

## Configuration

`server/.env` holds the few things needed to boot. Everything else is set in the console
(**Settings**) and stored in the database; `.env` values are only defaults.

| Variable | Needed | What it does |
|---|---|---|
| `HTTP_GATEWAY_API_KEY` | yes | Root API key. Also the setup key when the first console account is created through a public address. |
| `PORT`, `HOST` | no | Listen address. Default `8787` on `0.0.0.0`. |
| `DATA_DIR` | no | Folder for `gateway.db`. Default `data`. |
| `PUBLIC_URL` | no | Public `https://` address. Settings → Server. |
| `WEBHOOK_URL` | no | Default webhook. Settings → Server. |
| `WEBHOOK_SECRET` | no | Webhook signing secret. Defaults to the root API key. |
| `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL` | no | Built-in assistant. Settings → AI assistant. |
| `AGENT_OWNER_NAME` | no | Default name the assistant answers for. |
| `DOCS_URL` | no | Where the console's Docs link points. |

## The console

`http://localhost:8787/` serves the console:

- **Home:** getting started and API quickstart.
- **Playground:** test calls by hand, talk or listen from the laptop, try the assistant.
- **Connection:** pairing QR code and live phone health.
- **Settings:** keys, addresses, incoming-call routing, accounts.

The first visit creates the owner account (email and password). On the server's own machine
that's all; through the public address it also asks for the setup key, so nobody else can claim
a fresh install. More people can be added under **Settings → People with access**.

## Data

Everything is in one SQLite file, `server/data/gateway.db`: phones, calls, call events,
transcripts, assistant messages, webhook deliveries, settings, API keys (hashed), accounts
(hashed passwords) and sessions. Back it up by copying the file while the server is stopped.

## Keep it running

The server is a single process. Run it under whatever keeps processes alive on your machine:
a terminal you leave open, `pm2`, a systemd unit, or Windows Task Scheduler at log-on. Phones
reconnect on their own when it comes back.
