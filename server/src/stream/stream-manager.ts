import type { ConfigStore } from "../config.js";
import type { DeviceCommandChannel } from "../device-channel.js";
import type { StateStore } from "../state.js";
import type { CallRecord, DeviceEventName, StreamConfig, StreamFormat } from "../types.js";
import { StreamBridge } from "./stream-bridge.js";

export interface StreamManagerOptions {
  state: StateStore;
  deviceChannel: DeviceCommandChannel;
  config: ConfigStore;
  apiKey: string;
  mediaUrl(callId: string): string;
}

const LIVE_STATES = new Set<CallRecord["state"]>(["queued", "dialing", "ringing", "active", "held"]);

/** Streams calls to external agents: per call (API) or every incoming call (Settings). */
export class StreamManager {
  private readonly bridges = new Map<string, StreamBridge>();

  constructor(private readonly options: StreamManagerOptions) {}

  /** The account-wide target for incoming calls, if set. */
  incomingTarget(): StreamConfig | undefined {
    const url = this.options.config.get("incomingStreamUrl");
    if (!url) return undefined;
    const format = (this.options.config.get("incomingStreamFormat") ?? "raw") as StreamFormat;
    return { url, format };
  }

  /** Attach an agent to a live call (answers it first if it is ringing in). */
  attach(callId: string, stream: StreamConfig): CallRecord {
    const current = this.options.state.getCall(callId);
    if (!current || !LIVE_STATES.has(current.state)) throw new Error("call is not live");
    this.bridges.get(callId)?.stop();
    this.bridges.delete(callId);
    const call = this.options.state.setCallStream(callId, stream)!;
    if (call.state === "ringing" && call.direction === "incoming") this.command(call, "answer");
    if (call.state === "active") this.startBridge(call);
    return call;
  }

  detach(callId: string): void {
    this.options.state.setCallStream(callId, undefined);
    this.bridges.get(callId)?.stop();
  }

  info(callId: string) {
    const bridge = this.bridges.get(callId);
    const call = this.options.state.getCall(callId);
    return {
      stream: call?.stream ?? null,
      status: bridge?.status ?? (call?.stream ? "waiting" : "off"),
      error: bridge?.error,
    };
  }

  /**
   * Called for every call update. Returns true when it took an incoming call (so the built-in
   * assistant leaves it alone).
   */
  onCallEvent(call: CallRecord, event: DeviceEventName): boolean {
    let claimed = false;
    if (event === "call.ringing" && call.direction === "incoming" && !call.stream) {
      const target = this.incomingTarget();
      if (target) {
        call = this.options.state.setCallStream(call.id, target) ?? call;
        setTimeout(() => this.command(call, "answer"), 1_000); // let the phone settle before answering
        claimed = true;
      }
    }
    if (call.stream && call.state === "active") this.startBridge(call);
    if (!LIVE_STATES.has(call.state)) this.bridges.get(call.id)?.stop();
    return claimed || Boolean(call.stream);
  }

  private startBridge(call: CallRecord): void {
    if (!call.stream || this.bridges.has(call.id)) return;
    const bridge = new StreamBridge({
      call,
      config: call.stream,
      mediaUrl: this.options.mediaUrl(call.id),
      apiKey: this.options.apiKey,
      onAgentClosed: () => {
        const latest = this.options.state.getCall(call.id);
        if (latest && LIVE_STATES.has(latest.state)) this.command(latest, "hangup");
      },
      onEnded: () => {
        if (this.bridges.get(call.id) === bridge) this.bridges.delete(call.id);
      },
    });
    this.bridges.set(call.id, bridge);
    bridge.start();
  }

  private command(call: CallRecord, action: "answer" | "hangup"): void {
    try {
      this.options.deviceChannel.send(call.deviceId, { action, callId: call.id });
    } catch (error) {
      console.error(`stream could not ${action} ${call.id}:`, error instanceof Error ? error.message : error);
    }
  }
}
