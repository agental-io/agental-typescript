import { AgentalError, ConnectionError } from "./errors.js";

/** The WebSocket subprotocol a terminal speaks. */
export const TERMINAL_PROTOCOL = "agental.terminal.v1";
/** The subprotocol a ticket is sent as: this, then the ticket. The ticket is never put in a URL. */
const TICKET_PROTOCOL_PREFIX = "ticket.";
/** The subprotocol the ticket's verifier is sent as: this, then the verifier. */
const VERIFIER_PROTOCOL_PREFIX = "verifier.";
/** The most the API takes in one message of what is typed. Longer input is sent in pieces this size. */
const MAX_INPUT_BYTES = 64 * 1024;
/** The least and most columns or rows a terminal may have. */
const MIN_SIZE = 1;
const MAX_SIZE = 1000;

/** The close codes a terminal's WebSocket ends with, besides 1000 for a shell that ended. */
export const TERMINAL_CLOSE = {
  /** The shell ended: exitCode says how. */
  exited: 1000,
  /** What let it be opened no longer does: a key taken away or limited, a session ended, the sandbox stopped or deleted. */
  accessEnded: 4003,
  /** Nothing was typed in it for 30 minutes. */
  idle: 4008,
  /** It could not be opened, or its sandbox stopped answering. error says why when the API said. */
  failed: 4011,
} as const;

/** What the WebSocket constructor of the runtime is asked for: the one in Node 22 and later, in browsers, and in Deno and Bun, or the ws package's. */
export interface WebSocketLike {
  readonly protocol: string;
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  // The event's type is the runtime's own, which differs between them: any, so that each fits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike;

export interface TerminalOptions {
  /** Its width in columns, 1 to 1000. Default 80. */
  cols?: number;
  /** Its height in rows, 1 to 1000. Default 24. */
  rows?: number;
}

/** How a terminal ended. */
export interface TerminalExit {
  /**
   * What the shell exited with, when it ended by itself (closeCode 1000). Null when the
   * terminal was closed before the shell said: by close(), or by the API (closeCode 4003,
   * 4008, 4011), or because the connection was lost.
   */
  exitCode: number | null;
  /** The signal that ended the shell, 0 when none did. */
  signal: number;
  /** Whether the shell was ended because a terminal is kept open at most 12 hours. */
  timedOut: boolean;
  /** The WebSocket's close code: see TERMINAL_CLOSE. 1006 when the connection was lost without one. */
  closeCode: number;
  /** The close reason the API gave, in words. */
  reason: string;
  /** The error the API said before it closed the terminal, when it said one. */
  error: { code: string; message: string } | null;
}

/**
 * A verifier, kept in memory alone, and its S256 challenge (RFC 7636), which a ticket is asked with: the ticket then
 * opens the terminal only with the verifier, which no answer carries, from whatever address the WebSocket leaves by.
 */
export async function terminalPkce(): Promise<{ verifier: string; challenge: string }> {
  const base64url = (bytes: Uint8Array): string => {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AgentalError("A terminal needs Web Crypto (globalThis.crypto.subtle): Node 20 or later, or a page on HTTPS.");
  }
  const verifier = base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** A ticket from POST /v1/sandboxes/{id}/terminal. */
export interface TerminalTicket {
  ticket: string;
  expiresAt: string;
  path: string;
  protocols: string[];
}

/** A whole number of columns or rows, or an error that says what it may be. */
function size(value: number, what: "cols" | "rows"): number {
  if (!Number.isInteger(value) || value < MIN_SIZE || value > MAX_SIZE) {
    throw new AgentalError(`A terminal's ${what} is a whole number from ${MIN_SIZE} to ${MAX_SIZE}, not ${String(value)}.`);
  }
  return value;
}

/** The terminal's width and height, as given or 80 by 24. */
export function terminalSize(options: TerminalOptions): { cols: number; rows: number } {
  return { cols: size(options.cols ?? 80, "cols"), rows: size(options.rows ?? 24, "rows") };
}

const encoder = new TextEncoder();

/**
 * A login shell in a sandbox, as root in /root, open over a WebSocket. Its output is read by
 * iterating it, each piece as bytes as the shell wrote them; what is typed is sent with
 * write(), and a new size with resize(). It ends when the shell does, when close() is called,
 * or when the API closes it, and then exited says how. Closing it hangs the shell up: what
 * runs in it is sent SIGHUP, as when an SSH session ends.
 *
 * Output is kept until it is read: a caller that stops reading should close() it.
 */
export class Terminal implements AsyncIterable<Uint8Array> {
  /** How it ended, once it has. It never rejects. */
  readonly exited: Promise<TerminalExit>;
  private readonly socket: WebSocketLike;
  private readonly output: Uint8Array[] = [];
  private waiting: Array<() => void> = [];
  private exit: { code: number; signal: number; timedOut: boolean } | null = null;
  private error: { code: string; message: string } | null = null;
  private ended: TerminalExit | null = null;
  private started = false;
  private startedListeners: Array<() => void> = [];

  private constructor(socket: WebSocketLike) {
    this.socket = socket;
    this.exited = new Promise<TerminalExit>((resolve) => {
      socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
        this.ended = {
          exitCode: this.exit?.code ?? null,
          signal: this.exit?.signal ?? 0,
          timedOut: this.exit?.timedOut ?? false,
          closeCode: event.code ?? 1006,
          reason: event.reason ?? "",
          error: this.error,
        };
        this.wake();
        resolve(this.ended);
      });
    });
    socket.addEventListener("message", (event: { data: unknown }) => this.received(event.data));
  }

  /**
   * Opens a WebSocket to the terminal a ticket is for, and gives the terminal once the API has
   * taken the ticket. The ticket, and the verifier of the challenge it was asked with, go only in
   * the subprotocols, never in the URL.
   */
  static async open(WebSocket: WebSocketConstructor, url: string, ticket: string, verifier?: string): Promise<Terminal> {
    const protocols = [TERMINAL_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`];
    if (verifier !== undefined) {
      protocols.push(`${VERIFIER_PROTOCOL_PREFIX}${verifier}`);
    }
    const socket = new WebSocket(url, protocols);
    socket.binaryType = "arraybuffer";
    const terminal = new Terminal(socket);
    await new Promise<void>((resolve, reject) => {
      let open = false;
      socket.addEventListener("open", () => {
        open = true;
        resolve();
      });
      socket.addEventListener("close", (event: { code?: number }) => {
        if (!open) {
          // A refused handshake says nothing more to a WebSocket than that it was refused.
          reject(new ConnectionError(`The terminal could not be opened (WebSocket closed with ${event.code ?? 1006}). The ticket may have expired or been used.`));
        }
      });
    });
    if (socket.protocol !== TERMINAL_PROTOCOL) {
      // 1000: a WebSocket of the runtime's takes no other code below 3000.
      socket.close(1000, "not a terminal");
      throw new ConnectionError(`The API answered the terminal with the subprotocol ${JSON.stringify(socket.protocol)}, not ${TERMINAL_PROTOCOL}.`);
    }
    return terminal;
  }

  /** Whether the shell has started. What is typed before it has is kept, up to 64 KiB, and given to it once it has. */
  get hasStarted(): boolean {
    return this.started;
  }

  /** Resolves once the shell has started; at once if it has. Never rejects: it also resolves when the terminal ends first. */
  whenStarted(): Promise<void> {
    if (this.started || this.ended) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.startedListeners.push(resolve));
  }

  /** Sends what is typed: text as UTF-8, or bytes as they are. Throws a ConnectionError once it has ended or is closing. */
  write(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.mustBeOpen();
    for (let at = 0; at < bytes.length; at += MAX_INPUT_BYTES) {
      this.socket.send(bytes.subarray(at, at + MAX_INPUT_BYTES));
    }
  }

  /** Gives the terminal a new size, 1 to 1000 columns and rows, as a local terminal's window changes. Throws a ConnectionError once it has ended. */
  resize(cols: number, rows: number): void {
    const message = JSON.stringify({ type: "resize", cols: size(cols, "cols"), rows: size(rows, "rows") });
    this.mustBeOpen();
    this.socket.send(message);
  }

  private mustBeOpen(): void {
    if (this.ended || this.socket.readyState !== 1) {
      throw new ConnectionError("The terminal has ended.");
    }
  }

  /** Closes it, which hangs the shell up. exited resolves once it has closed. */
  close(): void {
    if (!this.ended) {
      this.socket.close(1000, "closed");
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, void> {
    try {
      for (;;) {
        const next = this.output.shift();
        if (next) {
          yield next;
          continue;
        }
        if (this.ended) {
          return;
        }
        await new Promise<void>((resolve) => {
          this.waiting.push(resolve);
        });
      }
    } finally {
      // A reader that stops early (break, return, throw) is done with it.
      if (!this.ended) {
        this.close();
      }
    }
  }

  private received(data: unknown): void {
    if (typeof data === "string") {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message["type"] === "started") {
        this.started = true;
        for (const listener of this.startedListeners.splice(0)) {
          listener();
        }
      } else if (message["type"] === "exit") {
        this.exit = { code: Number(message["code"] ?? 0), signal: Number(message["signal"] ?? 0), timedOut: message["timedOut"] === true };
      } else if (message["type"] === "error") {
        this.error = { code: String(message["code"] ?? "terminal"), message: String(message["message"] ?? "") };
      }
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes && bytes.length > 0) {
      this.output.push(bytes);
      this.wake();
    }
  }

  private wake(): void {
    for (const waiting of this.waiting.splice(0)) {
      waiting();
    }
    if (this.ended) {
      for (const listener of this.startedListeners.splice(0)) {
        listener();
      }
    }
  }
}
