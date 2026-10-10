---
title: Public address
description: Give the server an https address with Tailscale Funnel or Cloudflare Tunnel.
---

The phone connects to the server over the internet, so the server needs a public `https://`
address. Tunnels give you one without opening router ports. After setting one up, save the
address in **Settings → Server → Public address**: the pairing QR code and the docs examples use
it.

## Tailscale Funnel

Free, stable address, no domain needed.

```bash
tailscale funnel --bg 8787          # the first time, it asks you to enable Funnel for your tailnet
tailscale funnel status             # https://<machine>.<tailnet>.ts.net
```

The address stays the same as long as the machine name does. `--bg` keeps it on after you close
the terminal and across restarts.

## Cloudflare Tunnel

Use your own domain, or a throwaway address for testing.

```bash
# quick test: random address that changes every time
cloudflared tunnel --url http://localhost:8787

# permanent, on your domain
cloudflared tunnel login
cloudflared tunnel create gateway
cloudflared tunnel route dns gateway gateway.example.com
cloudflared tunnel run --url http://localhost:8787 gateway
```

## Changing the address

Phones remember the address they were paired with. If it changes, update **Public address** and
pair the phone again (scan a new QR code).

## Agents on other machines

When the gateway [connects to your agent](../../guides/agent-streams/), it's the server that
opens the connection, so your agent needs an address the **server** can reach. On the same
machine, `ws://127.0.0.1:<port>` is enough; elsewhere, give the agent its own tunnel or public
host.
