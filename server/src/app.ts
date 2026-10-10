import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import type { AuthService } from "./auth.js";
import type { ConfigStore } from "./config.js";
import type { DeviceCommandChannel } from "./device-channel.js";
import { DeviceOfflineError } from "./device-channel.js";
import type { DeviceEventService } from "./events.js";
import {
  agentSettingsSchema,
  changePasswordSchema,
  configSchema,
  createApiKeySchema,
  createUserSchema,
  listCallsQuerySchema,
  loginSchema,
  setupSchema,
  streamSchema,
  pairingRequestSchema,
  pairSchema,
  callActionSchema,
  createCallSchema,
  deviceEventSchema,
  dtmfBodySchema,
  registerDeviceSchema,
} from "./schemas.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { StreamManager } from "./stream/stream-manager.js";
import { MEDIA_FORMAT } from "./media-relay.js";
import { PairingService, pairUri } from "./pairing.js";
import type { StateStore } from "./state.js";

export interface AppDependencies {
  auth: AuthService;
  config: ConfigStore;
  state: StateStore;
  deviceChannel: DeviceCommandChannel;
  events: DeviceEventService;
  media?: { isStreaming(callId: string): boolean };
  agents?: AgentManager;
  streams?: StreamManager;
  pairing?: PairingService;
}

export function createApp(deps: AppDependencies) {
  const mediaInfo = (callId: string) => ({
    path: `/v1/calls/${encodeURIComponent(callId)}/media`,
    format: MEDIA_FORMAT,
    streaming: deps.media?.isStreaming(callId) ?? false,
  });

  const pairing = deps.pairing ?? new PairingService();
  const app = express();
  app.disable("x-powered-by");
  // Behind Tailscale Funnel / Cloudflare Tunnel: honour X-Forwarded-Proto/Host for URLs we hand out.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  // Web console (home, playground, connection, settings). The page is public; it signs in with the
  // console password and then uses a session cookie for the API.
  const consolePage = fileURLToPath(new URL("../public/console.html", import.meta.url));
  app.get(["/", "/console"], (_request, response) => response.sendFile(consolePage));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "openline-server" });
  });

  // REST fallback for device events. Device credentials are separate from the public API key.
  app.post("/v1/devices/:deviceId/events", async (request, response) => {
    const deviceId = request.params.deviceId;
    if (!deps.state.verifyDeviceToken(deviceId, request.header("x-device-token"))) {
      return response.status(401).json(errorBody("UNAUTHORIZED", "invalid device token"));
    }

    const parsed = deviceEventSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);

    try {
      await deps.events.ingest(deviceId, parsed.data);
      return response.status(202).json({ accepted: true, eventId: parsed.data.eventId });
    } catch (error) {
      return response.status(409).json(
        errorBody("EVENT_REJECTED", error instanceof Error ? error.message : "event rejected"),
      );
    }
  });

  // Phone side of QR pairing: exchanges a one-time code for device credentials (no API key).
  app.post("/v1/pair", (request, response) => {
    const parsed = pairSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const result = pairing.consume(parsed.data.code);
    if (result === "throttled") {
      return response.status(429).json(errorBody("TOO_MANY_ATTEMPTS", "too many invalid codes, wait a minute"));
    }
    if (result === "invalid") {
      return response.status(401).json(errorBody("INVALID_CODE", "pairing code is invalid or expired"));
    }
    const deviceId = `phone-${randomBytes(4).toString("hex")}`;
    const device = deps.state.upsertDevice({ id: deviceId, name: parsed.data.name ?? "Android phone" });
    const deviceToken = randomBytes(32).toString("base64url");
    deps.state.setDeviceToken(deviceId, deviceToken);
    return response.status(201).json({ device, deviceToken, deviceChannelPath: "/v1/device-channel" });
  });

  // ---- console sign-in ----
  app.get("/v1/auth/status", (request, response) => {
    const setupRequired = deps.auth.setupRequired;
    const user = deps.auth.sessionUser(deps.auth.sessionToken(request));
    response.json({
      setupRequired,
      // Creating the first account through a tunnel also needs the setup key from server/.env.
      setupKeyRequired: setupRequired && !deps.auth.isLocalRequest(request),
      authenticated: Boolean(user) || deps.auth.isAuthorized(request),
      user: user ?? null,
    });
  });

  app.post("/v1/auth/setup", (request, response) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const result = deps.auth.setup(parsed.data, deps.auth.isLocalRequest(request));
    if (result === "already_set") return response.status(409).json(errorBody("ALREADY_SET", "an account already exists, sign in"));
    if (result === "invalid_key") {
      return response.status(401).json(errorBody("INVALID_SETUP_KEY", "setup key does not match HTTP_GATEWAY_API_KEY"));
    }
    return signIn(request, response, parsed.data.email, parsed.data.password);
  });

  app.post("/v1/auth/login", (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    return signIn(request, response, parsed.data.email, parsed.data.password);
  });

  app.post("/v1/auth/logout", (request, response) => {
    deps.auth.logout(deps.auth.sessionToken(request));
    deps.auth.clearSessionCookie(response);
    response.status(204).end();
  });

  function signIn(request: Request, response: Response, email: string, password: string) {
    const result = deps.auth.login(email, password);
    if (result === "throttled") return response.status(429).json(errorBody("TOO_MANY_ATTEMPTS", "too many attempts, wait a minute"));
    if (result === "invalid") return response.status(401).json(errorBody("INVALID_LOGIN", "wrong email or password"));
    deps.auth.setSessionCookie(request, response, result.token, result.expiresAt);
    return response.json({ authenticated: true });
  }

  app.use("/v1", deps.auth.middleware());

  app.post("/v1/auth/password", (request, response) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const token = deps.auth.sessionToken(request);
    const user = deps.auth.sessionUser(token);
    if (!user) return response.status(403).json(errorBody("SESSION_REQUIRED", "sign in to the console to change a password"));
    if (!deps.auth.changePassword(user.id, parsed.data.current, parsed.data.password, token)) {
      return response.status(401).json(errorBody("INVALID_PASSWORD", "current password is wrong"));
    }
    return response.status(204).end();
  });

  // ---- console accounts ----
  app.get("/v1/users", (_request, response) => {
    response.json({ users: deps.auth.listUsers() });
  });

  app.post("/v1/users", (request, response) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const user = deps.auth.addUser(parsed.data.email, parsed.data.password);
    if (user === "exists") return response.status(409).json(errorBody("EXISTS", "an account with this email exists"));
    return response.status(201).json({ user });
  });

  app.delete("/v1/users/:id", (request, response) => {
    const result = deps.auth.removeUser(request.params.id);
    if (result === "last") return response.status(409).json(errorBody("LAST_USER", "can't remove the only account"));
    if (result === "not_found") return response.status(404).json(errorBody("NOT_FOUND", "account not found"));
    return response.status(204).end();
  });

  // ---- settings, API keys, webhook log ----
  app.get("/v1/settings", (_request, response) => {
    response.json({ settings: deps.config.view() });
  });

  app.put("/v1/settings", (request, response) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    deps.config.update(parsed.data);
    return response.json({ settings: deps.config.view() });
  });

  app.get("/v1/api-keys", (_request, response) => {
    response.json({ apiKeys: deps.auth.listApiKeys() });
  });

  app.post("/v1/api-keys", (request, response) => {
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    return response.status(201).json({ apiKey: deps.auth.createApiKey(parsed.data.name) });
  });

  app.delete("/v1/api-keys/:id", (request, response) => {
    if (!deps.auth.revokeApiKey(request.params.id)) {
      return response.status(404).json(errorBody("NOT_FOUND", "API key not found"));
    }
    return response.status(204).end();
  });

  app.get("/v1/webhook-deliveries", (request, response) => {
    const callId = typeof request.query.callId === "string" ? request.query.callId : undefined;
    const limit = Number(request.query.limit) || undefined;
    response.json({ deliveries: deps.events.listDeliveries({ callId, limit }) });
  });

  // Admin side of QR pairing: a fresh one-time code and its QR (SVG).
  app.post("/v1/pairing", async (request, response) => {
    const parsed = pairingRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const publicUrl = (parsed.data.publicUrl ?? deps.config.get("publicUrl") ?? `${request.protocol}://${request.host}`)
      .replace(/\/+$/, "");
    const { code, expiresAt } = pairing.create();
    const uri = pairUri(publicUrl, code);
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return response.status(201).json({ code, expiresAt, publicUrl, pairUri: uri, qrSvg });
  });

  app.get("/v1/server", (request, response) => {
    response.json({
      publicUrl: deps.config.get("publicUrl") ?? null,
      docsUrl: deps.config.get("docsUrl") ?? null,
      requestOrigin: `${request.protocol}://${request.host}`,
    });
  });

  app.delete("/v1/devices/:deviceId", (request, response) => {
    deps.deviceChannel.disconnect?.(request.params.deviceId);
    if (!deps.state.removeDevice(request.params.deviceId)) {
      return response.status(404).json(errorBody("NOT_FOUND", "device not found"));
    }
    return response.status(204).end();
  });

  app.post("/v1/devices", (request, response) => {
    const parsed = registerDeviceSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);

    const { deviceId, name, metadata, rotateToken } = parsed.data;
    const existed = Boolean(deps.state.getDevice(deviceId));
    const device = deps.state.upsertDevice({ id: deviceId, name, metadata });
    const existingToken = deps.state.hasDeviceToken(deviceId);
    let deviceToken: string | undefined;

    if (!existingToken || rotateToken) {
      deviceToken = randomBytes(32).toString("base64url");
      deps.state.setDeviceToken(deviceId, deviceToken);
      if (existingToken && rotateToken) deps.deviceChannel.disconnect?.(deviceId);
    }

    return response.status(existed ? 200 : 201).json({
      device,
      ...(deviceToken ? { deviceToken } : {}),
      deviceChannel: {
        path: "/v1/device-channel",
        auth: ["deviceId", "deviceToken"],
      },
    });
  });

  app.get("/v1/devices", (_request, response) => {
    response.json({ devices: deps.state.listDevices() });
  });

  app.get("/v1/devices/:deviceId", (request, response) => {
    const device = deps.state.getDevice(request.params.deviceId);
    if (!device) return response.status(404).json(errorBody("NOT_FOUND", "device not found"));
    return response.json({ device });
  });

  app.post("/v1/calls", (request, response) => {
    const parsed = createCallSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);

    const device = deps.state.getDevice(parsed.data.deviceId);
    if (!device) return response.status(404).json(errorBody("NOT_FOUND", "device not found"));
    if (!deps.deviceChannel.isConnected(device.id)) {
      return response.status(409).json(errorBody("DEVICE_OFFLINE", "device is offline"));
    }

    const call = deps.state.createOutgoingCall({
      deviceId: device.id,
      to: parsed.data.to,
      webhookUrl: parsed.data.webhookUrl,
      metadata: parsed.data.metadata,
      stream: parsed.data.stream,
    });

    try {
      const command = deps.deviceChannel.send(device.id, {
        action: "dial",
        callId: call.id,
        payload: { to: call.remoteNumber },
      });
      return response.status(202).json({ call, command, media: mediaInfo(call.id) });
    } catch (error) {
      deps.state.setCallState(call.id, "failed");
      if (error instanceof DeviceOfflineError) {
        return response.status(409).json(errorBody("DEVICE_OFFLINE", "device is offline"));
      }
      throw error;
    }
  });

  // Newest first. Page with ?before=<nextBefore>; filter by deviceId, state, direction.
  app.get("/v1/calls", (request, response) => {
    const parsed = listCallsQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    const calls = deps.state.listCalls(parsed.data);
    const limit = parsed.data.limit ?? 50;
    return response.json({ calls, nextBefore: calls.length === limit ? calls.at(-1)!.createdAt : null });
  });

  app.get("/v1/calls/:callId", (request, response) => {
    const call = deps.state.getCall(request.params.callId);
    if (!call) return response.status(404).json(errorBody("NOT_FOUND", "call not found"));
    return response.json({ call, media: mediaInfo(call.id) });
  });

  app.get("/v1/calls/:callId/events", (request, response) => {
    const call = deps.state.getCall(request.params.callId);
    if (!call) return response.status(404).json(errorBody("NOT_FOUND", "call not found"));
    return response.json({ events: deps.state.listCallEvents(call.id) });
  });

  app.get("/v1/calls/:callId/transcript", (request, response) => {
    const call = deps.state.getCall(request.params.callId);
    if (!call) return response.status(404).json(errorBody("NOT_FOUND", "call not found"));
    return response.json({ transcript: deps.agents?.transcript(call.id) ?? [] });
  });

  // ---- Agent streams: the server connects the call to your WebSocket ----
  app.get("/v1/calls/:callId/stream", (request, response) => {
    if (!deps.streams) return response.status(404).json(errorBody("NOT_FOUND", "streams unavailable"));
    if (!deps.state.getCall(request.params.callId)) return response.status(404).json(errorBody("NOT_FOUND", "call not found"));
    return response.json(deps.streams.info(request.params.callId));
  });

  app.post("/v1/calls/:callId/stream", (request, response) => {
    if (!deps.streams) return response.status(404).json(errorBody("NOT_FOUND", "streams unavailable"));
    const parsed = streamSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    try {
      const call = deps.streams.attach(request.params.callId, parsed.data);
      return response.status(202).json({ call, ...deps.streams.info(call.id) });
    } catch (error) {
      return response.status(409).json(errorBody("CALL_NOT_LIVE", (error as Error).message));
    }
  });

  app.delete("/v1/calls/:callId/stream", (request, response) => {
    deps.streams?.detach(request.params.callId);
    response.status(204).end();
  });

  // ---- AI phone assistant (Gemini Live) ----
  app.get("/v1/agent", (_request, response) => {
    const agents = deps.agents;
    response.json({
      configured: agents?.configured ?? false,
      model: agents?.model,
      settings: agents?.settings,
    });
  });

  app.put("/v1/agent", (request, response) => {
    if (!deps.agents) return response.status(404).json(errorBody("NOT_FOUND", "assistant unavailable"));
    const parsed = agentSettingsSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.issues);
    return response.json({ settings: deps.agents.updateSettings(parsed.data) });
  });

  app.get("/v1/agent/messages", (request, response) => {
    const limit = Number(request.query.limit) || undefined;
    response.json({ messages: deps.agents?.listMessages(limit) ?? [] });
  });

  app.get("/v1/calls/:callId/agent", (request, response) => {
    if (!deps.agents) return response.status(404).json(errorBody("NOT_FOUND", "assistant unavailable"));
    return response.json(deps.agents.info(request.params.callId));
  });

  app.post("/v1/calls/:callId/agent", (request, response) => {
    if (!deps.agents) return response.status(404).json(errorBody("NOT_FOUND", "assistant unavailable"));
    try {
      deps.agents.takeOver(request.params.callId);
      return response.status(202).json(deps.agents.info(request.params.callId));
    } catch (error) {
      return response.status(409).json(errorBody("AGENT_UNAVAILABLE", (error as Error).message));
    }
  });

  app.delete("/v1/calls/:callId/agent", (request, response) => {
    deps.agents?.release(request.params.callId);
    response.status(204).end();
  });

  app.post(
    ["/v1/calls/:callId/:action", "/v1/calls/:callId/actions/:action"],
    (request, response) => {
      const actionResult = callActionSchema.safeParse({ action: firstParam(request.params.action) });
      if (!actionResult.success) return validationError(response, actionResult.error.issues);

      const call = deps.state.getCall(firstParam(request.params.callId));
      if (!call) return response.status(404).json(errorBody("NOT_FOUND", "call not found"));
      if (!deps.deviceChannel.isConnected(call.deviceId)) {
        return response.status(409).json(errorBody("DEVICE_OFFLINE", "device is offline"));
      }

      let payload: Record<string, unknown> | undefined;
      if (actionResult.data.action === "dtmf") {
        const bodyResult = dtmfBodySchema.safeParse(request.body);
        if (!bodyResult.success) return validationError(response, bodyResult.error.issues);
        payload = { digits: bodyResult.data.digits };
      }

      try {
        const command = deps.deviceChannel.send(call.deviceId, {
          action: actionResult.data.action,
          callId: call.id,
          payload,
        });
        return response.status(202).json({ accepted: true, command, call });
      } catch (error) {
        if (error instanceof DeviceOfflineError) {
          return response.status(409).json(errorBody("DEVICE_OFFLINE", "device is offline"));
        }
        throw error;
      }
    },
  );

  app.use((_request, response) => {
    response.status(404).json(errorBody("NOT_FOUND", "route not found"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      return response.status(400).json(errorBody("INVALID_JSON", "request body must be valid JSON"));
    }
    console.error("unhandled request error", error);
    return response.status(500).json(errorBody("INTERNAL_ERROR", "internal server error"));
  });

  return app;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function validationError(response: Response, issues: unknown) {
  return response.status(400).json({
    error: { code: "VALIDATION_ERROR", message: "invalid request", issues },
  });
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
