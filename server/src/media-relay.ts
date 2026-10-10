import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AuthService } from "./auth.js";
import type { StateStore } from "./state.js";

/**
 * Live call audio, relayed between the phone and one developer/AI client per call.
 *
 * Both legs carry binary frames of raw PCM (see MEDIA_FORMAT):
 *   phone  -> client : remote party audio (what the caller says)
 *   client -> phone  : audio injected into the call (what the agent says)
 *
 * Text frames are JSON control messages:
 *   server -> client : {type:"start", callId, format} | {type:"stop", callId, reason}
 *   client -> server : {type:"clear"}  (drop queued agent audio, e.g. on barge-in)
 *
 * Listen-only monitors (`?mode=listen`, any number per call) hear both sides without taking the
 * client slot. Their binary frames carry a 1-byte channel prefix: 0x01 remote party, 0x02 the
 * audio injected into the call. They also receive start/stop and {type:"clear"}.
 */
export const MEDIA_FORMAT = {
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
  frameMs: 20,
} as const;

export const DEVICE_MEDIA_PATH = "/v1/device-media";
export const MONITOR_CHANNEL = { remote: 0x01, injected: 0x02 } as const;
const CLIENT_MEDIA_PATH = /^\/v1\/calls\/([^/]+)\/media$/;

interface MediaSession {
  device?: WebSocket;
  client?: WebSocket;
  monitors: Set<WebSocket>;
}

export class MediaRelay {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, MediaSession>();

  constructor(
    private readonly state: StateStore,
    private readonly auth: Pick<AuthService, "isAuthorized">,
  ) {}

  attach(httpServer: HttpServer): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === DEVICE_MEDIA_PATH) {
        this.upgradeDevice(request, socket, head, url);
        return;
      }
      const match = CLIENT_MEDIA_PATH.exec(url.pathname);
      if (match) this.upgradeClient(request, socket, head, url, decodeURIComponent(match[1]!));
    });
  }

  /** True while the phone is streaming audio for this call. */
  isStreaming(callId: string): boolean {
    return this.sessions.get(callId)?.device?.readyState === WebSocket.OPEN;
  }

  private upgradeDevice(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const deviceId = url.searchParams.get("deviceId") ?? headerString(request, "x-device-id");
    const deviceToken =
      url.searchParams.get("deviceToken") ?? headerString(request, "x-device-token");
    const callId = url.searchParams.get("callId");

    if (!deviceId || !this.state.verifyDeviceToken(deviceId, deviceToken)) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (!callId || this.state.getCall(callId)?.deviceId !== deviceId) {
      reject(socket, 404, "Not Found");
      return;
    }

    this.server.handleUpgrade(request, socket, head, (ws) => {
      const session = this.session(callId);
      session.device?.close(4000, "replaced by newer connection");
      session.device = ws;
      if (session.client) sendJson(session.client, startMessage(callId));
      for (const monitor of session.monitors) sendJson(monitor, startMessage(callId));

      ws.on("message", (data, isBinary) => {
        if (!isBinary || session.device !== ws) return;
        forwardBinary(session.client, data);
        forwardToMonitors(session, MONITOR_CHANNEL.remote, data);
      });
      ws.on("close", () => {
        if (session.device !== ws) return;
        session.device = undefined;
        const stop = { type: "stop", callId, reason: "device_media_closed" };
        if (session.client) sendJson(session.client, stop);
        for (const monitor of session.monitors) sendJson(monitor, stop);
        this.dropIfEmpty(callId);
      });
    });
  }

  private upgradeClient(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    callId: string,
  ): void {
    if (!this.auth.isAuthorized(request, url)) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (!this.state.getCall(callId)) {
      reject(socket, 404, "Not Found");
      return;
    }

    this.server.handleUpgrade(request, socket, head, (ws) => {
      const session = this.session(callId);
      if (url.searchParams.get("mode") === "listen") {
        this.addMonitor(session, callId, ws);
        return;
      }
      session.client?.close(4000, "replaced by newer connection");
      session.client = ws;
      if (session.device?.readyState === WebSocket.OPEN) sendJson(ws, startMessage(callId));

      ws.on("message", (data, isBinary) => {
        if (session.client !== ws) return;
        if (isBinary) {
          forwardBinary(session.device, data);
          forwardToMonitors(session, MONITOR_CHANNEL.injected, data);
          return;
        }
        const message = parseJson(data);
        if (message?.type === "clear") {
          if (session.device) sendJson(session.device, { type: "clear" });
          for (const monitor of session.monitors) sendJson(monitor, { type: "clear" });
        }
      });
      ws.on("close", () => {
        if (session.client !== ws) return;
        session.client = undefined;
        this.dropIfEmpty(callId);
      });
    });
  }

  private addMonitor(session: MediaSession, callId: string, ws: WebSocket): void {
    session.monitors.add(ws);
    if (session.device?.readyState === WebSocket.OPEN) sendJson(ws, startMessage(callId));
    ws.on("close", () => {
      session.monitors.delete(ws);
      this.dropIfEmpty(callId);
    });
  }

  private session(callId: string): MediaSession {
    let session = this.sessions.get(callId);
    if (!session) {
      session = { monitors: new Set() };
      this.sessions.set(callId, session);
    }
    return session;
  }

  private dropIfEmpty(callId: string): void {
    const session = this.sessions.get(callId);
    if (session && !session.device && !session.client && !session.monitors.size) this.sessions.delete(callId);
  }
}

function startMessage(callId: string) {
  return { type: "start", callId, format: MEDIA_FORMAT };
}

function forwardBinary(target: WebSocket | undefined, data: RawData): void {
  if (target?.readyState === WebSocket.OPEN) target.send(data, { binary: true });
}

function forwardToMonitors(session: MediaSession, channel: number, data: RawData): void {
  if (!session.monitors.size) return;
  const pcm = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  const frame = Buffer.concat([Buffer.from([channel]), pcm]);
  for (const monitor of session.monitors) {
    if (monitor.readyState === WebSocket.OPEN) monitor.send(frame, { binary: true });
  }
}

function parseJson(data: RawData): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data.toString());
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function headerString(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
