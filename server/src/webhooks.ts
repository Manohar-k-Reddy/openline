import { createHmac } from "node:crypto";
import type { WebhookPayload } from "./types.js";

export interface WebhookDispatcher {
  dispatch(url: string, payload: WebhookPayload): Promise<void>;
}

export class HttpWebhookDispatcher implements WebhookDispatcher {
  constructor(
    private readonly signingSecret: string,
    private readonly timeoutMs = 5000,
  ) {}

  async dispatch(url: string, payload: WebhookPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openline-timestamp": timestamp,
          "x-openline-signature": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
