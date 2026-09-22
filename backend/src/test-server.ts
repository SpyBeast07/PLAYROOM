import { websocket } from "hono/bun";
import { createApp } from "./app.ts";

export interface TestServer {
  baseUrl: string;
  wsBase: string;
  close: () => void;
}

export function startTestServer(): TestServer {
  const app = createApp();
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  return {
    baseUrl: `http://localhost:${server.port}`,
    wsBase: `ws://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

export async function withServer<T>(fn: (server: TestServer) => Promise<T>): Promise<T> {
  const server = startTestServer();
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

export interface ApiResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const isBody = body !== undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: isBody ? { "Content-Type": "application/json" } : undefined,
    body: isBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { status: res.status, body: text, json };
}

export type WsMsg = { type: string; [key: string]: unknown };

export class WsClient {
  readonly ws: WebSocket;
  readonly opened: Promise<boolean>;
  readonly closed: Promise<boolean>;
  private readonly queue: WsMsg[] = [];
  private waiter: ((msg: WsMsg) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve) => {
      this.ws.onopen = () => resolve(true);
    });
    this.closed = new Promise((resolve) => {
      this.ws.onclose = () => resolve(true);
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as WsMsg;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(msg);
      } else {
        this.queue.push(msg);
      }
    };
  }

  async next(timeoutMs = 2000): Promise<WsMsg> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      setTimeout(() => {
        if (this.waiter) {
          this.waiter = null;
          reject(new Error("Timed out waiting for WebSocket message"));
        }
      }, timeoutMs);
    });
  }

  sentRaw(raw: string): void {
    this.ws.send(raw);
  }

  /** Return everything queued so far without waiting (and clear the queue). */
  drain(): WsMsg[] {
    return this.queue.splice(0);
  }

  /**
   * Rendezvous with the socket handshake: wait until a message of `type` has
   * been received (waiting for further messages only as needed), then restore
   * everything collected back onto the queue in wire order. A drain() issued
   * afterwards is therefore guaranteed to contain the complete handshake —
   * including any messages still in flight when the barrier resolved.
   */
  async awaitSync(type: string, timeoutMs = 2000): Promise<void> {
    const collected: WsMsg[] = [];
    for (;;) {
      const queued = this.queue.shift();
      const msg =
        queued !== undefined
          ? queued
          : await new Promise<WsMsg>((resolve, reject) => {
              this.waiter = resolve;
              setTimeout(() => {
                if (this.waiter) {
                  this.waiter = null;
                  reject(new Error(`Timed out waiting for WebSocket message "${type}"`));
                }
              }, timeoutMs);
            });
      collected.push(msg);
      if (msg.type === type) break;
    }
    this.queue.unshift(...collected);
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed or never opened
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expectOpen(client: WsClient, timeoutMs = 2000): Promise<boolean> {
  return Promise.race([client.opened, sleep(timeoutMs).then(() => false)]);
}

export async function expectRejected(client: WsClient, timeoutMs = 1200): Promise<boolean> {
  const opened = await expectOpen(client, timeoutMs);
  if (opened) {
    client.close();
    return false;
  }
  return true;
}

export async function expectNoMessage(client: WsClient, waitMs = 400): Promise<boolean> {
  const msg = await client.next(waitMs).catch(() => undefined);
  return msg === undefined;
}