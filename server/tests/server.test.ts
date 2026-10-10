import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { StateStore } from "../src/state.js";
import type { WebhookPayload } from "../src/types.js";
import { HttpWebhookDispatcher, type WebhookDispatcher } from "../src/webhooks.js";

const API_KEY = "test-api-key";

class RecordingWebhookDispatcher implements WebhookDispatcher {
  readonly deliveries: Array<{ url: string; payload: WebhookPayload }> = [];

  async dispatch(url: string, payload: WebhookPayload): Promise<void> {
    this.deliveries.push({ url, payload });
  }
}

let liveGateway: GatewayServer | undefined;
let liveSocket: WebSocket | undefined;

afterEach(async () => {
  if (liveSocket) {
    const socket = liveSocket;
    socket.on("error", () => undefined);
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  liveSocket = undefined;
  if (liveGateway?.httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      liveGateway?.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  liveGateway = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gateway REST API", () => {
  it("requires the application API key and never exposes device credentials in reads", async () => {
    const gateway = createGatewayServer({ apiKey: API_KEY, webhookDispatcher: new RecordingWebhookDispatcher() });

    await request(gateway.httpServer).get("/v1/devices").expect(401);

    const registration = await request(gateway.httpServer)
      .post("/v1/devices")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1", name: "Pixel test device" })
      .expect(201);

    expect(registration.body.deviceToken).toEqual(expect.any(String));
    expect(registration.body.device.connected).toBe(false);
    const originalToken = registration.body.deviceToken as string;

    const unchanged = await request(gateway.httpServer)
      .post("/v1/devices")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1", name: "Pixel renamed" })
      .expect(200);
    expect(unchanged.body).not.toHaveProperty("deviceToken");

    const rotated = await request(gateway.httpServer)
      .post("/v1/devices")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1", rotateToken: true })
      .expect(200);
    expect(rotated.body.deviceToken).toEqual(expect.any(String));
    expect(rotated.body.deviceToken).not.toBe(originalToken);

    const list = await request(gateway.httpServer)
      .get("/v1/devices")
      .set("authorization", `Bearer ${API_KEY}`)
      .expect(200);

    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).not.toHaveProperty("deviceToken");
  });

  it("validates call requests and refuses to queue calls for offline devices", async () => {
    const gateway = createGatewayServer({ apiKey: API_KEY, webhookDispatcher: new RecordingWebhookDispatcher() });
    await request(gateway.httpServer)
      .post("/v1/devices")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1" })
      .expect(201);

    await request(gateway.httpServer)
      .post("/v1/calls")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1" })
      .expect(400);

    const offline = await request(gateway.httpServer)
      .post("/v1/calls")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1", to: "+919876543210" })
      .expect(409);

    expect(offline.body.error.code).toBe("DEVICE_OFFLINE");
  });

  it("accepts device REST events only with the per-device token", async () => {
    const dispatcher = new RecordingWebhookDispatcher();
    const gateway = createGatewayServer({
      apiKey: API_KEY,
      defaultWebhookUrl: "https://hooks.example.test/calls",
      webhookDispatcher: dispatcher,
    });
    const registration = await request(gateway.httpServer)
      .post("/v1/devices")
      .set("x-api-key", API_KEY)
      .send({ deviceId: "phone-1" })
      .expect(201);
    const token = registration.body.deviceToken as string;

    const event = {
      type: "event",
      eventId: "evt-incoming-1",
      callId: "call-incoming-1",
      event: "call.ringing",
      timestamp: new Date().toISOString(),
      payload: { number: "+911234567890", direction: "incoming" },
    };

    await request(gateway.httpServer)
      .post("/v1/devices/phone-1/events")
      .set("x-api-key", API_KEY)
      .send(event)
      .expect(401);

    await request(gateway.httpServer)
      .post("/v1/devices/phone-1/events")
      .set("x-device-token", token)
      .send(event)
      .expect(202);

    // Event IDs are idempotency keys: duplicate delivery must not duplicate the webhook.
    await request(gateway.httpServer)
      .post("/v1/devices/phone-1/events")
      .set("x-device-token", token)
      .send(event)
      .expect(202);

    const call = await request(gateway.httpServer)
      .get("/v1/calls/call-incoming-1")
      .set("x-api-key", API_KEY)
      .expect(200);
    expect(call.body.call).toMatchObject({ state: "ringing", direction: "incoming" });
    expect(dispatcher.deliveries).toHaveLength(1);
    expect(dispatcher.deliveries[0]?.payload.event).toBe("call.ringing");
  });
});

describe("Android device WebSocket channel", () => {
  it("delivers call commands, ingests state events, and supports DTMF actions end-to-end", async () => {
    const dispatcher = new RecordingWebhookDispatcher();
    liveGateway = createGatewayServer({ apiKey: API_KEY, webhookDispatcher: dispatcher });
    await listen(liveGateway);
    const baseUrl = serverBaseUrl(liveGateway);

    const registration = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ deviceId: "phone-1", name: "Mock Android" }),
    });
    expect(registration.status).toBe(201);
    const registrationBody = (await registration.json()) as { deviceToken: string };

    liveSocket = new WebSocket(
      `${baseUrl.replace("http://", "ws://")}/v1/device-channel?deviceId=phone-1&deviceToken=${encodeURIComponent(registrationBody.deviceToken)}`,
    );
    await onceOpen(liveSocket);

    const dialCommandPromise = onceJsonMessage(liveSocket);
    const created = await fetch(`${baseUrl}/v1/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        deviceId: "phone-1",
        to: "+919876543210",
        webhookUrl: "https://hooks.example.test/call",
      }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { call: { id: string } };
    const dialCommand = await dialCommandPromise;
    expect(dialCommand).toMatchObject({
      type: "command",
      callId: createdBody.call.id,
      action: "dial",
      payload: { to: "+919876543210" },
    });
    expect(dialCommand.commandId).toEqual(expect.any(String));

    const eventAckPromise = onceJsonMessage(liveSocket);
    liveSocket.send(
      JSON.stringify({
        type: "event",
        eventId: "evt-active-1",
        callId: createdBody.call.id,
        event: "call.active",
        timestamp: new Date().toISOString(),
        payload: { number: "+919876543210", direction: "outgoing", nativeCallId: "android-call-7" },
      }),
    );
    expect(await eventAckPromise).toEqual({ type: "event.ack", eventId: "evt-active-1" });

    const statusResponse = await fetch(`${baseUrl}/v1/calls/${createdBody.call.id}`, {
      headers: { "x-api-key": API_KEY },
    });
    const status = (await statusResponse.json()) as { call: { state: string; nativeCallId: string } };
    expect(status.call).toMatchObject({ state: "active", nativeCallId: "android-call-7" });
    expect(dispatcher.deliveries).toHaveLength(1);

    const dtmfCommandPromise = onceJsonMessage(liveSocket);
    const dtmf = await fetch(`${baseUrl}/v1/calls/${createdBody.call.id}/dtmf`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ digits: "12#" }),
    });
    expect(dtmf.status).toBe(202);
    expect(await dtmfCommandPromise).toMatchObject({
      type: "command",
      callId: createdBody.call.id,
      action: "dtmf",
      payload: { digits: "12#" },
    });
  });

  it("rejects WebSocket connections with the wrong device token", async () => {
    liveGateway = createGatewayServer({ apiKey: API_KEY, webhookDispatcher: new RecordingWebhookDispatcher() });
    await listen(liveGateway);
    const baseUrl = serverBaseUrl(liveGateway);
    await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ deviceId: "phone-1" }),
    });

    liveSocket = new WebSocket(
      `${baseUrl.replace("http://", "ws://")}/v1/device-channel?deviceId=phone-1&deviceToken=wrong`,
    );
    liveSocket.on("error", () => undefined);
    const statusCode = await new Promise<number>((resolve) => {
      liveSocket?.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        response.once("end", () => resolve(status));
      });
    });
    expect(statusCode).toBe(401);
    liveSocket.terminate();
    liveSocket = undefined;
  });
});

describe("signed webhook dispatcher", () => {
  it("signs timestamp + body with HMAC-SHA256", async () => {
    const mockedFetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", mockedFetch);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const payload = {
      event: "call.active",
      eventId: "evt-1",
      occurredAt: "2026-09-07T16:20:00.000Z",
      device: {
        id: "phone-1",
        connected: true,
        registeredAt: "2026-09-07T16:00:00.000Z",
        lastSeenAt: "2026-09-07T16:20:00.000Z",
      },
      call: {
        id: "call-1",
        deviceId: "phone-1",
        remoteNumber: "+919876543210",
        direction: "outgoing",
        state: "active",
        createdAt: "2026-09-07T16:19:00.000Z",
        updatedAt: "2026-09-07T16:20:00.000Z",
      },
      payload: {},
    } satisfies WebhookPayload;

    await new HttpWebhookDispatcher("webhook-secret").dispatch("https://example.test/hook", payload);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, init] = (mockedFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const timestamp = "1700000000";
    const body = JSON.stringify(payload);
    const expected = createHmac("sha256", "webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(init.headers).toMatchObject({
      "x-openline-timestamp": timestamp,
      "x-openline-signature": `sha256=${expected}`,
    });
    expect(init.body).toBe(body);
  });
});

describe("state projection timestamps", () => {
  it("uses gateway receive time so a drifting phone clock cannot move updatedAt backwards", () => {
    const state = new StateStore(openDatabase());
    state.upsertDevice({ id: "phone-1" });
    const call = state.createOutgoingCall({ deviceId: "phone-1", to: "+919876543210" });

    const updated = state.applyDeviceEvent("phone-1", {
      type: "event",
      eventId: "evt-clock-drift",
      callId: call.id,
      event: "call.active",
      timestamp: "2000-01-01T00:00:00.000Z",
      payload: { number: "+919876543210", direction: "outgoing" },
    });

    expect(updated).toBeDefined();
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(call.createdAt));
  });
});

describe("media relay", () => {
  it("relays call audio both ways between the phone and an authenticated client", async () => {
    liveGateway = createGatewayServer({ apiKey: API_KEY, webhookDispatcher: new RecordingWebhookDispatcher() });
    await listen(liveGateway);
    const baseUrl = serverBaseUrl(liveGateway);
    const wsBase = baseUrl.replace("http://", "ws://");

    const registration = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ deviceId: "phone-1" }),
    });
    const { deviceToken } = (await registration.json()) as { deviceToken: string };
    const call = liveGateway.state.createOutgoingCall({ deviceId: "phone-1", to: "+919876543210" });
    const deviceUrl = (token: string) =>
      `${wsBase}/v1/device-media?deviceId=phone-1&deviceToken=${encodeURIComponent(token)}&callId=${call.id}`;

    await expect(onceOpen(new WebSocket(deviceUrl("wrong-token")))).rejects.toThrow(/401/);
    await expect(onceOpen(new WebSocket(`${wsBase}/v1/calls/${call.id}/media`))).rejects.toThrow(/401/);
    await expect(
      onceOpen(new WebSocket(`${wsBase}/v1/calls/missing/media`, { headers: { "x-api-key": API_KEY } })),
    ).rejects.toThrow(/404/);

    const client = new WebSocket(`${wsBase}/v1/calls/${call.id}/media`, {
      headers: { "x-api-key": API_KEY },
    });
    await onceOpen(client);
    const monitor = new WebSocket(`${wsBase}/v1/calls/${call.id}/media?mode=listen&apiKey=${API_KEY}`);
    await onceOpen(monitor);

    const startPromise = onceJsonMessage(client);
    const monitorStart = onceJsonMessage(monitor);
    const device = new WebSocket(deviceUrl(deviceToken));
    liveSocket = device;
    await onceOpen(device);
    expect(await startPromise).toMatchObject({
      type: "start",
      callId: call.id,
      format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    });
    expect(await monitorStart).toMatchObject({ type: "start", callId: call.id });

    const callerAudio = Buffer.from([1, 2, 3, 4]);
    const toClient = onceRawMessage(client);
    const callerToMonitor = onceRawMessage(monitor);
    device.send(callerAudio);
    expect(await toClient).toEqual({ data: callerAudio, isBinary: true });
    expect((await callerToMonitor).data).toEqual(Buffer.from([0x01, 1, 2, 3, 4]));

    const agentAudio = Buffer.from([9, 8, 7, 6]);
    const toDevice = onceRawMessage(device);
    const agentToMonitor = onceRawMessage(monitor);
    client.send(agentAudio);
    expect(await toDevice).toEqual({ data: agentAudio, isBinary: true });
    expect((await agentToMonitor).data).toEqual(Buffer.from([0x02, 9, 8, 7, 6]));

    const clearPromise = onceJsonMessage(device);
    const monitorClear = onceJsonMessage(monitor);
    client.send(JSON.stringify({ type: "clear" }));
    expect(await clearPromise).toEqual({ type: "clear" });
    expect(await monitorClear).toEqual({ type: "clear" });

    const details = await fetch(`${baseUrl}/v1/calls/${call.id}`, { headers: { "x-api-key": API_KEY } });
    expect(((await details.json()) as { media: unknown }).media).toMatchObject({
      path: `/v1/calls/${call.id}/media`,
      streaming: true,
    });

    const stopPromise = onceJsonMessage(client);
    device.close();
    expect(await stopPromise).toMatchObject({ type: "stop", callId: call.id });
    client.close();
    monitor.close();
  });
});

async function listen(gateway: GatewayServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    gateway.httpServer.once("error", reject);
    gateway.httpServer.listen(0, "127.0.0.1", resolve);
  });
}

function serverBaseUrl(gateway: GatewayServer): string {
  const address = gateway.httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function onceJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function onceRawMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data: data as Buffer, isBinary }));
    socket.once("error", reject);
  });
}
