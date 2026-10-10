# OpenLine server

Node.js + TypeScript server for OpenLine: the REST API, the phone and media WebSockets, agent
streams, webhooks, the web console and the SQLite database.

```bash
cp .env.example .env     # set HTTP_GATEWAY_API_KEY
npm install
npm run build
npm start                # http://localhost:8787/
npm test                 # vitest
```

Requires Node.js 22.13+ (built-in `node:sqlite`). Data lives in `data/gateway.db`.

| Path | What |
|---|---|
| `src/app.ts` | REST routes |
| `src/device-channel.ts` | Phone control WebSocket (`/v1/device-channel`) |
| `src/media-relay.ts` | Call audio WebSockets (`/v1/device-media`, `/v1/calls/:id/media`) |
| `src/stream/` | Agent streams: the server dials out to your agent (raw or Twilio format) |
| `src/agent/` | Built-in Gemini Live assistant |
| `src/auth.ts`, `src/config.ts`, `src/db.ts`, `src/state.ts` | Accounts and API keys, settings, SQLite, calls and phones |
| `public/console.html` | The web console |

Full documentation: https://manohar-k-reddy.github.io/openline/
