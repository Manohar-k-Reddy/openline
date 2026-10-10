import type { Database } from "./db.js";
import type { StateStore } from "./state.js";
import type { CallRecord, DeviceEvent, DeviceEventName, WebhookPayload } from "./types.js";
import type { WebhookDispatcher } from "./webhooks.js";

/** Delays before retrying a failed webhook (the first attempt is immediate). */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export interface WebhookDelivery {
  id: number;
  callId?: string;
  eventId: string;
  event: string;
  url: string;
  attempt: number;
  ok: boolean;
  error?: string;
  at: string;
}

export class DeviceEventService {
  /** In-process observer of call updates (used by the AI assistant). */
  onCallEvent?: (call: CallRecord, event: DeviceEventName) => void;

  constructor(
    private readonly state: StateStore,
    private readonly webhookDispatcher: WebhookDispatcher,
    /** Account-wide webhook (console setting or WEBHOOK_URL); a call's own webhookUrl wins. */
    private readonly defaultWebhookUrl: () => string | undefined,
    private readonly db?: Database,
    private readonly retryDelaysMs = RETRY_DELAYS_MS,
  ) {}

  async ingest(deviceId: string, event: DeviceEvent): Promise<void> {
    const device = this.state.getDevice(deviceId);
    if (!device) throw new Error(`unknown device ${deviceId}`);

    const existing = this.state.getCall(event.callId);
    if (existing && existing.deviceId !== deviceId) {
      throw new Error("call does not belong to authenticated device");
    }

    if (!this.state.recordEvent(deviceId, event)) return; // duplicate
    this.state.touchDevice(deviceId);

    const call = this.state.applyDeviceEvent(deviceId, event);
    if (!call || event.event === "command.ack" || event.event === "command.completed") return;
    try {
      this.onCallEvent?.(call, event.event);
    } catch (error) {
      console.error("call event observer failed", error);
    }

    const targetUrl = call.webhookUrl ?? this.defaultWebhookUrl();
    if (!targetUrl) return;

    const payload: WebhookPayload = {
      event: event.event,
      eventId: event.eventId,
      occurredAt: event.timestamp,
      device: this.state.getDevice(deviceId) ?? device,
      call,
      payload: event.payload,
    };
    await this.deliver(targetUrl, payload, 1);
  }

  listDeliveries(query: { callId?: string; limit?: number } = {}): WebhookDelivery[] {
    if (!this.db) return [];
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = (
      query.callId
        ? this.db.prepare("SELECT * FROM webhook_deliveries WHERE call_id = ? ORDER BY id DESC LIMIT ?").all(query.callId, limit)
        : this.db.prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?").all(limit)
    ) as { id: number; call_id: string | null; event_id: string; event: string; url: string; attempt: number; ok: number; error: string | null; at: string }[];
    return rows.map((r) => ({
      id: r.id,
      callId: r.call_id ?? undefined,
      eventId: r.event_id,
      event: r.event,
      url: r.url,
      attempt: r.attempt,
      ok: r.ok === 1,
      error: r.error ?? undefined,
      at: r.at,
    }));
  }

  private async deliver(url: string, payload: WebhookPayload, attempt: number): Promise<void> {
    let error: string | undefined;
    try {
      await this.webhookDispatcher.dispatch(url, payload);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`webhook ${payload.event} attempt ${attempt} failed:`, error);
    }
    this.db
      ?.prepare(
        "INSERT INTO webhook_deliveries (call_id, event_id, event, url, attempt, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(payload.call.id, payload.eventId, payload.event, url, attempt, error ? 0 : 1, error ?? null, new Date().toISOString());

    const delay = this.retryDelaysMs[attempt - 1];
    if (error && delay !== undefined) {
      setTimeout(() => void this.deliver(url, payload, attempt + 1), delay).unref();
    }
  }
}
