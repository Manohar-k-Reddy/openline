import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentManager } from "./agent/agent-manager.js";
import { createApp } from "./app.js";
import { AuthService } from "./auth.js";
import { ConfigStore } from "./config.js";
import { openDatabase, SettingsStore, type Database } from "./db.js";
import { DeviceWebSocketHub } from "./device-channel.js";
import { DeviceEventService } from "./events.js";
import { MediaRelay } from "./media-relay.js";
import { StateStore } from "./state.js";
import { StreamManager } from "./stream/stream-manager.js";
import { HttpWebhookDispatcher, type WebhookDispatcher } from "./webhooks.js";

export interface GatewayServerOptions {
  /** Root API key from server/.env; also the one-time setup key for the console password. */
  apiKey: string;
  webhookSecret?: string;
  webhookDispatcher?: WebhookDispatcher;
  /** Defaults from server/.env; the console's Settings page overrides them. */
  defaultWebhookUrl?: string;
  geminiApiKey?: string;
  agentModel?: string;
  agentOwnerName?: string;
  publicUrl?: string;
  docsUrl?: string;
  /** Directory of the SQLite database. Without it everything is kept in memory (tests). */
  dataDir?: string;
}

export interface GatewayServer {
  httpServer: HttpServer;
  db: Database;
  state: StateStore;
  config: ConfigStore;
  auth: AuthService;
  deviceHub: DeviceWebSocketHub;
  events: DeviceEventService;
  media: MediaRelay;
  agents: AgentManager;
  streams: StreamManager;
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  const db = openDatabase(options.dataDir);
  const settings = new SettingsStore(db);
  const config = new ConfigStore(settings, {
    geminiApiKey: options.geminiApiKey,
    geminiModel: options.agentModel,
    publicUrl: options.publicUrl,
    webhookUrl: options.defaultWebhookUrl,
    docsUrl: options.docsUrl,
  });
  const auth = new AuthService(db, options.apiKey);
  const state = new StateStore(db);
  const dispatcher =
    options.webhookDispatcher ?? new HttpWebhookDispatcher(options.webhookSecret ?? options.apiKey);
  const events = new DeviceEventService(state, dispatcher, () => config.get("webhookUrl"), db);
  const deviceHub = new DeviceWebSocketHub(state, (deviceId, event) => events.ingest(deviceId, event));
  const media = new MediaRelay(state, auth);
  let httpServer: HttpServer | undefined;
  const mediaUrl = (callId: string) => {
    const { port } = httpServer!.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/v1/calls/${encodeURIComponent(callId)}/media`;
  };
  const streams = new StreamManager({ state, deviceChannel: deviceHub, config, apiKey: options.apiKey, mediaUrl });
  const agents = new AgentManager({
    state,
    deviceChannel: deviceHub,
    apiKey: options.apiKey,
    db,
    settings,
    config,
    ownerName: options.agentOwnerName,
    mediaUrl,
  });
  events.onCallEvent = (call, event) => {
    const streamed = streams.onCallEvent(call, event);
    agents.onCallEvent(state.getCall(call.id) ?? call, event, streamed);
  };
  const app = createApp({ auth, config, state, deviceChannel: deviceHub, events, media, agents, streams });
  httpServer = createServer(app);
  deviceHub.attach(httpServer);
  media.attach(httpServer);
  return { httpServer, db, state, config, auth, deviceHub, events, media, agents, streams };
}
