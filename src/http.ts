import { AgentalError, ApiError, ConnectionError, ProxyError } from "./errors.js";
import type { WebSocketConstructor } from "./terminal.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://agental.io";

export interface AgentalOptions {
  /**
   * Your API key. Left out, it is read from the environment variable AGENTAL_API_KEY, or else
   * from the sign-in the agental command keeps on this computer (`npx agental@latest`).
   */
  apiKey?: string;
  /** Where the API answers. Left out, it is AGENTAL_API_URL, or the API the agental command signed in to, or https://agental.io. */
  baseUrl?: string;
  /** What requests are sent with. Left out, it is the runtime's own fetch. */
  fetch?: typeof fetch;
  /** How many times a request that is safe to send again is sent again. Default 3. */
  maxRetries?: number;
  /** The shortest wait before a request is sent again, in milliseconds. Default 1000. */
  retryDelayMs?: number;
  /** How often something that is waited for is looked at, in milliseconds. Default 2000. */
  pollIntervalMs?: number;
  /**
   * What a sandbox's terminal is opened with. Left out, it is the runtime's own WebSocket: in
   * Node 22 and later, browsers, Deno and Bun. In Node 20, pass WebSocket from the ws package.
   */
  WebSocket?: WebSocketConstructor;
}

export interface Call {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | readonly string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Whether sending it twice does what sending it once does. Only such a request is sent
   * again by itself: a read, a create with its key, a file write. A command is not.
   */
  replay?: boolean;
  signal?: AbortSignal;
}

export interface StreamEvent {
  event: string;
  data: unknown;
}

/** How long a sandbox_migrating is waited out: a move of a running sandbox takes a minute or two. */
const MIGRATING_TRIES = 18;

interface NodeProcess {
  env?: Record<string, string | undefined>;
  /** Node's own modules, where the runtime has them: Node 20.16 and later. */
  getBuiltinModule?: (name: string) => unknown;
}

const runtime = (): NodeProcess | undefined => (globalThis as { process?: NodeProcess }).process;

function environment(name: string): string | undefined {
  const value = runtime()?.env?.[name];
  return value?.trim() || undefined;
}

/**
 * What every request says it is, where the runtime lets it: agental-typescript/0.2.0. A
 * browser sends its own User-Agent, and asked for another it would ask the API first whether
 * it may, so in a browser none is set.
 */
function userAgent(): Record<string, string> {
  const inBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined" || typeof (globalThis as { importScripts?: unknown }).importScripts === "function";
  return inBrowser ? {} : { "User-Agent": `agental-typescript/${VERSION}` };
}

const sameApi = (left: string, right: string): boolean => left.replace(/\/+$/, "") === right.replace(/\/+$/, "");

/**
 * The key and the API the agental command signed in with on this computer, kept in
 * ~/.config/agental/credentials.json (or under XDG_CONFIG_HOME). Nothing where there is no
 * such file, or no file system, as in a browser.
 */
function signedIn(): { apiUrl: string; apiKey: string } | undefined {
  const fs = runtime()?.getBuiltinModule?.("node:fs") as { readFileSync(file: string, encoding: "utf8"): string } | undefined;
  const os = runtime()?.getBuiltinModule?.("node:os") as { homedir(): string } | undefined;
  const path = runtime()?.getBuiltinModule?.("node:path") as { join(...parts: string[]): string } | undefined;
  if (!fs || !os || !path) {
    return undefined;
  }
  try {
    const base = environment("XDG_CONFIG_HOME") ?? path.join(environment("HOME") ?? os.homedir(), ".config");
    const saved = JSON.parse(fs.readFileSync(path.join(base, "agental", "credentials.json"), "utf8")) as Record<string, unknown>;
    return typeof saved["apiUrl"] === "string" && typeof saved["apiKey"] === "string" ? { apiUrl: saved["apiUrl"], apiKey: saved["apiKey"] } : undefined;
  } catch {
    return undefined;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stopped);
      resolve();
    }, ms);
    const stopped = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stopped, { once: true });
  });
}

/** Sends requests to the API, and sends again the ones that are safe to. */
export class Http {
  readonly pollIntervalMs: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly webSocket: WebSocketConstructor | undefined;

  constructor(options: AgentalOptions = {}) {
    let apiKey = options.apiKey ?? environment("AGENTAL_API_KEY");
    let baseUrl = options.baseUrl ?? environment("AGENTAL_API_URL");
    if (!apiKey) {
      // The agental command's sign-in, for the API it was made to and no other.
      const saved = signedIn();
      if (saved && (baseUrl === undefined || sameApi(baseUrl, saved.apiUrl))) {
        apiKey = saved.apiKey;
        baseUrl = saved.apiUrl;
      }
    }
    if (!apiKey) {
      throw new AgentalError(
        "No API key. Pass apiKey, or set AGENTAL_API_KEY, or sign in on this computer with npx agental@latest. Keys are made in the console, under API keys.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.webSocket = options.WebSocket;
  }

  /** The WebSocket a terminal is opened with: the one given, else the runtime's own. */
  get WebSocket(): WebSocketConstructor {
    const found = this.webSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!found) {
      throw new AgentalError("This runtime has no WebSocket, which a terminal is opened with. Use Node 22 or later, or pass new Agental({ WebSocket }) with WebSocket from the ws package.");
    }
    return found;
  }

  /**
   * The ws: or wss: URL of a path on the API's own address, as a terminal's WebSocket is opened
   * on it. Only a path is taken, so that no answer can send the WebSocket, and the ticket in
   * it, to another host.
   */
  webSocketUrl(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path)) {
      throw new AgentalError(`The API gave the terminal a path that is not one on its own address: ${JSON.stringify(path.slice(0, 200))}.`);
    }
    const url = new URL(this.baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AgentalError(`A terminal is opened on an http: or https: API, not ${url.protocol}.`);
    }
    return `${url.origin.replace(/^http/, "ws")}${url.pathname.replace(/\/+$/, "")}${path}`;
  }

  /** The answer to a request that worked. One that did not is thrown, after it was sent again if that was safe. */
  async send(call: Call): Promise<Response> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (typeof value === "string") {
        query.set(name, value);
      } else if (value !== undefined) {
        for (const one of value) {
          query.append(name, one);
        }
      }
    }
    const url = `${this.baseUrl}${call.path}${query.size > 0 ? `?${query}` : ""}`;
    const init: RequestInit = {
      method: call.method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...userAgent(),
        ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...call.headers,
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      ...(call.signal ? { signal: call.signal } : {}),
    };
    for (let attempt = 0; ; attempt += 1) {
      let failure: AgentalError;
      try {
        const response = await this.fetch(url, init);
        if (response.ok) {
          return response;
        }
        failure = await errorOf(response);
      } catch (error) {
        if (call.signal?.aborted) {
          throw error;
        }
        failure = new ConnectionError(`Could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const wait = this.waitBefore(failure, attempt, call.replay === true);
      if (wait === null) {
        throw failure;
      }
      await sleep(wait, call.signal);
    }
  }

  /** The JSON a request was answered with, and the status and headers it came with. */
  async json<T>(call: Call): Promise<{ status: number; body: T; headers: Headers }> {
    const response = await this.send(call);
    return { status: response.status, body: (await response.json()) as T, headers: response.headers };
  }

  /** The server-sent events a request is answered with, each as it arrives. */
  async *events(call: Call): AsyncGenerator<StreamEvent, void, void> {
    const response = await this.send({ ...call, headers: { ...call.headers, Accept: "text/event-stream" } });
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        buffered = (buffered + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
        // A blank line ends an event.
        for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
          const lines = buffered.slice(0, end).split("\n");
          buffered = buffered.slice(end + 2);
          const field = (name: string): string =>
            lines
              .filter((line) => line.startsWith(`${name}:`))
              .map((line) => line.slice(name.length + 1).replace(/^ /, ""))
              .join("\n");
          const event = field("event");
          if (event) {
            yield { event, data: parsed(field("data")) };
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * How long to wait before a failed request is sent again, or null when it is not to be.
   * The waits are the ones the API asks for: a request cut off by a move is sent again at
   * once, a move under way is waited out, and a proxy or a failing host is given ten times
   * the shortest wait. Only a request that may be sent twice is sent again, except one the
   * API turned away as it restarted: nothing was done with that one, a command neither.
   */
  private waitBefore(failure: AgentalError, attempt: number, replay: boolean): number | null {
    if (failure instanceof ApiError && failure.code === "restarting") {
      return attempt < this.maxRetries ? this.retryDelayMs : null;
    }
    if (!replay) {
      return null;
    }
    if (failure instanceof ApiError) {
      if (failure.code === "sandbox_migrating") {
        return attempt < MIGRATING_TRIES ? this.retryDelayMs * 10 : null;
      }
      if (failure.code === "sandbox_moved") {
        return attempt < this.maxRetries ? this.retryDelayMs : null;
      }
      if (failure.code === "host_error" || failure.code === "internal_error") {
        return attempt < 1 ? this.retryDelayMs * 10 : null;
      }
      return null;
    }
    if (attempt >= this.maxRetries) {
      return null;
    }
    if (failure instanceof ProxyError) {
      return failure.status >= 500 ? this.retryDelayMs * 10 : null;
    }
    return failure instanceof ConnectionError ? this.retryDelayMs * 2 ** attempt : null;
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The API's own error when the answer has a code and a message in it, and a proxy's when it has not. */
async function errorOf(response: Response): Promise<AgentalError> {
  const body = parsed(await response.text().catch(() => ""));
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  if (error && typeof error === "object") {
    const { code, message, regionsWithRoom, feeMicros, retryAfterSeconds, refusedLastHour, headroomUrl } = error as {
      code?: unknown;
      message?: unknown;
      regionsWithRoom?: unknown;
      feeMicros?: unknown;
      retryAfterSeconds?: unknown;
      refusedLastHour?: unknown;
      headroomUrl?: unknown;
    };
    if (typeof code === "string" && typeof message === "string") {
      const regions = Array.isArray(regionsWithRoom) ? regionsWithRoom.filter((one): one is string => typeof one === "string") : undefined;
      const refusal = {
        ...(typeof feeMicros === "number" ? { feeMicros } : {}),
        ...(typeof retryAfterSeconds === "number" || retryAfterSeconds === null ? { retryAfterSeconds } : {}),
        ...(typeof refusedLastHour === "number" ? { refusedLastHour } : {}),
        ...(typeof headroomUrl === "string" ? { headroomUrl } : {}),
      };
      return new ApiError(response.status, code, message, regions, refusal);
    }
  }
  return new ProxyError(response.status);
}

/**
 * A tag as a part of a path: lowercased and trimmed as the API would, and refused here when it
 * is not one, so that no word, "..", say, can make the path another.
 */
export function tagSegment(tag: string): string {
  const word = tag.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(word)) {
    throw new AgentalError(`A tag is lowercase letters, digits and hyphens, 1 to 63 characters, not starting or ending with a hyphen, not ${JSON.stringify(tag)}.`);
  }
  return word;
}
