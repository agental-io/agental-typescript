import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Agental, AgentalError, ConnectionError, TERMINAL_PROTOCOL, type SandboxInfo, type WebSocketConstructor } from "../src/index.js";

// A sandbox's terminal: the ticket asked for with POST, then a WebSocket opened with it as a
// subprotocol, never in its URL. The WebSocket is a stand-in that notes what is sent and says
// what it is told to; the API's side is tried in the agental repository's test/terminal.test.ts.

const SANDBOX = { id: "sbx_0123456789abcdef", name: "agent-1", status: "running" } as unknown as SandboxInfo;
const TICKET = "a".repeat(43);

type Listener = (event: unknown) => void;

/** A WebSocket that is opened, or refused, as it is told, and keeps what is sent on it. */
class FakeSocket {
  static made: FakeSocket[] = [];
  static refuse = false;
  static answerProtocol = TERMINAL_PROTOCOL;
  readonly sent: Array<string | Uint8Array> = [];
  readonly listeners = new Map<string, Listener[]>();
  protocol = "";
  readyState = 0;
  binaryType = "blob";
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.made.push(this);
    setTimeout(() => {
      if (FakeSocket.refuse) {
        this.emit("close", { code: 1006, reason: "" });
        return;
      }
      this.protocol = FakeSocket.answerProtocol;
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    setTimeout(() => this.emit("close", { code: code ?? 1005, reason: reason ?? "" }), 0);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /** The API says a text message. */
  say(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** The shell prints. */
  print(text: string): void {
    this.emit("message", { data: new TextEncoder().encode(text).buffer });
  }

  /** The API closes it. */
  end(code: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

function client(baseUrl = "https://api.test/"): { agental: Agental; posted: Array<{ url: string; body: unknown; auth: string | null }> } {
  FakeSocket.made = [];
  FakeSocket.refuse = false;
  FakeSocket.answerProtocol = TERMINAL_PROTOCOL;
  const posted: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const agental = new Agental({
    apiKey: "key_test",
    baseUrl,
    retryDelayMs: 0,
    WebSocket: FakeSocket as unknown as WebSocketConstructor,
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.method === "GET") {
        return Response.json(SANDBOX);
      }
      posted.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(
        { ticket: TICKET, expiresAt: "2026-11-12T00:00:30.000Z", path: "/v1/sandboxes/sbx_0123456789abcdef/terminal", protocols: [TERMINAL_PROTOCOL, `ticket.${TICKET}`] },
        { status: 201 },
      );
    },
  });
  return { agental, posted };
}

test("a terminal is asked for with its size, and opened with the ticket as a subprotocol, never in the URL", async () => {
  const { agental, posted } = client();
  const sandbox = await agental.sandboxes.get("sbx_0123456789abcdef");
  const terminal = await sandbox.terminal({ cols: 120, rows: 32 });
  const { challenge, ...size } = posted[0]!.body as { cols: number; rows: number; challenge: string };
  assert.deepEqual([{ ...posted[0]!, body: size }], [{ url: "https://api.test/v1/sandboxes/sbx_0123456789abcdef/terminal", body: { cols: 120, rows: 32 }, auth: "Bearer key_test" }]);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const socket = FakeSocket.made[0]!;
  assert.equal(socket.url, "wss://api.test/v1/sandboxes/sbx_0123456789abcdef/terminal");
  assert.ok(!socket.url.includes(TICKET), "the ticket is in no URL");
  // Then the verifier of the challenge it was asked with (RFC 7636, S256), which no answer carries.
  assert.deepEqual(socket.protocols.slice(0, 2), [TERMINAL_PROTOCOL, `ticket.${TICKET}`]);
  const verifier = socket.protocols[2]!.replace(/^verifier\./, "");
  assert.equal(socket.protocols.length, 3);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.equal(socket.binaryType, "arraybuffer");
  terminal.close();
});

test("what is typed goes as binary, a resize as text, and output and the exit come back", async () => {
  const { agental } = client();
  const terminal = await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  const socket = FakeSocket.made[0]!;
  assert.equal(terminal.hasStarted, false);
  const started = terminal.whenStarted();
  socket.say({ type: "started" });
  await started;
  assert.equal(terminal.hasStarted, true);

  terminal.write("ls\n");
  terminal.write(new Uint8Array([3]));
  terminal.resize(132, 40);
  assert.deepEqual(new TextDecoder().decode(socket.sent[0] as Uint8Array), "ls\n");
  assert.deepEqual([...(socket.sent[1] as Uint8Array)], [3]);
  assert.equal(socket.sent[2], JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
  assert.throws(() => terminal.resize(0, 40), AgentalError);
  assert.throws(() => terminal.resize(80, 1001), AgentalError);

  socket.print("one ");
  socket.print("two\n");
  socket.say({ type: "exit", code: 3, signal: 0, timedOut: false });
  socket.end(1000, "the shell ended");

  let out = "";
  for await (const chunk of terminal) {
    out += new TextDecoder().decode(chunk);
  }
  assert.equal(out, "one two\n");
  assert.deepEqual(await terminal.exited, { exitCode: 3, signal: 0, timedOut: false, closeCode: 1000, reason: "the shell ended", error: null });

  // Nothing is sent once it has ended, and the caller is told.
  assert.throws(() => terminal.write("more"), ConnectionError);
  assert.throws(() => terminal.resize(80, 24), ConnectionError);
  assert.equal(socket.sent.length, 3);
});

test("two readers are each woken by what arrives, and by the end", async () => {
  const { agental } = client();
  const terminal = await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  const socket = FakeSocket.made[0]!;
  const read = async (): Promise<number> => {
    let pieces = 0;
    for await (const _chunk of terminal) {
      pieces += 1;
    }
    return pieces;
  };
  const both = Promise.all([read(), read()]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.print("one");
  socket.print("two");
  socket.end(1000);
  const [first, second] = await both;
  assert.equal(first + second, 2);
});

test("input longer than 64 KiB goes in pieces the API takes", async () => {
  const { agental } = client();
  const terminal = await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  const socket = FakeSocket.made[0]!;
  terminal.write(new Uint8Array(64 * 1024 * 2 + 5));
  assert.deepEqual(
    socket.sent.map((piece) => (piece as Uint8Array).length),
    [65536, 65536, 5],
  );
  terminal.close();
});

test("a terminal the API closes says why, with no exit code", async () => {
  const { agental } = client();
  const terminal = await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  const socket = FakeSocket.made[0]!;
  socket.say({ type: "error", code: "access_ended", message: "The key was revoked." });
  socket.end(4003, "access ended");
  const exit = await terminal.exited;
  assert.equal(exit.exitCode, null);
  assert.equal(exit.closeCode, 4003);
  assert.deepEqual(exit.error, { code: "access_ended", message: "The key was revoked." });
});

test("a reader that stops early closes it, which hangs the shell up", async () => {
  const { agental } = client();
  const terminal = await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  const socket = FakeSocket.made[0]!;
  socket.print("first");
  for await (const _chunk of terminal) {
    break;
  }
  assert.deepEqual(socket.closedWith, { code: 1000, reason: "closed" });
  assert.equal((await terminal.exited).closeCode, 1000);
  assert.equal((await terminal.exited).exitCode, null);
});

test("a refused handshake, or one answered without the terminal's protocol, is an error without the ticket in it", async () => {
  const { agental } = client();
  const sandbox = await agental.sandboxes.get("sbx_0123456789abcdef");
  FakeSocket.refuse = true;
  await assert.rejects(sandbox.terminal(), (error: unknown) => error instanceof ConnectionError && !error.message.includes(TICKET));
  FakeSocket.refuse = false;
  FakeSocket.answerProtocol = "something.else";
  await assert.rejects(sandbox.terminal(), /not agental\.terminal\.v1/);
  // Closed with a code a runtime's WebSocket takes, so that the shell is hung up.
  assert.deepEqual(FakeSocket.made.at(-1)!.closedWith, { code: 1000, reason: "not a terminal" });
});

test("the size is checked before a ticket is asked for", async () => {
  const { agental, posted } = client();
  const sandbox = await agental.sandboxes.get("sbx_0123456789abcdef");
  await assert.rejects(sandbox.terminal({ cols: 0 }), /cols is a whole number from 1 to 1000/);
  await assert.rejects(sandbox.terminal({ rows: 24.5 }), /rows is a whole number/);
  assert.equal(posted.length, 0);
});

test("the WebSocket goes to the API's own address: ws for http, a path under a base path, and no path that leaves it", async () => {
  const { agental } = client("http://127.0.0.1:8741/api/");
  await (await agental.sandboxes.get("sbx_0123456789abcdef")).terminal();
  assert.equal(FakeSocket.made[0]!.url, "ws://127.0.0.1:8741/api/v1/sandboxes/sbx_0123456789abcdef/terminal");

  const http = (agental as unknown as { http: { webSocketUrl(path: string): string } }).http;
  for (const path of ["//evil.test/x", "@evil.test/x", "https://evil.test/x", "/v1/a b", "/v1\\x"]) {
    assert.throws(() => http.webSocketUrl(path), AgentalError, path);
  }
});

// Node 20, which the SDK supports, has no WebSocket of its own: there a caller passes one, as the ws package's.
const ownWebSocket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
test("the runtime's own WebSocket is the kind a terminal takes", { skip: ownWebSocket === undefined && "this Node has no WebSocket of its own" }, () => {
  // Typechecked: Node 22's WebSocket, as browsers' is, fits WebSocketConstructor.
  const own: WebSocketConstructor | undefined = ownWebSocket;
  assert.equal(typeof own, "function");
});
