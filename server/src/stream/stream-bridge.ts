import { WebSocket, type RawData } from "ws";
import { MEDIA_FORMAT } from "../media-relay.js";
import type { CallRecord, StreamConfig } from "../types.js";
import { MulawUpsampler, pcm16kToMulaw8k } from "./codec.js";

export type StreamStatus = "connecting" | "live" | "ended" | "error";

export interface StreamBridgeOptions {
  call: CallRecord;
  config: StreamConfig;
  /** This server's own client media WebSocket for the call, and a key it accepts. */
  mediaUrl: string;
  apiKey: string;
  /** The agent closed its socket or couldn't be reached: like Twilio, that ends the call. */
  onAgentClosed(): void;
  onEnded(): void;
}

const FRAME_BYTES = 640; // 20 ms at 16 kHz mono s16le

/**
 * Connects a call to an external agent's WebSocket (Pipecat, Vocode, LiveKit workers, custom code).
 * The server dials out to the agent, like Twilio's <Connect><Stream>. It joins the call through
 * the same media endpoint any client uses.
 *
 * Formats:
 * - raw: JSON {type:"start", ...} then binary 16 kHz s16le both ways; agent may send {type:"clear"}.
 * - twilio: Twilio Media Streams messages (connected/start/media/mark/stop, 8 kHz mu-law base64);
 *   accepts media, mark and clear from the agent.
 */
export class StreamBridge {
  status: StreamStatus = "connecting";
  error?: string;

  private media?: WebSocket;
  private agent?: WebSocket;
  private closed = false;
  private started = false;
  private sequence = 0;
  private chunk = 0;
  private readonly streamSid: string;
  private readonly upsampler = new MulawUpsampler();
  private toPhone = Buffer.alloc(0);
  /** When audio already sent to the phone will have finished playing (for Twilio marks). */
  private playbackEndsAt = 0;
  private readonly marks: { name: string; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly options: StreamBridgeOptions) {
    this.streamSid = `MZ${options.call.id.replace(/-/g, "")}`.slice(0, 34);
  }

  start(): void {
    const agent = new WebSocket(this.options.config.url);
    this.agent = agent;
    agent.on("open", () => {
      if (this.options.config.format === "twilio") {
        this.sendAgent({ event: "connected", protocol: "Call", version: "1.0.0" });
      }
      this.connectMedia();
    });
    agent.on("message", (data, isBinary) => this.onAgentMessage(data, isBinary));
    agent.on("close", () => {
      if (this.closed) return;
      this.stop();
      this.options.onAgentClosed();
    });
    agent.on("error", (error) => this.fail(error));
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.status !== "error") this.status = "ended";
    for (const mark of this.marks.splice(0)) clearTimeout(mark.timer);
    if (this.started) {
      if (this.options.config.format === "twilio") {
        this.sendAgent({
          event: "stop",
          sequenceNumber: String(++this.sequence),
          streamSid: this.streamSid,
          stop: { accountSid: "local", callSid: this.options.call.id },
        });
      } else {
        this.sendAgent({ type: "stop", callId: this.options.call.id });
      }
    }
    this.agent?.close(1000, "call ended");
    this.media?.close();
    this.options.onEnded();
  }

  private connectMedia(): void {
    const ws = new WebSocket(this.options.mediaUrl, { headers: { "x-api-key": this.options.apiKey } });
    this.media = ws;
    ws.on("message", (data: RawData, isBinary) => {
      if (isBinary) {
        if (this.started) this.forwardCallerAudio(data as Buffer);
        return;
      }
      const control = JSON.parse(data.toString()) as { type?: string };
      if (control.type === "start" && !this.started) this.onPhoneStart();
    });
    ws.on("close", () => this.stop());
    ws.on("error", (error) => this.fail(error));
  }

  private onPhoneStart(): void {
    this.started = true;
    this.status = "live";
    const call = this.options.call;
    const parameters = {
      callId: call.id,
      direction: call.direction,
      remoteNumber: call.remoteNumber,
      deviceId: call.deviceId,
      ...this.options.config.parameters,
    };
    if (this.options.config.format === "twilio") {
      this.sendAgent({
        event: "start",
        sequenceNumber: String(++this.sequence),
        streamSid: this.streamSid,
        start: {
          streamSid: this.streamSid,
          accountSid: "local",
          callSid: call.id,
          tracks: ["inbound"],
          customParameters: parameters,
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
      });
    } else {
      this.sendAgent({ type: "start", ...parameters, format: MEDIA_FORMAT });
    }
  }

  private forwardCallerAudio(pcm: Buffer): void {
    if (this.options.config.format === "raw") {
      if (this.agent?.readyState === WebSocket.OPEN) this.agent.send(pcm, { binary: true });
      return;
    }
    const payload = pcm16kToMulaw8k(pcm);
    this.sendAgent({
      event: "media",
      sequenceNumber: String(++this.sequence),
      streamSid: this.streamSid,
      media: {
        track: "inbound",
        chunk: String(++this.chunk),
        timestamp: String(this.chunk * 20),
        payload: payload.toString("base64"),
      },
    });
  }

  private onAgentMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      if (this.options.config.format === "raw") this.sendToPhone(data as Buffer);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = message.event ?? message.type;
    if (kind === "clear") return this.clear();
    if (kind === "media") {
      const payload = (message.media as { payload?: unknown } | undefined)?.payload;
      if (typeof payload === "string") this.sendToPhone(this.upsampler.process(Buffer.from(payload, "base64")));
      return;
    }
    if (kind === "mark") {
      const name = (message.mark as { name?: unknown } | undefined)?.name;
      if (typeof name === "string") this.scheduleMark(name);
    }
  }

  /** Splits agent audio into 20 ms frames for the phone and tracks when it will have played. */
  private sendToPhone(pcm: Buffer): void {
    this.toPhone = Buffer.concat([this.toPhone, pcm]);
    while (this.toPhone.length >= FRAME_BYTES) {
      const frame = this.toPhone.subarray(0, FRAME_BYTES);
      this.toPhone = this.toPhone.subarray(FRAME_BYTES);
      if (this.media?.readyState === WebSocket.OPEN) this.media.send(frame, { binary: true });
      this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + 20;
    }
  }

  /** Twilio sends a mark back once the audio queued before it has played. */
  private scheduleMark(name: string): void {
    const delay = Math.max(0, this.playbackEndsAt - Date.now());
    const mark = {
      name,
      timer: setTimeout(() => {
        this.marks.splice(this.marks.indexOf(mark), 1);
        this.sendMark(name);
      }, delay),
    };
    this.marks.push(mark);
  }

  private sendMark(name: string): void {
    this.sendAgent({ event: "mark", sequenceNumber: String(++this.sequence), streamSid: this.streamSid, mark: { name } });
  }

  /** Agent barge-in: drop queued speech on the phone; pending marks return at once, as on Twilio. */
  private clear(): void {
    this.toPhone = Buffer.alloc(0);
    this.playbackEndsAt = 0;
    if (this.media?.readyState === WebSocket.OPEN) this.media.send(JSON.stringify({ type: "clear" }));
    for (const mark of this.marks.splice(0)) {
      clearTimeout(mark.timer);
      this.sendMark(mark.name);
    }
  }

  private sendAgent(message: unknown): void {
    if (this.agent?.readyState === WebSocket.OPEN) this.agent.send(JSON.stringify(message));
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.status = "error";
    this.error = error instanceof Error ? error.message : String(error);
    console.error(`stream ${this.options.call.id} failed:`, this.error);
    this.stop();
    this.options.onAgentClosed(); // an unreachable agent would leave the caller in silence
  }
}
