import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Agental,
  AgentalError,
  ApiError,
  ConnectionError,
  ProxyError,
  verifyWebhook,
  type ApiKey,
  type ApiKeyUsage,
  type Billing,
  type Burst,
  type BurstQuote,
  type EgressAccount,
  type EmailMessageSummary,
  type HiddenVariable,
  type MetricsAtMoment,
  type MetricsReading,
  type RunningOverTime,
  type SandboxAutoStop,
  type SandboxInfo,
  type SandboxMetrics,
  type SandboxNetworkDetail,
  type DataRetention,
  type Telemetry,
  type TelemetryTest,
  type Webhook,
} from "../src/index.js";
import { VERSION } from "../src/version.js";

interface Sent {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function sandbox(changes: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    id: "sbx_0123456789abcdef",
    name: "agent-1",
    region: "main",
    size: "small",
    status: "running",
    hostId: null,
    activity: null,
    vmIsolation: true,
    resources: { vcpu: 1, memoryMb: 2048, diskGb: 10 },
    error: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    stoppedAt: null,
    ttlSeconds: null,
    autoStopAt: null,
    subdomain: null,
    shared: false,
    templateId: "tpl_0000000000000001",
    organizationId: "org_local",
    createdBy: null,
    archived: false,
    archivedAt: null,
    migratedAt: null,
    memoryKept: false,
    memoryLost: null,
    network: { outbound: "open", allow: [] },
    tags: [],
    metadata: {},
    ownTags: [],
    ownMetadata: {},
    ...changes,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function refusal(status: number, code: string): Response {
  return json(status, { error: { code, message: `${code} it is` } });
}

/** A client whose requests are answered in turn by what is given, and are kept to be looked at. */
function scripted(...answers: Array<Response | Error>): { agental: Agental; sent: Sent[] } {
  const sent: Sent[] = [];
  const agental = new Agental({
    apiKey: "key_test",
    baseUrl: "https://api.test/",
    retryDelayMs: 0,
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      sent.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const answer = answers.shift();
      if (!answer) {
        throw new Error(`nothing was scripted for request ${sent.length}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  });
  return { agental, sent };
}

test("a create sends a key and a name of its own, and the key of whoever calls it", async () => {
  const { agental, sent } = scripted(json(201, sandbox()), json(201, sandbox()));
  const made = await agental.sandboxes.create({ size: "medium" });
  assert.equal(made.id, "sbx_0123456789abcdef");
  assert.equal(made.status, "running");
  assert.equal(sent[0]?.method, "POST");
  assert.equal(sent[0]?.path, "/v1/sandboxes");
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer key_test");
  assert.match(sent[0]?.headers.get("idempotency-key") ?? "", /^sdk-[0-9a-f]{12}$/);
  const body = sent[0]?.body as { name: string; size: string };
  assert.match(body.name, /^sbx-[0-9a-f]{12}$/);
  assert.equal(body.size, "medium");

  await agental.sandboxes.create({ name: "mine", idempotencyKey: "task-0001" });
  assert.equal(sent[1]?.headers.get("idempotency-key"), "task-0001");
  assert.deepEqual(sent[1]?.body, { name: "mine" });
});

test("every request says which SDK sent it, at the version package.json has", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, version);
  const { agental, sent } = scripted(json(200, { sandboxes: [] }), json(201, sandbox()));
  await agental.sandboxes.list();
  await agental.sandboxes.create({ size: "small" });
  assert.deepEqual(
    sent.map((request) => request.headers.get("user-agent")),
    [`agental-typescript/${version}`, `agental-typescript/${version}`],
  );
});

test("in a browser no User-Agent is set: the browser sends its own", async () => {
  const global = globalThis as { window?: unknown };
  global.window = {};
  try {
    const { agental, sent } = scripted(json(200, { sandboxes: [] }));
    await agental.sandboxes.list();
    assert.equal(sent[0]?.headers.get("user-agent"), null);
  } finally {
    delete global.window;
  }
});

/** What a sandbox on an allowlist template that lets out to 203.0.113.7 is held to, with these addresses of its own. */
function detail(own: string[]): SandboxNetworkDetail {
  return {
    outbound: "allowlist",
    allow: ["203.0.113.7", ...own],
    template: { templateId: "tpl_0000000000000002", name: "coding-agent", outbound: "allowlist", allow: ["203.0.113.7"] },
    own: { allow: own },
  };
}

test("a sandbox is made with addresses of its own, and what it may reach is read and its own addresses replaced by calls of their own", async () => {
  const { agental, sent } = scripted(
    json(201, sandbox({ templateId: "tpl_0000000000000002", network: { outbound: "allowlist", allow: ["203.0.113.7", "192.0.2.99"] } })),
    json(200, detail(["192.0.2.99"])),
    refusal(409, "sandbox_migrating"),
    json(200, detail(["198.51.100.0/24"])),
    json(200, detail([])),
    refusal(400, "rule_on_template"),
    refusal(501, "network_policy_unavailable"),
  );
  // Only its own addresses are sent with a create: the rule is its template's.
  const made = await agental.sandboxes.create({ name: "held", template: "tpl_0000000000000002", network: { allow: ["192.0.2.99"] } });
  assert.deepEqual(sent[0]?.body, { name: "held", templateId: "tpl_0000000000000002", network: { allow: ["192.0.2.99"] } });
  assert.deepEqual(made.info.network, { outbound: "allowlist", allow: ["203.0.113.7", "192.0.2.99"] });

  // What it is held to, and what that comes from.
  assert.deepEqual(await made.network(), detail(["192.0.2.99"]));
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["GET", "/v1/sandboxes/sbx_0123456789abcdef/network", undefined]);

  // Its own addresses are sent, in place of the ones it had. A sandbox that is being moved to another server cannot be
  // told them, and they are sent again once it has been: sending them twice does what sending them once does.
  assert.deepEqual((await made.setNetwork({ allow: ["198.51.100.0/24"] })).own, { allow: ["198.51.100.0/24"] });
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/network", { allow: ["198.51.100.0/24"] }]);
  assert.deepEqual([sent[3]?.method, sent[3]?.body], ["PUT", { allow: ["198.51.100.0/24"] }]);
  // What the sandbox says of itself follows, without another read: the rule it is held to, not what it comes from.
  assert.deepEqual(made.info.network, { outbound: "allowlist", allow: ["203.0.113.7", "198.51.100.0/24"] });

  // An empty list takes them all away, and the template's rule is left.
  assert.deepEqual((await made.setNetwork({ allow: [] })).allow, ["203.0.113.7"]);
  assert.deepEqual(sent[4]?.body, { allow: [] });

  // A rule sent for a sandbox, by code that does not have the types, is refused by the API with where rules are set now.
  await assert.rejects(made.setNetwork({ outbound: "blocked", allow: [] } as { allow: string[] }), (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === "rule_on_template");
  assert.deepEqual(sent[5]?.body, { outbound: "blocked", allow: [] });
  // Where sandboxes are not held to rules the API says so, and what the sandbox says is left as it was.
  await assert.rejects(made.setNetwork({ allow: ["192.0.2.99"] }), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "network_policy_unavailable");
  assert.deepEqual(made.info.network, { outbound: "allowlist", allow: ["203.0.113.7"] });
  assert.equal(sent.length, 7);
});

test("a create that is accepted, cut by a proxy or uncertain is sent again with the same key until the sandbox runs", async () => {
  const { agental, sent } = scripted(
    json(202, { sandbox: sandbox({ status: "creating" }), operation: {} }),
    new Response("<html>gateway timeout</html>", { status: 504 }),
    new TypeError("fetch failed"),
    refusal(503, "uncertain_operation"),
    json(200, sandbox()),
  );
  const made = await agental.sandboxes.create({ name: "agent-1" });
  assert.equal(made.status, "running");
  assert.equal(sent.length, 5);
  assert.equal(new Set(sent.map((request) => request.headers.get("idempotency-key"))).size, 1);
  assert.equal(new Set(sent.map((request) => JSON.stringify(request.body))).size, 1);
});

test("a create that fails for good is thrown with the API's code, and is not sent again", async () => {
  const { agental, sent } = scripted(refusal(409, "name_taken"));
  await assert.rejects(agental.sandboxes.create({ name: "agent-1" }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "name_taken");
    assert.equal(error.message, "name_taken it is");
    return true;
  });
  assert.equal(sent.length, 1);
});

test("a command is a list as given, or a line of shell, and is never sent twice", async () => {
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, { exitCode: 0, stdout: "a\n", stderr: "", truncated: false }),
    json(200, { exitCode: 3, stdout: "", stderr: "no\n", truncated: false }),
    refusal(503, "sandbox_moved"),
    new Response("bad gateway", { status: 502 }),
    new TypeError("fetch failed"),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal((await box.exec(["echo", "a b"])).stdout, "a\n");
  assert.deepEqual(sent[1]?.body, { command: ["echo", "a b"] });
  // One that fails is an answer, not an error.
  assert.equal((await box.exec("cd app && npm test", { timeoutMs: 5000 })).exitCode, 3);
  assert.deepEqual(sent[2]?.body, { command: ["sh", "-c", "cd app && npm test"], timeoutMs: 5000 });

  await assert.rejects(box.exec("make"), (error: unknown) => error instanceof ApiError && error.code === "sandbox_moved");
  await assert.rejects(box.exec("make"), (error: unknown) => error instanceof ProxyError && error.status === 502);
  await assert.rejects(box.exec("make"), ConnectionError);
  assert.equal(sent.length, 6);
});

test("a stop sends no body, and keepMemory when it is asked for, and the sandbox says whether its memory was kept", async () => {
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, sandbox({ status: "stopped", memoryKept: false })),
    json(200, sandbox({ status: "stopped", memoryKept: true })),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  await box.stop();
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["POST", "/v1/sandboxes/sbx_0123456789abcdef/stop", undefined]);
  assert.equal(box.info.memoryKept, false);
  await box.stop({ keepMemory: true });
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["POST", "/v1/sandboxes/sbx_0123456789abcdef/stop", { keepMemory: true }]);
  assert.equal(box.info.memoryKept, true);
});

test("a stop that keeps memory and is answered 202 reads the sandbox until it has stopped", async () => {
  const op = { id: "op_1", type: "stop", status: "pending", sandboxId: "sbx_0123456789abcdef", error: null, createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" };
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(202, sandbox(), { "operation-id": "op_1" }),
    json(200, { operation: op, sandbox: sandbox() }),
    json(200, sandbox({ status: "stopped", memoryKept: true })),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  await box.stop({ keepMemory: true });
  assert.equal(box.info.status, "stopped");
  assert.equal(box.info.memoryKept, true);
  assert.deepEqual(sent.map((one) => [one.method, one.path]), [
    ["GET", "/v1/sandboxes/sbx_0123456789abcdef"],
    ["POST", "/v1/sandboxes/sbx_0123456789abcdef/stop"],
    ["GET", "/v1/operations/op_1"],
    ["GET", "/v1/sandboxes/sbx_0123456789abcdef"],
  ]);
});

test("a request the API turned away as it restarted is sent again, a command too, as nothing was done with it", async () => {
  const { agental, sent } = scripted(
    json(200, sandbox()),
    refusal(503, "restarting"),
    json(200, { exitCode: 0, stdout: "built\n", stderr: "", truncated: false }),
    refusal(503, "restarting"),
    refusal(503, "restarting"),
    refusal(503, "restarting"),
    refusal(503, "restarting"),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal((await box.exec("make")).stdout, "built\n");
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2]?.body, sent[1]?.body);
  // It is sent again as often as any other, and no more.
  await assert.rejects(box.exec("make"), (error: unknown) => error instanceof ApiError && error.code === "restarting");
  assert.equal(sent.length, 7);
});

test("a read is sent again after a move, a proxy or a lost connection, and a file write waits a move out", async () => {
  const { agental, sent } = scripted(
    refusal(503, "sandbox_moved"),
    new Response("bad gateway", { status: 502 }),
    new TypeError("fetch failed"),
    json(200, sandbox()),
    refusal(409, "sandbox_migrating"),
    refusal(409, "sandbox_migrating"),
    json(200, { path: "a.txt", bytes: 2 }),
    json(200, { path: "a.txt", encoding: "text", text: "hi" }),
    json(200, { path: "a.bin", bytes: 3 }),
    json(200, { path: "a.bin", encoding: "base64", base64: "AP8Q" }),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal(sent.length, 4);

  assert.deepEqual(await box.files.write("a.txt", "hi"), { path: "a.txt", bytes: 2 });
  assert.equal(sent.length, 7);
  assert.deepEqual(sent[6]?.body, { path: "a.txt", text: "hi" });
  assert.equal(await box.files.read("a.txt"), "hi");
  assert.equal(sent[7]?.path, "/v1/sandboxes/sbx_0123456789abcdef/files?path=a.txt");

  await box.files.write("a.bin", Uint8Array.of(0, 255, 16));
  assert.deepEqual(sent[8]?.body, { path: "a.bin", base64: "AP8Q" });
  assert.deepEqual([...(await box.files.readBytes("a.bin"))], [0, 255, 16]);
  assert.equal(sent[9]?.path, "/v1/sandboxes/sbx_0123456789abcdef/files?path=a.bin&encoding=base64");
});

test("what is not the API's error is not retried when it is the caller's doing", async () => {
  const { agental, sent } = scripted(new Response("<html>not found</html>", { status: 404 }), refusal(404, "not_found"), refusal(500, "host_error"), refusal(500, "host_error"));
  await assert.rejects(agental.sandboxes.list(), (error: unknown) => error instanceof ProxyError && /baseUrl/.test(error.message));
  await assert.rejects(agental.sandboxes.get("sbx_gone"), (error: unknown) => error instanceof ApiError && error.code === "not_found");
  assert.equal(sent.length, 2);
  // A failing host is tried once more, and no more than that.
  await assert.rejects(agental.limits(), (error: unknown) => error instanceof ApiError && error.code === "host_error");
  assert.equal(sent.length, 4);
});

test("a delete says which sandbox it means", async () => {
  const { agental, sent } = scripted(json(200, sandbox()), new Response(null, { status: 204 }));
  await (await agental.sandboxes.get("sbx_0123456789abcdef")).delete();
  assert.equal(sent[1]?.method, "DELETE");
  assert.equal(sent[1]?.headers.get("x-agental-confirm-delete"), "sbx_0123456789abcdef");
});

test("a start waits for a sandbox that is brought back, and says why one was not", async () => {
  const stopped = sandbox({ status: "stopped", archived: true });
  const { agental, sent } = scripted(
    json(200, stopped),
    json(202, sandbox({ status: "restoring", archived: true })),
    json(200, sandbox({ status: "restoring", archived: true })),
    json(200, sandbox()),
    json(202, sandbox({ status: "restoring" })),
    json(200, sandbox({ status: "stopped", error: "the disk could not be read back" })),
    json(202, sandbox({ status: "restoring" })),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal((await box.start()).status, "running");
  assert.equal(sent.length, 4);
  await assert.rejects(box.start(), (error: unknown) => error instanceof AgentalError && /stopped, not running: the disk could not be read back/.test(error.message));
  assert.equal((await box.start({ wait: false })).status, "restoring");
});

test("an archive is waited for, and one that fails says what its operation says", async () => {
  const { agental } = scripted(
    json(200, sandbox({ status: "stopped" })),
    json(202, sandbox({ status: "stopped" }), { "operation-id": "op_1" }),
    json(200, { operation: { status: "pending", error: null }, sandbox: null }),
    json(200, sandbox({ status: "stopped", archived: true })),
    json(202, sandbox({ status: "stopped" }), { "operation-id": "op_2" }),
    json(200, { operation: { status: "failed", error: "the bucket did not answer" }, sandbox: null }),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal((await box.archive()).info.archived, true);
  box.info = sandbox({ status: "stopped" });
  await assert.rejects(box.archive(), /was not archived: the bucket did not answer/);
});

function stream(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a streamed command gives its output as it arrives, however the events are cut", async () => {
  const { agental } = scripted(
    json(200, sandbox()),
    stream('event: stdout\ndata: {"data":"one\\n"}\n\nevent: std', 'err\r\ndata: {"data":"two"}\r\n\r\nevent: exit\ndata: {"exitCode":7}\n\n'),
    stream('event: stdout\ndata: {"data":"one"}\n\nevent: error\ndata: the sandbox was moved\n\n'),
    stream('event: stdout\ndata: {"data":"one"}\n\n'),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const seen = [];
  for await (const event of box.execStream(["sh", "-c", "echo one; echo two >&2; exit 7"])) {
    seen.push(event);
  }
  assert.deepEqual(seen, [
    { type: "stdout", data: "one\n" },
    { type: "stderr", data: "two" },
    { type: "exit", exitCode: 7 },
  ]);
  const drain = async (): Promise<void> => {
    for await (const event of box.execStream("make")) {
      void event;
    }
  };
  await assert.rejects(drain(), /cut off: the sandbox was moved/);
  await assert.rejects(drain(), ConnectionError);
});

test("a fork, a snapshot and a port ask for what the API needs of them", async () => {
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(201, sandbox({ id: "sbx_fork000000000000", name: "second-try" })),
    json(201, { id: "snap_1", sandboxId: "sbx_0123456789abcdef", name: "before", createdAt: "", browsable: false, size: "small", sandboxDeleted: false }),
    json(200, { sandbox: sandbox({ updatedAt: "later" }), snapshot: { id: "snap_1" }, discarded: ["snap_2"] }),
    json(201, { id: "rt_1", port: 8080, url: "https://abc.agental.site" }),
    json(201, sandbox({ id: "sbx_fromsnap00000000" })),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const fork = await box.fork({ name: "second-try" });
  assert.equal(fork.id, "sbx_fork000000000000");
  assert.equal(sent[1]?.path, "/v1/sandboxes/sbx_0123456789abcdef/fork");
  assert.ok(sent[1]?.headers.get("idempotency-key"));
  assert.deepEqual(sent[1]?.body, { name: "second-try" });

  assert.equal((await box.snapshot("before")).id, "snap_1");
  assert.deepEqual(sent[2]?.body, { name: "before" });
  assert.deepEqual((await box.restore("snap_1")).discarded, ["snap_2"]);
  assert.equal(box.info.updatedAt, "later");

  assert.equal((await box.expose(8080)).url, "https://abc.agental.site");
  assert.deepEqual(sent[4]?.body, { port: 8080, title: "port-8080", public: true });

  await agental.sandboxes.create({ snapshotId: "snap_1" });
  assert.equal((sent[5]?.body as { snapshotId: string }).snapshotId, "snap_1");
});

function stopOf(changes: Partial<SandboxAutoStop> = {}): SandboxAutoStop {
  return { sandboxId: "sbx_0123456789abcdef", status: "running", autoStopAt: "2026-10-13T02:00:00.000Z", secondsLeft: 7200, ttlSeconds: 7200, setBy: "ttl", ...changes };
}

test("a sandbox is made with a time limit, and the stop of its run is read and moved, to a time or by seconds from now", async () => {
  const moved = stopOf({ autoStopAt: "2026-10-13T01:00:00.000Z", secondsLeft: 3600, setBy: "account" });
  const later = stopOf({ autoStopAt: "2026-10-13T05:00:00.000Z", secondsLeft: 18_000, setBy: "account" });
  const { agental, sent } = scripted(
    json(201, sandbox({ ttlSeconds: 7200, autoStopAt: "2026-10-13T02:00:00.000Z" })),
    json(201, sandbox({ id: "sbx_default000000000" })),
    json(200, stopOf()),
    json(200, moved),
    new TypeError("fetch failed"),
    json(200, later),
    refusal(400, "auto_stop_too_soon"),
    refusal(400, "auto_stop_too_far"),
    refusal(409, "invalid_state"),
  );

  // Its time limit as given, null for the deployment's whatever its template says, and left out its template's.
  const box = await agental.sandboxes.create({ name: "timed", ttlSeconds: 7200 });
  assert.deepEqual(sent[0]?.body, { name: "timed", ttlSeconds: 7200 });
  assert.equal(box.info.ttlSeconds, 7200);
  await agental.sandboxes.create({ name: "default-time", ttlSeconds: null });
  assert.deepEqual(sent[1]?.body, { name: "default-time", ttlSeconds: null });

  assert.deepEqual(await box.autoStop(), stopOf());
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["GET", "/v1/sandboxes/sbx_0123456789abcdef/auto-stop", undefined]);

  // Seconds from now, and what the sandbox says of its stop follows without another read.
  assert.deepEqual(await box.setAutoStop({ inSeconds: 3600 }), moved);
  assert.deepEqual([sent[3]?.method, sent[3]?.path, sent[3]?.body], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/auto-stop", { inSeconds: 3600 }]);
  assert.equal(box.info.autoStopAt, "2026-10-13T01:00:00.000Z");

  // A time, a Date here. A move whose answer is lost is sent again: it moves the stop to the same place.
  assert.equal((await box.setAutoStop({ at: new Date("2026-10-13T05:00:00Z") })).setBy, "account");
  assert.deepEqual([sent[4]?.body, sent[5]?.body], [{ at: "2026-10-13T05:00:00.000Z" }, { at: "2026-10-13T05:00:00.000Z" }]);
  assert.equal(box.info.autoStopAt, "2026-10-13T05:00:00.000Z");

  // Too soon, too far, or a sandbox that is not running: each as the API said it, none sent again, and the stop as it was.
  const refused = (status: number, code: string) => (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;
  await assert.rejects(box.setAutoStop({ at: "2026-10-13T00:00:30Z" }), refused(400, "auto_stop_too_soon"));
  assert.deepEqual(sent[6]?.body, { at: "2026-10-13T00:00:30Z" });
  await assert.rejects(box.setAutoStop({ inSeconds: 9_999_999 }), refused(400, "auto_stop_too_far"));
  await assert.rejects(box.setAutoStop({ inSeconds: 3600 }), refused(409, "invalid_state"));
  assert.equal(box.info.autoStopAt, "2026-10-13T05:00:00.000Z");
  assert.equal(sent.length, 9);

  // A time or seconds from now, and a type that holds both is refused before anything is sent.
  // @ts-expect-error at or inSeconds, not both
  const both: Parameters<typeof box.setAutoStop>[0] = { at: "2026-10-13T05:00:00Z", inSeconds: 3600 };
  assert.ok(both);
});

test("a sandbox's time limit is taken away, and what it says of its stop follows", async () => {
  const none = stopOf({ autoStopAt: null, secondsLeft: null, ttlSeconds: null, setBy: null });
  const { agental, sent } = scripted(json(201, sandbox({ ttlSeconds: 7200, autoStopAt: "2026-10-13T02:00:00.000Z" })), json(200, none));
  const box = await agental.sandboxes.create({ name: "timed", ttlSeconds: 7200 });
  assert.deepEqual(await box.clearAutoStop(), none);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["DELETE", "/v1/sandboxes/sbx_0123456789abcdef/auto-stop", undefined]);
  assert.deepEqual([box.info.autoStopAt, box.info.ttlSeconds], [null, null]);
});

const MAIL = "/v1/sandboxes/sbx_0123456789abcdef/email";
const MAIL_DOMAIN = "sbx-0123456789abcdef.k7m2x9qd.agental.email";

function message(changes: Partial<EmailMessageSummary> = {}): EmailMessageSummary {
  return {
    id: "eml_9c41d0a7b2e65f38",
    sandboxId: "sbx_0123456789abcdef",
    direction: "received",
    from: "dana@example.org",
    to: `support@${MAIL_DOMAIN}`,
    subject: "Re: invoice 1042",
    sizeBytes: 512,
    attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 16 }],
    checks: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spamScore: 1.2,
    sentByProgram: false,
    createdAt: "2026-10-14T00:00:00.000Z",
    state: null,
    stateDetail: null,
    ...changes,
  };
}

test("a sandbox's mail is read, turned on and turned off by calls of their own", async () => {
  const off = { enabled: false, enabledAt: null, domain: MAIL_DOMAIN };
  const on = { enabled: true, enabledAt: "2026-10-14T00:00:00.000Z", domain: MAIL_DOMAIN };
  const { agental, sent } = scripted(json(200, sandbox()), json(200, off), new Response("bad gateway", { status: 502 }), json(200, on), json(200, off), refusal(501, "mail_not_configured"));
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");

  assert.deepEqual(await box.email.state(), off);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["GET", MAIL, undefined]);

  // Turning it on twice does what turning it on once does, so it is asked again when a proxy answers in the API's place.
  assert.deepEqual(await box.email.enable(), on);
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["PUT", MAIL, undefined]);
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["PUT", MAIL]);

  assert.deepEqual(await box.email.disable(), off);
  assert.deepEqual([sent[4]?.method, sent[4]?.path, sent[4]?.body], ["DELETE", MAIL, undefined]);

  // Where no mail is offered the API says so, in its own code.
  await assert.rejects(box.email.enable(), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "mail_not_configured");
  assert.equal(sent.length, 6);
});

test("messages are listed a page at a time, walked page by page, read, fetched as they were transmitted, and deleted", async () => {
  const first = message();
  const second = message({ id: "eml_0000000000000002", subject: "older" });
  const third = message({ id: "eml_0000000000000003", subject: "oldest" });
  const full = { ...first, messageIdHeader: "<abc123@example.org>", headers: [{ name: "subject", value: "Re: invoice 1042" }], text: "The invoice is attached.", html: null };
  // Bytes that are no text at all come back as they are.
  const transmitted = Uint8Array.of(70, 114, 111, 109, 58, 32, 255, 0, 13, 10);
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, { messages: [first], nextCursor: "c1" }),
    json(200, { messages: [second], nextCursor: null }),
    json(200, { messages: [first, second], nextCursor: "c2" }),
    json(200, { messages: [third], nextCursor: null }),
    json(200, full),
    new Response(transmitted, { status: 200, headers: { "content-type": "message/rfc822" } }),
    new Response(null, { status: 204 }),
    refusal(404, "not_found"),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");

  const page = await box.email.list();
  assert.deepEqual(page, { messages: [first], nextCursor: "c1" });
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", `${MAIL}/messages`]);
  assert.deepEqual((await box.email.list({ cursor: "c1", limit: 1 })).messages, [second]);
  assert.equal(sent[2]?.path, `${MAIL}/messages?cursor=c1&limit=1`);

  // Every page is asked for in turn, each with the cursor the one before it gave, until one gives none.
  const walked = [];
  for await (const each of box.email.all({ limit: 2 })) {
    walked.push(each.id);
  }
  assert.deepEqual(walked, [first.id, second.id, third.id]);
  assert.equal(sent[3]?.path, `${MAIL}/messages?limit=2`);
  assert.equal(sent[4]?.path, `${MAIL}/messages?cursor=c2&limit=2`);

  assert.deepEqual(await box.email.get(first.id), full);
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["GET", `${MAIL}/messages/${first.id}`]);

  assert.deepEqual([...(await box.email.raw(first.id))], [...transmitted]);
  assert.deepEqual([sent[6]?.method, sent[6]?.path, sent[6]?.headers.get("accept")], ["GET", `${MAIL}/messages/${first.id}/raw`, "message/rfc822"]);

  await box.email.delete(first.id);
  assert.deepEqual([sent[7]?.method, sent[7]?.path], ["DELETE", `${MAIL}/messages/${first.id}`]);
  // A delete is not asked twice: the second answer would be that there is no such message.
  await assert.rejects(box.email.delete(first.id), (error: unknown) => error instanceof ApiError && error.code === "not_found");
  assert.equal(sent.length, 9);
});

test("a message is sent with a key of its own, asked again with it when the answer is lost, and a refusal is not asked again", async () => {
  const taken = message({ id: "eml_00000000000000aa", direction: "sent", from: `reports@${MAIL_DOMAIN}`, to: "ada@example.com", subject: "The build passed", attachments: [], sentByProgram: true, state: "handed_over" });
  const { agental, sent } = scripted(
    json(200, sandbox()),
    new TypeError("fetch failed"),
    json(200, taken),
    json(202, taken),
    refusal(403, "recipient_not_allowed"),
    refusal(409, "mail_off"),
    refusal(429, "mail_limit_reached"),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const attachment = { filename: "log.txt", contentType: "text/plain", contentBase64: "b2sK" };

  const said = await box.email.send({ from: "reports", fromName: "Nightly report", subject: "The build passed", text: "All 812 tests passed.", replyTo: "eml_9c41d0a7b2e65f38", attachments: [attachment] });
  assert.deepEqual(said, taken);
  assert.equal(sent.length, 3);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["POST", `${MAIL}/messages`]);
  // Nobody is named: the message is for the account's own address, which the API knows.
  assert.deepEqual(sent[1]?.body, { from: "reports", fromName: "Nightly report", subject: "The build passed", text: "All 812 tests passed.", replyTo: "eml_9c41d0a7b2e65f38", attachments: [attachment] });
  assert.match(sent[1]?.headers.get("idempotency-key") ?? "", /^sdk-[0-9a-f]{12}$/);
  assert.equal(sent[2]?.headers.get("idempotency-key"), sent[1]?.headers.get("idempotency-key"));
  assert.deepEqual(sent[2]?.body, sent[1]?.body);

  // The caller's own key goes as the header, and is no part of the message.
  await box.email.send({ to: "ada@example.com", subject: "Again", text: "", idempotencyKey: "nightly-2026-10-14" });
  assert.equal(sent[3]?.headers.get("idempotency-key"), "nightly-2026-10-14");
  assert.deepEqual(sent[3]?.body, { to: "ada@example.com", subject: "Again", text: "" });

  await assert.rejects(box.email.send({ to: "stranger@example.org", subject: "Hello", text: "hi" }), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "recipient_not_allowed");
  await assert.rejects(box.email.send({ subject: "Hello", text: "hi" }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "mail_off");
  await assert.rejects(box.email.send({ subject: "Hello", text: "hi" }), (error: unknown) => error instanceof ApiError && error.status === 429 && error.code === "mail_limit_reached");
  assert.equal(sent.length, 7);
});

test("a sandbox's mail is reached by its id without reading the sandbox, and the account's mail is read", async () => {
  const account = {
    handle: "k7m2x9qd",
    domain: "k7m2x9qd.agental.email",
    limits: { receivedPerDay: 1000, receivedBytesPerDay: 1_000_000_000, keptBytes: 5_000_000_000, sentPerHour: 30, sentPerDay: 200, sentBytesPerDay: 1_000_000_000 },
    today: { received: 2, receivedBytes: 1024, sent: 1, sentBytes: 300 },
    keptBytes: 1324,
  };
  const { agental, sent } = scripted(json(200, { messages: [message()], nextCursor: null }), refusal(403, "key_action_forbidden"), json(200, account));
  // A key with email.read and email.send on one sandbox may ask for nothing but that sandbox's mail, so the first
  // request made is for the mail itself.
  const mail = agental.sandboxes.email("sbx_0123456789abcdef");
  assert.equal(sent.length, 0);
  assert.equal((await mail.list()).messages[0]?.subject, "Re: invoice 1042");
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", `${MAIL}/messages`]);
  await assert.rejects(agental.sandboxes.get("sbx_0123456789abcdef"), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "key_action_forbidden");

  assert.deepEqual(await agental.email(), account);
  assert.deepEqual([sent[2]?.method, sent[2]?.path], ["GET", "/v1/email"]);
});

function burst(changes: Partial<Burst> = {}): Burst {
  const quote = (size: BurstQuote["size"], feeMicros = 0): BurstQuote => ({ size, count: 1, feeMicros, freeInSeconds: 0, overRunningCount: false });
  return {
    enforced: true,
    plan: "plan100",
    limitsFrom: "plan",
    limitsPlan: "plan100",
    runningUnits: 100,
    freeBurstUnits: 40,
    runningMb: 8192,
    capMb: 409_600,
    freeMb: 163_840,
    meterMb: 8192,
    freeNowMb: 155_648,
    overMb: 0,
    halfLifeMinutes: 15,
    feeMicrosPerGib: 20_000,
    mayStart: true,
    unpaid: false,
    spentMicros: 0,
    budgetMicros: 50_000_000,
    budgetSet: false,
    defaultBudgetMicros: 50_000_000,
    nextStart: [quote("tiny"), quote("small"), quote("medium")],
    quote: null,
    ...changes,
  };
}

test("the burst is read, with a quote for a size and a count, and its budget is set and cleared", async () => {
  const quoted = burst({ quote: { size: "medium", count: 30, feeMicros: 640_000, freeInSeconds: 1800, overRunningCount: false } });
  const { agental, sent } = scripted(json(200, burst()), json(200, quoted), json(200, burst({ budgetMicros: 0, budgetSet: true })), new TypeError("fetch failed"), json(200, burst()));
  assert.equal((await agental.burst()).quote, null);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/burst"]);
  assert.equal((await agental.burst({ size: "medium", count: 30 })).quote?.feeMicros, 640_000);
  assert.equal(sent[1]?.path, "/v1/burst?size=medium&count=30");

  assert.equal((await agental.setBurstBudget(0)).budgetMicros, 0);
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["PUT", "/v1/burst/budget", { budgetMicros: 0 }]);
  // Setting a budget twice sets it once, so a lost answer is sent again.
  assert.equal((await agental.setBurstBudget(null)).budgetSet, false);
  assert.deepEqual([sent[4]?.method, sent[4]?.body], ["PUT", { budgetMicros: null }]);
});

test("a create, fork and start send the most they may pay, and say what they paid", async () => {
  const { agental, sent } = scripted(
    json(201, sandbox(), { "Agental-Burst-Fee": "32000" }),
    json(201, sandbox({ id: "sbx_fork000000000000" }), { "Agental-Burst-Fee": "0" }),
    json(200, sandbox(), { "Agental-Burst-Fee": "8000" }),
    json(200, sandbox()),
  );
  const made = await agental.sandboxes.create({ maxBurstFeeMicros: 50_000 });
  assert.equal(sent[0]?.headers.get("agental-max-burst-fee"), "50000");
  assert.equal(made.burstFeeMicros, 32_000);

  const fork = await made.fork({ maxBurstFeeMicros: 0 });
  assert.equal(sent[1]?.path, "/v1/sandboxes/sbx_0123456789abcdef/fork");
  assert.equal(sent[1]?.headers.get("agental-max-burst-fee"), "0");
  assert.equal(fork.burstFeeMicros, 0);

  await made.start({ maxBurstFeeMicros: 10_000 });
  assert.equal(sent[2]?.headers.get("agental-max-burst-fee"), "10000");
  assert.equal(made.burstFeeMicros, 8000);
  // Left out, no cap is sent, and an answer without the header says nothing of a fee.
  await made.start();
  assert.equal(sent[3]?.headers.get("agental-max-burst-fee"), null);
  assert.equal(made.burstFeeMicros, null);

  await assert.rejects(agental.sandboxes.create({ maxBurstFeeMicros: 1.5 }), (error: unknown) => error instanceof AgentalError && /whole number/.test(error.message));
  assert.equal(sent.length, 4);
});

function burstRefusal(code: string, feeMicros: number, retryAfterSeconds: number | null): Response {
  const headers: Record<string, string> = retryAfterSeconds === null ? {} : { "Retry-After": String(retryAfterSeconds) };
  return json(429, { error: { code, message: `${code} it is`, feeMicros, retryAfterSeconds } }, headers);
}

test("a start refused for its burst says what it would cost and when it would cost nothing, and is not sent again by itself", async () => {
  const { agental, sent } = scripted(burstRefusal("burst_fee_too_high", 64_000, 240), burstRefusal("running_limit_reached", 0, null));
  await assert.rejects(
    agental.sandboxes.create({ maxBurstFeeMicros: 0 }),
    (error: unknown) => error instanceof ApiError && error.status === 429 && error.code === "burst_fee_too_high" && error.feeMicros === 64_000 && error.retryAfterSeconds === 240,
  );
  await assert.rejects(agental.sandboxes.create(), (error: unknown) => error instanceof ApiError && error.code === "running_limit_reached" && error.retryAfterSeconds === null);
  assert.equal(sent.length, 2);
  // Any other refusal has neither.
  await assert.rejects(scripted(refusal(409, "name_taken")).agental.sandboxes.create(), (error: unknown) => error instanceof ApiError && error.feeMicros === undefined && error.retryAfterSeconds === undefined);
});

test("asked to, a start refused for its burst waits until it would cost nothing and is tried once more", async () => {
  // Each of the three refusals a wait helps, on a create, a fork and a start.
  const { agental, sent } = scripted(
    burstRefusal("burst_fee_too_high", 64_000, 0),
    json(201, sandbox(), { "Agental-Burst-Fee": "0" }),
    burstRefusal("burst_budget_reached", 64_000, 0),
    json(201, sandbox({ id: "sbx_fork000000000000" })),
    burstRefusal("burst_fee_too_high", 8000, 0),
    json(200, sandbox()),
  );
  const made = await agental.sandboxes.create({ maxBurstFeeMicros: 0, maxBurstWaitMs: 60_000, idempotencyKey: "task-0002" });
  assert.equal(made.burstFeeMicros, 0);
  // The second try is the same create, with the same key and cap.
  assert.equal(sent[1]?.headers.get("idempotency-key"), "task-0002");
  assert.equal(sent[1]?.headers.get("agental-max-burst-fee"), "0");
  await made.fork({ maxBurstWaitMs: 60_000 });
  assert.equal(sent[3]?.path, "/v1/sandboxes/sbx_0123456789abcdef/fork");
  await made.start({ maxBurstWaitMs: 60_000 });
  assert.equal(sent[5]?.path, "/v1/sandboxes/sbx_0123456789abcdef/start");
  assert.equal(sent.length, 6);
});

test("a start is not tried again for its burst unless asked, past the wait allowed, more than once, or for the running count", async () => {
  const { agental, sent } = scripted(
    // Not asked.
    burstRefusal("burst_fee_too_high", 64_000, 0),
    // Longer than allowed.
    burstRefusal("burst_fee_too_high", 64_000, 240),
    // Waiting would never do.
    burstRefusal("burst_fee_too_high", 64_000, null),
    // Waiting does not help the running count.
    burstRefusal("running_limit_reached", 0, 0),
    // Once only.
    burstRefusal("burst_budget_reached", 64_000, 0),
    burstRefusal("burst_budget_reached", 64_000, 0),
  );
  await assert.rejects(agental.sandboxes.create(), (error: unknown) => error instanceof ApiError && error.code === "burst_fee_too_high");
  await assert.rejects(agental.sandboxes.create({ maxBurstWaitMs: 60_000 }), (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === 240);
  await assert.rejects(agental.sandboxes.create({ maxBurstWaitMs: 60_000 }), (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === null);
  await assert.rejects(agental.sandboxes.create({ maxBurstWaitMs: 60_000 }), (error: unknown) => error instanceof ApiError && error.code === "running_limit_reached");
  await assert.rejects(agental.sandboxes.create({ maxBurstWaitMs: 60_000 }), (error: unknown) => error instanceof ApiError && error.code === "burst_budget_reached");
  assert.equal(sent.length, 6);
});

test("usage takes one key or several, and reads each day apart and each hour", async () => {
  const usage = {
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-14T00:00:00.000Z",
    seconds: 3600,
    listCostMicros: 18000,
    hours: [{ hour: "2026-10-09T02:00:00.000Z", sandboxes: 2, seconds: 3600, listCostMicros: 18000 }],
  };
  const { agental, sent } = scripted(json(200, usage), json(200, usage));
  const read = await agental.usage({ apiKeyId: ["key_1", "console"] });
  assert.equal(read.hours[0]?.sandboxes, 2);
  assert.equal(new URL(`https://api.test${sent[0]?.path}`).searchParams.get("apiKeyId"), "key_1,console");
  await agental.usage({ apiKeyId: "key_1" });
  assert.equal(new URL(`https://api.test${sent[1]?.path}`).searchParams.get("apiKeyId"), "key_1");
});

function template(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tpl_0000000000000002",
    name: "coding-agent",
    default: false,
    start: { size: "small", snapshotId: null },
    variables: ["API_TOKEN"],
    hidden: [],
    files: [".npmrc"],
    network: { outbound: "open", allow: [] },
    revision: 3,
    sandboxes: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...changes,
  };
}

function reading(changes: Partial<MetricsReading> = {}): MetricsReading {
  return {
    at: "2026-10-14T16:00:00.000Z",
    cpuUtilization: 0.25,
    memoryUsedBytes: 536_870_912,
    memoryTotalBytes: 2_147_483_648,
    diskUsedBytes: 1_073_741_824,
    diskTotalBytes: 10_737_418_240,
    networkReceivedBytesPerSecond: 1200,
    networkSentBytesPerSecond: 300,
    diskReadBytesPerSecond: 0,
    diskWrittenBytesPerSecond: 4096,
    ...changes,
  };
}

test("a sandbox is made from a template, and is put on another", async () => {
  const listed = (): Response => json(200, { templates: [template({ id: "tpl_0000000000000001", name: "default", default: true }), template()] });
  const { agental, sent } = scripted(
    listed(),
    listed(),
    json(201, sandbox({ templateId: "tpl_0000000000000002" })),
    json(200, { sandboxId: "sbx_0123456789abcdef", templateId: "tpl_0000000000000002", name: "coding-agent", default: false, upToDate: false, takenAt: "", variables: [], files: [] }),
    json(200, { sandboxId: "sbx_0123456789abcdef", templateId: "tpl_0000000000000001", name: "default", default: true, upToDate: true, takenAt: "", variables: ["TOKEN"], files: [] }),
  );
  const found = await agental.templates.find("coding-agent");
  assert.ok(found);
  assert.equal(await agental.templates.find("nowhere"), null);
  const made = await agental.sandboxes.create({ name: "on-it", template: found });
  assert.deepEqual(sent.at(-1)?.body, { name: "on-it", templateId: "tpl_0000000000000002" });
  assert.equal(made.info.templateId, "tpl_0000000000000002");

  assert.equal((await made.template()).upToDate, false);
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.path], ["GET", "/v1/sandboxes/sbx_0123456789abcdef/template"]);
  const moved = await made.setTemplate("tpl_0000000000000001");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.body], ["PUT", { templateId: "tpl_0000000000000001" }]);
  assert.deepEqual(moved.variables, ["TOKEN"]);
  assert.equal(made.info.templateId, "tpl_0000000000000001");
});

test("a template's secrets and a sandbox's own are read one at a time, a file by its path in the query", async () => {
  const { agental, sent } = scripted(
    json(201, template()),
    json(200, { names: ["API_TOKEN"] }),
    json(200, { name: "API_TOKEN", value: "s3cret" }),
    json(200, { name: "API_TOKEN", value: "" }),
    new Response(null, { status: 204 }),
    json(200, { paths: [".config/gh/hosts.yml"] }),
    json(200, { path: ".config/gh/hosts.yml", text: "token: x" }),
    json(200, { path: ".config/gh/hosts.yml", text: "token: y" }),
    new Response(null, { status: 204 }),
    json(200, sandbox()),
    json(200, { name: "OWN", value: "mine" }),
  );
  const made = await agental.templates.create("coding-agent");
  assert.deepEqual([sent[0]?.method, sent[0]?.path, sent[0]?.body], ["POST", "/v1/templates", { name: "coding-agent" }]);
  const base = "/v1/templates/tpl_0000000000000002/secrets";
  assert.deepEqual(await made.secrets.variables(), ["API_TOKEN"]);
  assert.equal(await made.secrets.get("API_TOKEN"), "s3cret");
  assert.equal(sent[2]?.path, `${base}/variables/API_TOKEN`);
  await made.secrets.set("API_TOKEN", "");
  assert.deepEqual([sent[3]?.method, sent[3]?.body], ["PUT", { value: "" }]);
  await made.secrets.delete("API_TOKEN");
  assert.deepEqual([sent[4]?.method, sent[4]?.path], ["DELETE", `${base}/variables/API_TOKEN`]);
  assert.deepEqual(await made.secrets.files(), [".config/gh/hosts.yml"]);
  assert.equal(await made.secrets.readFile(".config/gh/hosts.yml"), "token: x");
  assert.equal(sent[6]?.path, `${base}/files?path=.config%2Fgh%2Fhosts.yml`);
  assert.equal(await made.secrets.writeFile("./.config/gh/hosts.yml", "token: y"), ".config/gh/hosts.yml");
  assert.deepEqual(sent[7]?.body, { path: "./.config/gh/hosts.yml", text: "token: y" });
  await made.secrets.deleteFile(".config/gh/hosts.yml");
  assert.deepEqual([sent[8]?.method, sent[8]?.path], ["DELETE", `${base}/files?path=.config%2Fgh%2Fhosts.yml`]);

  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal(await box.secrets.get("OWN"), "mine");
  assert.equal(sent[10]?.path, "/v1/sandboxes/sbx_0123456789abcdef/secrets/variables/OWN");
});

test("a variable is kept out of the sandbox by setting it with hosts, its hosts are changed alone, and its value is never given back", async () => {
  const standIn = "agental_hidden_7hq2xk9mw4rz3st8vn1bq5c0dle6fy2p";
  const kept: HiddenVariable = { name: "GITHUB_TOKEN", hidden: true, hosts: ["api.github.com", "github.com"], standIn };
  const { agental, sent } = scripted(
    json(200, template({ variables: ["API_TOKEN", "GITHUB_TOKEN"], hidden: ["GITHUB_TOKEN"] })),
    new TypeError("fetch failed"),
    json(200, kept),
    json(200, { names: ["API_TOKEN", "GITHUB_TOKEN"], hidden: ["GITHUB_TOKEN"] }),
    json(200, { names: ["API_TOKEN", "GITHUB_TOKEN"], hidden: ["GITHUB_TOKEN"] }),
    json(200, kept),
    json(200, kept),
    json(200, { name: "API_TOKEN", hidden: false, value: "s3cret" }),
    json(200, { ...kept, hosts: ["api.github.com"] }),
    refusal(409, "not_hidden"),
    refusal(400, "invalid_host"),
    refusal(501, "hidden_variables_unavailable"),
    json(200, { name: "GITHUB_TOKEN", hidden: false, value: "ghp_plain" }),
    json(200, sandbox()),
    json(200, { ...kept, name: "OWN" }),
  );
  const made = await agental.templates.get("tpl_0000000000000002");
  assert.deepEqual(made.info.hidden, ["GITHUB_TOKEN"]);
  const base = "/v1/templates/tpl_0000000000000002/secrets";

  // The value goes with its hosts, and what comes back is its stand-in, never the value. One whose answer is lost is
  // sent again: the stand-in stays the same when the value is replaced.
  const set = await made.secrets.set("GITHUB_TOKEN", "ghp_example", { hosts: ["api.github.com", "github.com"] });
  assert.deepEqual(set, kept);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", `${base}/variables/GITHUB_TOKEN`, { value: "ghp_example", hosts: ["api.github.com", "github.com"] }]);
  assert.deepEqual(sent[2]?.body, sent[1]?.body);

  assert.deepEqual(await made.secrets.variables(), ["API_TOKEN", "GITHUB_TOKEN"]);
  assert.deepEqual(await made.secrets.hidden(), ["GITHUB_TOKEN"]);

  // One variable is either of two shapes, and hidden says which.
  const read = await made.secrets.variable("GITHUB_TOKEN");
  assert.ok(read.hidden);
  assert.deepEqual([read.hosts, read.standIn, "value" in read], [["api.github.com", "github.com"], standIn, false]);
  // get() gives a value, and a variable kept out has none to give.
  await assert.rejects(
    made.secrets.get("GITHUB_TOKEN"),
    (error: unknown) => error instanceof AgentalError && !(error instanceof ApiError) && /GITHUB_TOKEN is kept out of the sandbox/.test(error.message),
  );
  const plain = await made.secrets.variable("API_TOKEN");
  assert.equal(plain.hidden ? null : plain.value, "s3cret");

  // Its hosts alone: the value is not sent again.
  assert.deepEqual((await made.secrets.setHosts("GITHUB_TOKEN", ["api.github.com"])).hosts, ["api.github.com"]);
  assert.deepEqual([sent[8]?.method, sent[8]?.path, sent[8]?.body], ["PUT", `${base}/variables/GITHUB_TOKEN/hosts`, { hosts: ["api.github.com"] }]);

  // A plain variable has no hosts to change, a host that cannot be one is refused, and so are hosts where variables
  // cannot be kept out: each as the API said it.
  await assert.rejects(made.secrets.setHosts("API_TOKEN", ["api.github.com"]), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "not_hidden");
  await assert.rejects(made.secrets.set("WIDE", "x", { hosts: ["*.com"] }), (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === "invalid_host");
  await assert.rejects(
    made.secrets.set("GITHUB_TOKEN", "x", { hosts: ["api.github.com"] }),
    (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "hidden_variables_unavailable",
  );

  // Set without hosts it is plain from then on, and its commands read its value.
  assert.deepEqual(await made.secrets.set("GITHUB_TOKEN", "ghp_plain"), { name: "GITHUB_TOKEN", hidden: false, value: "ghp_plain" });
  assert.deepEqual(sent[12]?.body, { value: "ghp_plain" });

  // A sandbox's own the same way.
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  assert.equal((await box.secrets.set("OWN", "mine", { hosts: ["api.github.com"] })).hidden, true);
  assert.deepEqual([sent[14]?.path, sent[14]?.body], ["/v1/sandboxes/sbx_0123456789abcdef/secrets/variables/OWN", { value: "mine", hosts: ["api.github.com"] }]);
  assert.equal(sent.length, 15);
});

test("a template's start, sandboxes and apply ask for what the API needs of them", async () => {
  const { agental, sent } = scripted(
    json(200, template()),
    json(200, { size: "large", snapshotId: "snap_1", ttlSeconds: null }),
    json(200, { sandboxes: [{ id: "sbx_0123456789abcdef", name: "agent-1", status: "running", upToDate: false, takenAt: "", allow: [] }] }),
    json(200, { templateId: "tpl_0000000000000002", revision: 4, applied: ["sbx_0123456789abcdef"], failed: [] }),
    json(200, { templateId: "tpl_0000000000000002", revision: 4, applied: [], failed: [] }),
    refusal(409, "template_in_use"),
  );
  const made = await agental.templates.get("tpl_0000000000000002");
  assert.deepEqual(await made.setStart({ size: "large", snapshotId: "snap_1" }), { size: "large", snapshotId: "snap_1", ttlSeconds: null });
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", "/v1/templates/tpl_0000000000000002/start", { size: "large", snapshotId: "snap_1" }]);
  assert.deepEqual(made.info.start, { size: "large", snapshotId: "snap_1", ttlSeconds: null });
  assert.equal((await made.sandboxes())[0]?.upToDate, false);
  assert.deepEqual((await made.apply(["sbx_0123456789abcdef"])).applied, ["sbx_0123456789abcdef"]);
  assert.deepEqual(sent[3]?.body, { sandboxIds: ["sbx_0123456789abcdef"] });
  await made.apply();
  assert.deepEqual([sent[4]?.path, sent[4]?.body], ["/v1/templates/tpl_0000000000000002/apply", {}]);
  await assert.rejects(made.delete(), (error: unknown) => error instanceof ApiError && error.code === "template_in_use");
});

test("a template's start is sent whole: ttlSeconds when it is given, and not when it is left out", async () => {
  const START = "/v1/templates/tpl_0000000000000002/start";
  const { agental, sent } = scripted(
    json(200, template()),
    json(200, { size: "medium", snapshotId: null, ttlSeconds: 7200 }),
    json(200, { size: "medium", snapshotId: "snap_1", ttlSeconds: null }),
    refusal(400, "ttl_too_long"),
    json(200, { size: "small", snapshotId: null, ttlSeconds: null }),
  );
  const made = await agental.templates.get("tpl_0000000000000002");

  // Given, it is sent, and so is null: the deployment's default.
  assert.deepEqual(await made.setStart({ size: "medium", ttlSeconds: 7200 }), { size: "medium", snapshotId: null, ttlSeconds: 7200 });
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", START, { size: "medium", ttlSeconds: 7200 }]);
  assert.deepEqual(made.info.start, { size: "medium", snapshotId: null, ttlSeconds: 7200 });
  await made.setStart({ size: "medium", snapshotId: "snap_1", ttlSeconds: null });
  assert.deepEqual(sent[2]?.body, { size: "medium", snapshotId: "snap_1", ttlSeconds: null });

  // Over the deployment's ceiling: refused as the API said it, not sent again, and the start as it was.
  await assert.rejects(made.setStart({ size: "medium", ttlSeconds: 2_592_000 }), (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === "ttl_too_long");
  assert.deepEqual(made.info.start, { size: "medium", snapshotId: "snap_1", ttlSeconds: null });

  // Left out, it is not sent, and the API takes the deployment's default.
  assert.deepEqual(await made.setStart({ size: "small" }), { size: "small", snapshotId: null, ttlSeconds: null });
  assert.deepEqual([sent[4]?.method, sent[4]?.body], ["PUT", { size: "small" }]);
  // Nothing is read first.
  assert.deepEqual(sent.slice(1).map((each) => each.method), ["PUT", "PUT", "PUT", "PUT"]);
});

test("a template's outbound rule is read and replaced by calls of its own, and an apply says which sandboxes did not take it", async () => {
  const listed = { outbound: "allowlist" as const, allow: ["203.0.113.7", "198.51.100.0/24"] };
  const { agental, sent } = scripted(
    json(200, template()),
    json(200, { outbound: "open", allow: [] }),
    new TypeError("fetch failed"),
    json(200, listed),
    json(200, { outbound: "blocked", allow: [] }),
    refusal(409, "too_many_addresses"),
    refusal(501, "network_policy_unavailable"),
    json(200, { sandboxes: [{ id: "sbx_0123456789abcdef", name: "agent-1", status: "running", upToDate: false, takenAt: "", allow: ["192.0.2.99"] }] }),
    json(200, { templateId: "tpl_0000000000000002", revision: 5, applied: [], failed: [{ sandboxId: "sbx_0123456789abcdef", error: "the ACL could not be written" }] }),
  );
  const made = await agental.templates.get("tpl_0000000000000002");
  assert.deepEqual(made.info.network, { outbound: "open", allow: [] });
  assert.deepEqual(await made.network(), { outbound: "open", allow: [] });
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["GET", "/v1/templates/tpl_0000000000000002/network", undefined]);

  // The whole rule is sent. One whose answer is lost is sent again: sending the rule it has changes nothing.
  assert.deepEqual(await made.setNetwork(listed), listed);
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["PUT", "/v1/templates/tpl_0000000000000002/network", listed]);
  assert.deepEqual([sent[3]?.method, sent[3]?.body], ["PUT", listed]);
  // What the template says of itself follows, without another read.
  assert.deepEqual(made.info.network, listed);
  assert.deepEqual(await made.setNetwork({ outbound: "blocked" }), { outbound: "blocked", allow: [] });
  assert.deepEqual(sent[4]?.body, { outbound: "blocked" });

  // A rule that comes to too many addresses with a sandbox's own, and one asked for where sandboxes are not held to
  // rules, are said as the API said them, and the template says what it said before.
  await assert.rejects(made.setNetwork(listed), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "too_many_addresses");
  await assert.rejects(made.setNetwork(listed), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "network_policy_unavailable");
  assert.deepEqual(made.info.network, { outbound: "blocked", allow: [] });

  // Each sandbox on it with its own addresses, and an apply that names the ones whose server did not take the rule.
  assert.deepEqual((await made.sandboxes())[0]?.allow, ["192.0.2.99"]);
  const applied = await made.apply();
  assert.deepEqual(applied.applied, []);
  assert.deepEqual(applied.failed, [{ sandboxId: "sbx_0123456789abcdef", error: "the ACL could not be written" }]);
  assert.equal(sent.length, 9);
});

test("a sandbox's readings, every sandbox's at one moment and how many were running are asked for with what was given", async () => {
  const read: SandboxMetrics = {
    sandboxId: "sbx_0123456789abcdef",
    since: "2026-10-14T15:00:00.000Z",
    until: "2026-10-14T16:00:00.000Z",
    stepSeconds: 60,
    keptDays: 15,
    points: [reading({ cpuUtilization: null })],
    complete: false,
  };
  const moment: MetricsAtMoment = {
    at: "2026-10-14T09:35:00.000Z",
    sandboxes: [
      { sandboxId: "sbx_0123456789abcdef", name: "agent-1", size: "small", reading: reading() },
      { sandboxId: "sbx_stopped000000000", name: "agent-2", size: "medium", reading: null },
    ],
    complete: false,
  };
  const counted: RunningOverTime = { since: "2026-10-13T16:00:00.000Z", until: "2026-10-14T16:00:00.000Z", stepSeconds: 300, points: [{ at: "2026-10-14T16:00:00.000Z", running: 2 }] };
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, read),
    json(200, read),
    json(200, moment),
    json(200, moment),
    json(200, counted),
    json(200, counted),
    refusal(501, "metrics_unavailable"),
    refusal(501, "metrics_unavailable"),
    refusal(503, "metrics_unreadable"),
    refusal(400, "invalid_request"),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");

  // With nothing given nothing is asked for, and the API reads the stretch it reads by itself.
  assert.deepEqual(await box.metrics(), read);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", "/v1/sandboxes/sbx_0123456789abcdef/metrics"]);
  // A Date is sent as the moment it is, and a string as it was given.
  const some = await box.metrics({ since: new Date("2026-10-14T15:00:00Z"), until: "2026-10-14T16:00:00+00:00", stepSeconds: 60 });
  assert.equal(sent[2]?.path, "/v1/sandboxes/sbx_0123456789abcdef/metrics?since=2026-10-14T15%3A00%3A00.000Z&until=2026-10-14T16%3A00%3A00%2B00%3A00&stepSeconds=60");
  // A figure the server did not have is null, and a server that did not answer is said as the API said it.
  assert.equal(some.points[0]?.cpuUtilization, null);
  assert.equal(some.points[0]?.memoryUsedBytes, 536_870_912);
  assert.equal(some.complete, false);

  const now = await agental.metrics();
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["GET", "/v1/metrics"]);
  assert.equal(now.sandboxes[0]?.reading?.cpuUtilization, 0.25);
  // A sandbox that was stopped then has no reading.
  assert.equal(now.sandboxes[1]?.reading, null);
  assert.equal(now.complete, false);
  await agental.metrics({ at: new Date("2026-10-14T09:35:00Z") });
  assert.equal(sent[4]?.path, "/v1/metrics?at=2026-10-14T09%3A35%3A00.000Z");

  assert.deepEqual(await agental.runningOverTime(), counted);
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["GET", "/v1/metrics/running"]);
  await agental.runningOverTime({ since: "2026-10-13T16:00:00Z", until: new Date("2026-10-14T16:00:00Z"), stepSeconds: 300 });
  assert.equal(sent[6]?.path, "/v1/metrics/running?since=2026-10-13T16%3A00%3A00Z&until=2026-10-14T16%3A00%3A00.000Z&stepSeconds=300");

  // Where sandboxes are not read the API says so. Servers that did not answer are not asked again by the SDK.
  await assert.rejects(box.metrics(), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "metrics_unavailable");
  await assert.rejects(agental.metrics(), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "metrics_unavailable");
  await assert.rejects(box.metrics(), (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "metrics_unreadable");
  assert.equal(sent.length, 10);
  await assert.rejects(agental.runningOverTime({ since: "2026-10-14T16:00:00Z", until: "2026-10-14T15:00:00Z" }), (error: unknown) => error instanceof ApiError && error.status === 400);
});

function collector(changes: Partial<Telemetry> = {}): Telemetry {
  return {
    endpoint: "https://otlp.example.com",
    headers: ["x-key"],
    lastExportAt: null,
    lastError: null,
    createdAt: "2026-10-14T09:00:00.000Z",
    updatedAt: "2026-10-14T09:00:00.000Z",
    ...changes,
  };
}

test("a collector is read, set, tried and removed by calls of their own", async () => {
  const failed = collector({ lastExportAt: "2026-10-14T09:01:00.000Z", lastError: { message: "The collector answered 403.", status: 403, at: "2026-10-14T09:02:00.000Z" } });
  const tried: TelemetryTest = { ok: false, status: 401, message: "The collector answered 401." };
  const { agental, sent } = scripted(
    json(200, { telemetry: null }),
    json(200, { telemetry: collector() }),
    new TypeError("fetch failed"),
    json(200, { telemetry: collector({ headers: [] }) }),
    json(200, { telemetry: failed }),
    json(200, tried),
    new TypeError("fetch failed"),
    new Response(null, { status: 204 }),
    refusal(404, "not_found"),
    refusal(501, "telemetry_unavailable"),
  );

  // None is set at first.
  assert.equal(await agental.getTelemetry(), null);
  assert.deepEqual([sent[0]?.method, sent[0]?.path, sent[0]?.body], ["GET", "/v1/telemetry", undefined]);

  // The headers' values are sent, and only their names come back.
  assert.deepEqual(await agental.setTelemetry({ endpoint: "https://otlp.example.com", headers: { "x-key": "secret" } }), collector());
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", "/v1/telemetry", { endpoint: "https://otlp.example.com", headers: { "x-key": "secret" } }]);
  // Without headers none are sent. A set whose answer is lost is sent again: setting a collector twice does what
  // setting it once does.
  assert.deepEqual((await agental.setTelemetry({ endpoint: "https://otlp.example.com" })).headers, []);
  assert.deepEqual([sent[2]?.method, sent[2]?.body, sent[3]?.body], ["PUT", { endpoint: "https://otlp.example.com" }, { endpoint: "https://otlp.example.com" }]);

  // How the last export went is said as the API said it.
  const read = await agental.getTelemetry();
  assert.equal(read?.lastExportAt, "2026-10-14T09:01:00.000Z");
  assert.deepEqual(read?.lastError, { message: "The collector answered 403.", status: 403, at: "2026-10-14T09:02:00.000Z" });

  // A try sends nothing of the caller's, and a collector that refused it is an answer, not an error.
  assert.deepEqual(await agental.testTelemetry(), tried);
  assert.deepEqual([sent[5]?.method, sent[5]?.path, sent[5]?.body], ["POST", "/v1/telemetry/test", undefined]);
  // One whose answer is lost is not sent again, because each try sends the collector an export.
  await assert.rejects(agental.testTelemetry(), ConnectionError);
  assert.equal(sent.length, 7);

  await agental.deleteTelemetry();
  assert.deepEqual([sent[7]?.method, sent[7]?.path, sent[7]?.body], ["DELETE", "/v1/telemetry", undefined]);
  // When none is set there is nothing to remove, and the API says so.
  await assert.rejects(agental.deleteTelemetry(), (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === "not_found");
  // Where nothing is sent to a collector the API says that too.
  await assert.rejects(agental.getTelemetry(), (error: unknown) => error instanceof ApiError && error.status === 501 && error.code === "telemetry_unavailable");
  assert.equal(sent.length, 10);
});

test("billing is read, and a top-up or a plan is bought by the checkout call, which is never sent twice", async () => {
  const standing: Billing = {
    provider: "stripe",
    testMode: true,
    enforced: true,
    needsPlan: false,
    autoReload: null,
    canAutoReload: true,
    status: "active",
    plan: { id: "plan500", dollarsPerMonth: 500, includedMicros: 500_000_000, runningUnits: 1000, freeBurstUnits: 400, sizes: ["tiny", "small", "medium", "large"] },
    period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
    free: null,
    includedMicros: 500_000_000,
    usedMicros: 2_000_000_000,
    mailMicros: 0,
    topUpMicros: 215_000_000,
    cancelAtPeriodEnd: false,
    canRun: true,
    reason: null,
    lapse: null,
    stoppedMicros: 0,
    snapshotMicros: 0,
    burstMicros: 0,
    carriedMicros: 0,
  };
  const prices = {
    topUps: [{ id: "topup500", dollars: 500, micros: 537_000_000, bonusMicros: 37_000_000, bonusPercent: 7.4 }],
    topUpRange: { minDollars: 15, maxDollars: 100_000 },
    topUpBonus: { fromDollars: 200, fromPercent: 2, toDollars: 10_000, toPercent: 25 },
    // Retired, and still sent by the API: the client does not model it.
    volumeDiscount: [{ fromMicros: 0, percent: 0 }],
  };
  // The API still sends the retired discount and sandboxesAtOnce, and the plan's burst in the shape tiers had.
  const sentBilling = {
    ...standing,
    plan: { ...standing.plan, sandboxesAtOnce: 1000, burst: { tier: 2, perQuarterMb: 65_536, perHourMb: 196_608 } },
    discount: { micros: 0, percent: 0, next: null },
    sandboxesAtOnce: 1000,
  };
  const { agental, sent } = scripted(
    json(200, prices),
    json(200, sentBilling),
    json(200, { url: "https://pay.example/topup777", changed: false }),
    new TypeError("fetch failed"),
    json(200, { url: null, changed: true }),
  );

  const read = await agental.prices();
  assert.deepEqual([read.topUps, read.topUpRange, read.topUpBonus], [prices.topUps, prices.topUpRange, prices.topUpBonus]);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/billing/plans"]);
  const billing = await agental.billing();
  assert.deepEqual([billing.plan?.runningUnits, billing.topUpMicros, billing.usedMicros], [1000, standing.topUpMicros, standing.usedMicros]);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", "/v1/billing"]);

  assert.deepEqual(await agental.checkout({ topUp: 777 }), { url: "https://pay.example/topup777", changed: false });
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["POST", "/v1/billing/checkout", { topUp: 777 }]);
  // A checkout whose answer is lost is not sent again: a plan change is made at once.
  await assert.rejects(agental.checkout({ plan: "plan100" }), ConnectionError);
  assert.equal(sent.length, 4);
  assert.deepEqual(await agental.checkout({ plan: "plan100" }), { url: null, changed: true });
});

test("on the free plan, billing says whether a card is saved, and the checkout call saves one", async () => {
  const standing: Billing = {
    provider: "stripe",
    testMode: true,
    enforced: true,
    needsPlan: true,
    autoReload: null,
    canAutoReload: false,
    status: "none",
    plan: { id: "free", dollarsPerMonth: 0, includedMicros: 0, runningUnits: 20, freeBurstUnits: 20, sizes: ["tiny", "small"] },
    period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
    free: { cardSaved: false, paid: false, unpaidUnits: 2 },
    includedMicros: 0,
    usedMicros: 0,
    mailMicros: 0,
    topUpMicros: 0,
    cancelAtPeriodEnd: false,
    canRun: false,
    reason: "billing_required",
    lapse: null,
    stoppedMicros: 0,
    snapshotMicros: 0,
    burstMicros: 0,
    carriedMicros: 0,
  };
  const { agental, sent } = scripted(json(200, standing), json(200, { url: "https://pay.example/card", changed: false }), refusal(409, "card_saved"));
  const billing = await agental.billing();
  assert.deepEqual([billing.plan?.id, billing.free, billing.needsPlan, billing.reason], ["free", { cardSaved: false, paid: false, unpaidUnits: 2 }, true, "billing_required"]);
  assert.deepEqual(await agental.checkout({ card: true }), { url: "https://pay.example/card", changed: false });
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["POST", "/v1/billing/checkout", { card: true }]);
  await assert.rejects(agental.checkout({ card: true }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "card_saved");
});

test("the auto-reload is set and turned off by one call, which sends the dollars or null", async () => {
  const { agental, sent } = scripted(json(200, { autoReload: { dollars: 50 } }), json(200, { autoReload: null }));
  assert.deepEqual(await agental.setAutoReload(50), { autoReload: { dollars: 50 } });
  assert.deepEqual([sent[0]?.method, sent[0]?.path, sent[0]?.body], ["PUT", "/v1/billing/auto-reload", { dollars: 50 }]);
  assert.deepEqual(await agental.setAutoReload(null), { autoReload: null });
  assert.deepEqual(sent[1]?.body, { dollars: null });
});

test("a desktop is turned on with the screen it is given, read and turned off, each by the call the API has for it", async () => {
  const on = { enabled: true, enabledAt: "2026-10-14T08:00:00.000Z", running: true, width: 1280, height: 800, display: ":0", url: "https://3f9c2a17b8d04e6a51c0.agental.site/vnc.html?autoconnect=1&resize=scale&reconnect=1" };
  const off = { enabled: false, enabledAt: null, running: false, width: null, height: null, display: null, url: null };
  const { agental, sent } = scripted(json(200, sandbox()), json(200, on), json(200, { ...on, width: 1920, height: 1080 }), json(200, on), json(200, off), refusal(409, "desktop_unavailable"));
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");

  // With no size, no body is sent, and the API gives the screen the size it has or a new one's.
  assert.equal((await box.desktop.on()).url, on.url);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/desktop", undefined]);
  assert.equal((await box.desktop.on({ width: 1920, height: 1080 })).width, 1920);
  assert.deepEqual([sent[2]?.method, sent[2]?.body], ["PUT", { width: 1920, height: 1080 }]);

  assert.equal((await box.desktop.get()).display, ":0");
  assert.equal(sent[3]?.method, "GET");
  assert.equal((await box.desktop.off()).enabled, false);
  assert.equal(sent[4]?.method, "DELETE");

  // A machine that has no desktop is said as the API said it.
  await assert.rejects(() => box.desktop.on(), (error: unknown) => error instanceof ApiError && error.code === "desktop_unavailable");
});

test("a browser is turned on with or without a window, read and turned off, each by the call the API has for it", async () => {
  const on = { enabled: true, enabledAt: "2026-10-14T08:00:00.000Z", running: true, headless: true, cdpUrl: "wss://3f9c2a17b8d04e6a51c0.agental.site/devtools/browser", localCdpUrl: "http://127.0.0.1:9222" };
  const off = { enabled: false, enabledAt: null, running: false, headless: null, cdpUrl: null, localCdpUrl: null };
  const { agental, sent } = scripted(json(200, sandbox()), json(200, on), json(200, { ...on, headless: false }), json(200, on), json(200, off), refusal(409, "desktop_not_running"));
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");

  // With nothing said, no body is sent, and the API says whether Chrome has a window.
  assert.equal((await box.browser.on()).cdpUrl, on.cdpUrl);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/browser", undefined]);
  assert.equal((await box.browser.on({ headless: false })).headless, false);
  assert.deepEqual([sent[2]?.method, sent[2]?.body], ["PUT", { headless: false }]);

  assert.equal((await box.browser.get()).localCdpUrl, "http://127.0.0.1:9222");
  assert.equal(sent[3]?.method, "GET");
  assert.equal((await box.browser.off()).enabled, false);
  assert.equal(sent[4]?.method, "DELETE");

  // A browser that cannot be on the desktop is said as the API said it.
  await assert.rejects(() => box.browser.on({ headless: false }), (error: unknown) => error instanceof ApiError && error.code === "desktop_not_running");
});

test("the screen is pictured as bytes, and the pointer and the keyboard are each used by one call that is never sent twice", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const done = (): Response => new Response(null, { status: 204 });
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, { mediaType: "image/png", width: 1280, height: 800, base64: Buffer.from(png).toString("base64") }),
    done(),
    done(),
    done(),
    done(),
    done(),
    done(),
    done(),
    new Response("<html>bad gateway</html>", { status: 502 }),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const at = "/v1/sandboxes/sbx_0123456789abcdef/desktop";

  assert.deepEqual(await box.desktop.screenshot(), png);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", `${at}/screenshot?encoding=base64`]);

  await box.desktop.click(640, 400);
  await box.desktop.click(640, 400, { button: "right", count: 2 });
  await box.desktop.move(0, 799);
  await box.desktop.drag({ x: 10, y: 20 }, { x: 300, y: 400 });
  await box.desktop.scroll(640, 400, { dy: -3 });
  await box.desktop.type("hello, world");
  await box.desktop.key("ctrl+l");
  assert.deepEqual(
    sent.slice(2).map((call) => [call.method, call.path.slice(at.length), call.body]),
    [
      ["POST", "/click", { x: 640, y: 400 }],
      ["POST", "/click", { x: 640, y: 400, button: "right", count: 2 }],
      ["POST", "/move", { x: 0, y: 799 }],
      ["POST", "/drag", { from: { x: 10, y: 20 }, to: { x: 300, y: 400 } }],
      ["POST", "/scroll", { x: 640, y: 400, dy: -3 }],
      ["POST", "/type", { text: "hello, world" }],
      ["POST", "/key", { keys: "ctrl+l" }],
    ],
  );

  // A click a proxy cut off may have been made, so it is not made again: the error is the caller's to go by.
  await assert.rejects(() => box.desktop.click(1, 1), ProxyError);
  assert.equal(sent.length, 10);
});

test("a picture of the screen is asked for as the options say, the clipboard is read and written, and links are made, listed and taken away", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const shot = { mediaType: "image/jpeg", width: 320, height: 200, region: { x: 100, y: 50, width: 640, height: 400 }, base64: Buffer.from(jpeg).toString("base64") };
  const link = { id: "dln_4f1c2a9b0d3e7c55", access: "view", url: "https://8c41e07d2b9f6a1355de.routes.test/vnc.html?autoconnect=1&resize=scale&reconnect=1&view_only=1", createdAt: "2026-10-14T10:00:00.000Z", expiresAt: "2026-10-14T10:10:00.000Z", cutOnExpiry: true };
  const done = (): Response => new Response(null, { status: 204 });
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, shot),
    json(200, shot),
    json(200, { text: "copied — 世界" }),
    done(),
    json(201, link),
    json(200, { links: [link] }),
    done(),
    new Response("<html>bad gateway</html>", { status: 502 }),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const at = "/v1/sandboxes/sbx_0123456789abcdef/desktop";

  const options = { format: "jpeg", quality: 60, region: { x: 100, y: 50, width: 640, height: 400 }, scale: 0.5, cursor: false } as const;
  assert.deepEqual(await box.desktop.screenshot(options), jpeg);
  const asked = new URL(sent[1]?.path ?? "", "https://agental.test");
  assert.equal(asked.pathname, `${at}/screenshot`);
  assert.deepEqual(Object.fromEntries(asked.searchParams), { encoding: "base64", format: "jpeg", quality: "60", scale: "0.5", cursor: "false", x: "100", y: "50", width: "640", height: "400" });
  // With what the picture is of, for a caller that maps a point of it back to the screen.
  assert.deepEqual(await box.desktop.screenshotBase64(options), shot);

  assert.equal(await box.desktop.clipboard(), "copied — 世界");
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["GET", `${at}/clipboard`]);
  await box.desktop.setClipboard("a long text");
  assert.deepEqual([sent[4]?.method, sent[4]?.path, sent[4]?.body], ["PUT", `${at}/clipboard`, { text: "a long text" }]);

  assert.deepEqual(await box.desktop.createLink({ access: "view" }), link);
  assert.deepEqual([sent[5]?.method, sent[5]?.path, sent[5]?.body], ["POST", `${at}/links`, { access: "view" }]);
  assert.deepEqual(await box.desktop.links(), [link]);
  await box.desktop.deleteLink(link.id);
  assert.deepEqual([sent[7]?.method, sent[7]?.path], ["DELETE", `${at}/links/${link.id}`]);

  // A link a proxy cut off may have been made, so it is not made again: the error is the caller's to go by.
  await assert.rejects(() => box.desktop.createLink({ access: "control", expiresIn: 3600, cutOnExpiry: false }), ProxyError);
  assert.deepEqual(sent[8]?.body, { access: "control", expiresIn: 3600, cutOnExpiry: false });
  assert.equal(sent.length, 9);
});

/** Runs with these environment variables set, or unset where undefined, and puts back what was there. */
async function withEnvironment(changes: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> {
  const kept = Object.fromEntries(Object.keys(changes).map((name) => [name, process.env[name]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  set(changes);
  try {
    await run();
  } finally {
    set(kept);
  }
}

test("a client with no key says where one comes from", async () => {
  const nowhere = mkdtempSync(path.join(os.tmpdir(), "agental-sdk-"));
  try {
    await withEnvironment({ AGENTAL_API_KEY: undefined, AGENTAL_API_URL: undefined, XDG_CONFIG_HOME: nowhere }, () => {
      assert.throws(() => new Agental(), /AGENTAL_API_KEY.*npx agental@latest/);
      process.env["AGENTAL_API_KEY"] = "key_from_env";
      assert.doesNotThrow(() => new Agental());
    });
  } finally {
    rmSync(nowhere, { recursive: true, force: true });
  }
});

test("with no key given, a client uses the one the agental command signed in with, for that API alone", async () => {
  const config = mkdtempSync(path.join(os.tmpdir(), "agental-sdk-"));
  mkdirSync(path.join(config, "agental"));
  writeFileSync(path.join(config, "agental", "credentials.json"), JSON.stringify({ apiUrl: "http://127.0.0.1:8742", apiKey: "ag_signed_in_here" }));
  const asked: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ sandboxes: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    await withEnvironment({ AGENTAL_API_KEY: undefined, AGENTAL_API_URL: undefined, XDG_CONFIG_HOME: config }, async () => {
      await new Agental({ fetch }).sandboxes.list();
      assert.deepEqual(asked.at(-1), { url: "http://127.0.0.1:8742/v1/sandboxes?limit=200", authorization: "Bearer ag_signed_in_here" });

      // A key given is the one used, at agental.io unless the API is named too.
      await new Agental({ fetch, apiKey: "ag_given" }).sandboxes.list();
      assert.deepEqual(asked.at(-1), { url: "https://agental.io/v1/sandboxes?limit=200", authorization: "Bearer ag_given" });

      // The kept key goes to its own API and no other.
      process.env["AGENTAL_API_URL"] = "https://other.example";
      assert.throws(() => new Agental({ fetch }), /No API key/);
    });
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("a webhook is taken for agental's only with the signature its secret gives its body", async () => {
  const body = JSON.stringify({ event: "sandbox.stopped", data: { id: "sbx_1" } });
  const signature = `sha256=${createHmac("sha256", "whsec_1").update(body).digest("hex")}`;
  assert.equal(await verifyWebhook(body, signature, "whsec_1"), true);
  assert.equal(await verifyWebhook(new TextEncoder().encode(body), signature, "whsec_1"), true);
  assert.equal(await verifyWebhook(`${body} `, signature, "whsec_1"), false);
  assert.equal(await verifyWebhook(body, signature, "whsec_2"), false);
  assert.equal(await verifyWebhook(body, signature.replace("sha256=", ""), "whsec_1"), false);
  assert.equal(await verifyWebhook(body, null, "whsec_1"), false);
});

function hook(changes: Partial<Webhook> = {}): Webhook {
  return {
    id: "wh_5b0e1d7c93a24f68",
    url: "https://example.com/hooks/agental",
    events: ["sandbox.stopped"],
    description: "build bot",
    createdAt: "2026-10-15T09:00:00.000Z",
    updatedAt: "2026-10-15T09:00:00.000Z",
    deliveries: [],
    ...changes,
  };
}

test("webhooks are listed, added, read, changed, given a new secret and deleted by calls of their own", async () => {
  const { agental, sent } = scripted(
    json(200, { webhooks: [hook()] }),
    json(201, hook({ signingSecret: "whsec_one" })),
    json(200, hook()),
    json(200, hook({ events: ["*"] })),
    json(200, hook({ signingSecret: "whsec_two" })),
    new Response(null, { status: 204 }),
  );

  assert.deepEqual(await agental.listWebhooks(), [hook()]);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/webhooks"]);

  // The secret is in the answer to the create, the one time it is given.
  const made = await agental.createWebhook({ url: "https://example.com/hooks/agental", events: ["sandbox.stopped"], description: "build bot" });
  assert.equal(made.signingSecret, "whsec_one");
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["POST", "/v1/webhooks", { url: "https://example.com/hooks/agental", events: ["sandbox.stopped"], description: "build bot" }]);

  assert.deepEqual(await agental.getWebhook("wh_5b0e1d7c93a24f68"), hook());
  assert.deepEqual([sent[2]?.method, sent[2]?.path], ["GET", "/v1/webhooks/wh_5b0e1d7c93a24f68"]);

  // Only what is changed is sent.
  assert.deepEqual((await agental.updateWebhook("wh_5b0e1d7c93a24f68", { events: ["*"] })).events, ["*"]);
  assert.deepEqual([sent[3]?.method, sent[3]?.path, sent[3]?.body], ["PATCH", "/v1/webhooks/wh_5b0e1d7c93a24f68", { events: ["*"] }]);

  assert.equal((await agental.rotateWebhookSecret("wh_5b0e1d7c93a24f68")).signingSecret, "whsec_two");
  assert.deepEqual([sent[4]?.method, sent[4]?.path], ["POST", "/v1/webhooks/wh_5b0e1d7c93a24f68/rotate"]);

  await agental.deleteWebhook("wh_5b0e1d7c93a24f68");
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["DELETE", "/v1/webhooks/wh_5b0e1d7c93a24f68"]);
  assert.equal(sent.length, 6);
});

function apiKey(changes: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key_38b536dc2eabdb52",
    name: "ci-github",
    prefix: "ag_1f2e3d4c5",
    createdAt: "2026-10-16T09:00:00.000Z",
    seesAll: false,
    preset: "ci",
    actions: ["sandbox.read", "sandbox.create", "exec"],
    sandboxIds: [],
    templateIds: ["tpl_coding_agent"],
    expiresAt: null,
    allowFrom: ["203.0.113.0/24"],
    lastUsedAt: null,
    lastUsedFrom: null,
    organizationId: "org_5f0c2a9e1b7d3c46",
    createdBy: "usr_ada",
    ...changes,
  };
}

test("API keys are listed, made, read, given new addresses, counted and deleted by calls of their own", async () => {
  const keyUsage: ApiKeyUsage = {
    apiKeyId: "key_38b536dc2eabdb52",
    createdAt: "2026-10-16T09:00:00.000Z",
    ageMs: 3_600_000,
    since: "2026-10-16T00:00:00.000Z",
    until: "2026-10-16T10:00:00.000Z",
    sandboxes: 2,
    seconds: 1800,
    listCostMicros: 9000,
    currency: "usd",
    cost: null,
    billing: "not_configured",
  };
  const { agental, sent } = scripted(
    json(200, { apiKeys: [apiKey()] }),
    json(201, { ...apiKey(), secret: "ag_1f2e3d4c5b6a" }),
    json(201, { ...apiKey({ preset: null, actions: ["email.read", "email.send"], sandboxIds: ["sbx_0123456789abcdef"], templateIds: [], expiresAt: "2026-11-15T00:00:00.000Z" }), secret: "ag_9e8d7c6b5a4f" }),
    json(200, apiKey()),
    json(200, apiKey({ allowFrom: [] })),
    json(200, keyUsage),
    new Response(null, { status: 204 }),
  );

  assert.deepEqual(await agental.apiKeys.list(), [apiKey()]);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/api-keys"]);

  // The secret is in the answer to the create, the one time it is given, and only what was given is sent.
  const made = await agental.apiKeys.create({ name: "ci-github", preset: "ci", templateIds: ["tpl_coding_agent"], allowFrom: ["203.0.113.0/24"] });
  assert.equal(made.secret, "ag_1f2e3d4c5b6a");
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["POST", "/v1/api-keys", { name: "ci-github", preset: "ci", templateIds: ["tpl_coding_agent"], allowFrom: ["203.0.113.0/24"] }]);
  // A create is never sent again by itself: a second one would be a second key.
  assert.equal(sent[1]?.headers.get("idempotency-key"), null);

  // The actions named in place of a preset, and a Date for when it stops working.
  const mailOnly = await agental.apiKeys.create({
    name: "mail-agent",
    actions: ["email.read", "email.send"],
    sandboxIds: ["sbx_0123456789abcdef"],
    expiresAt: new Date("2026-11-15T00:00:00Z"),
  });
  assert.deepEqual(mailOnly.actions, ["email.read", "email.send"]);
  assert.deepEqual(sent[2]?.body, { name: "mail-agent", actions: ["email.read", "email.send"], sandboxIds: ["sbx_0123456789abcdef"], expiresAt: "2026-11-15T00:00:00.000Z" });

  assert.deepEqual(await agental.apiKeys.get("key_38b536dc2eabdb52"), apiKey());
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["GET", "/v1/api-keys/key_38b536dc2eabdb52"]);

  // An empty list is anywhere.
  assert.deepEqual((await agental.apiKeys.setAllowFrom("key_38b536dc2eabdb52", [])).allowFrom, []);
  assert.deepEqual([sent[4]?.method, sent[4]?.path, sent[4]?.body], ["PUT", "/v1/api-keys/key_38b536dc2eabdb52/allow-from", { allowFrom: [] }]);

  assert.deepEqual(await agental.apiKeys.usage("key_38b536dc2eabdb52", { since: new Date("2026-10-16T00:00:00Z") }), keyUsage);
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["GET", "/v1/api-keys/key_38b536dc2eabdb52/usage?since=2026-10-16T00%3A00%3A00.000Z"]);

  await agental.apiKeys.delete("key_38b536dc2eabdb52");
  assert.deepEqual([sent[6]?.method, sent[6]?.path], ["DELETE", "/v1/api-keys/key_38b536dc2eabdb52"]);
  assert.equal(sent.length, 7);
});

test("a key's refusals come with the API's codes, and none is sent again", async () => {
  const { agental, sent } = scripted(
    refusal(401, "key_expired"),
    refusal(403, "key_address_forbidden"),
    refusal(403, "key_exceeds_caller"),
    refusal(400, "template_required"),
  );
  const refused = (status: number, code: string) => (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;
  await assert.rejects(agental.apiKeys.list(), refused(401, "key_expired"));
  await assert.rejects(agental.apiKeys.get("key_38b536dc2eabdb52"), refused(403, "key_address_forbidden"));
  await assert.rejects(agental.apiKeys.create({ name: "wider", preset: "admin" }), refused(403, "key_exceeds_caller"));
  // A key limited to several templates, none of them the default, has to name one to make a sandbox.
  await assert.rejects(agental.sandboxes.create({ name: "where" }), refused(400, "template_required"));
  assert.equal(sent.length, 4);

  // A key is made with a preset or with actions, and a type that holds both is refused before anything is sent.
  // @ts-expect-error preset or actions, not both
  const both: Parameters<typeof agental.apiKeys.create>[0] = { name: "both", preset: "ci", actions: ["exec"] };
  assert.ok(both);
});

test("a create sends one region or the regions to try, regions() lists them, and a full region's refusal says where there is room", async () => {
  const full = json(409, { error: { code: "capacity_exceeded", message: "No room in eu.", regionsWithRoom: ["us"] } });
  const listed = json(200, { regions: [{ name: "eu", label: "Europe", about: "Servers in the EEA or the UK.", default: true, sizesWithRoom: ["small"] }] });
  const { agental, sent } = scripted(json(201, sandbox()), json(201, sandbox()), full, listed);
  await agental.sandboxes.create({ name: "one", region: "us" });
  assert.deepEqual(sent[0]?.body, { name: "one", region: "us" });
  await agental.sandboxes.create({ name: "two", region: ["eu", "us"] });
  assert.deepEqual(sent[1]?.body, { name: "two", regions: ["eu", "us"] });
  await assert.rejects(agental.sandboxes.create({ name: "three", region: "eu" }), (error: unknown) => error instanceof ApiError && error.code === "capacity_exceeded" && error.regionsWithRoom?.[0] === "us");
  const regions = await agental.regions();
  assert.deepEqual([regions[0]?.name, regions[0]?.default, sent.at(-1)?.path], ["eu", true, "/v1/regions"]);
});

test("SSH is turned on, read and off, and its keys listed, added and removed, each by the call the API has for it", async () => {
  const on = { enabled: true, enabledAt: "2026-10-26T08:00:00.000Z", address: "203.0.113.7:22041", host: "203.0.113.7", port: 22041, user: "root", hostKey: "ssh-ed25519 AAAAC3Nza" };
  const off = { enabled: false, enabledAt: null, address: null, host: null, port: null, user: null, hostKey: null };
  const key = { id: "3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", fingerprint: "SHA256:3q2+7w", type: "ssh-ed25519", comment: "me@laptop" };
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, on),
    json(200, on),
    json(200, { keys: [key] }),
    json(201, key),
    new Response(null, { status: 204 }),
    json(200, off),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const base = "/v1/sandboxes/sbx_0123456789abcdef/ssh";

  assert.equal((await box.ssh.on()).port, 22041);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["PUT", base]);
  assert.equal((await box.ssh.get()).user, "root");
  assert.deepEqual([sent[2]?.method, sent[2]?.path], ["GET", base]);
  assert.deepEqual(await box.ssh.keys(), [key]);
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["GET", `${base}/keys`]);
  assert.equal((await box.ssh.addKey("ssh-ed25519 AAAAC3Nza me@laptop")).comment, "me@laptop");
  assert.deepEqual([sent[4]?.method, sent[4]?.path, sent[4]?.body], ["POST", `${base}/keys`, { publicKey: "ssh-ed25519 AAAAC3Nza me@laptop" }]);
  await box.ssh.removeKey(key.id);
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["DELETE", `${base}/keys/${encodeURIComponent(key.id)}`]);
  assert.equal((await box.ssh.off()).enabled, false);
  assert.deepEqual([sent[6]?.method, sent[6]?.path], ["DELETE", base]);
});

test("a stuck sandbox is recovered by one call, never sent twice, with the burst fee it may pay and the one it paid", async () => {
  const recovered = new Response(JSON.stringify(sandbox({ status: "running" })), { status: 200, headers: { "content-type": "application/json", "agental-burst-fee": "1200" } });
  const { agental, sent } = scripted(json(200, sandbox({ status: "error" })), recovered);
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  await box.recover({ maxBurstFeeMicros: 5000 });
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.headers.get("agental-max-burst-fee")], ["POST", "/v1/sandboxes/sbx_0123456789abcdef/recover", "5000"]);
  assert.deepEqual([box.status, box.burstFeeMicros], ["running", 1200]);
});

test("who the key belongs to, and the account's port addresses, listed and hidden", async () => {
  const me = { id: "usr_1", name: "Ian", email: "ian@example.com", role: "owner", activeOrganizationId: "org_1", closed: null };
  const route = { id: "hr_1", sandboxId: "sbx_0123456789abcdef", port: 3000, title: "port-3000", public: true, hidden: false, proxyPath: "/v1/host-routes/hr_1/proxy", registered: true, listening: true, proxy: "https://x.agental.site", url: "https://x.agental.site" };
  const { agental, sent } = scripted(json(200, me), json(200, { routes: [route] }), json(200, { ...route, hidden: true }));
  assert.equal((await agental.me()).email, "ian@example.com");
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/me"]);
  assert.deepEqual(await agental.hostRoutes(), [route]);
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", "/v1/host-routes"]);
  assert.equal((await agental.hideHostRoute("hr_1")).hidden, true);
  assert.deepEqual([sent[2]?.method, sent[2]?.path], ["POST", "/v1/host-routes/hr_1/hide"]);
});

test("data retention is read, and set to a period or until the sandbox is deleted", async () => {
  const kept: DataRetention = {
    keepDays: 30,
    enabled: true,
    choices: [1, 7, 30, 90],
    defaultKeepDays: 30,
    lastCleared: null,
    retained: [{ what: "Sandbox metrics", kept: "15 days" }],
  };
  const { agental, sent } = scripted(json(200, kept), json(200, { ...kept, keepDays: 7 }), json(200, { ...kept, keepDays: null, enabled: false }));
  assert.deepEqual(await agental.getDataRetention(), kept);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/data-retention"]);
  assert.equal((await agental.setDataRetention(7)).keepDays, 7);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PATCH", "/v1/data-retention", { keepDays: 7 }]);
  assert.equal((await agental.setDataRetention(null)).enabled, false);
  assert.deepEqual(sent[2]?.body, { keepDays: null });
});

test("a sandbox is made, found, changed and tagged by its tags and metadata", async () => {
  const labelled = sandbox({ tags: ["claude", "run-7f3a"], ownTags: ["run-7f3a"], metadata: { repo: "acme/web", team: "infra" }, ownMetadata: { repo: "acme/web" } });
  const { agental, sent } = scripted(
    json(201, labelled),
    json(200, { sandboxes: [labelled] }),
    json(200, labelled),
    json(200, { ...labelled, tags: ["claude", "run-7f3a", "pr-412"] }),
    json(200, labelled),
  );
  const made = await agental.sandboxes.create({ name: "agent-1", tags: ["run-7f3a"], metadata: { repo: "acme/web" } });
  assert.deepEqual(sent.at(-1)?.body, { name: "agent-1", tags: ["run-7f3a"], metadata: { repo: "acme/web" } });
  assert.deepEqual(made.tags, ["claude", "run-7f3a"]);
  assert.deepEqual(made.metadata, { repo: "acme/web", team: "infra" });

  const found = await agental.sandboxes.list({ tag: ["run-7f3a", "claude"], metadata: { repo: "acme/web" } });
  assert.equal(found.length, 1);
  assert.equal(sent.at(-1)?.path, `/v1/sandboxes?tag=run-7f3a&tag=claude&${encodeURIComponent("metadata[repo]")}=${encodeURIComponent("acme/web")}&limit=200`);

  await made.update({ tags: ["run-7f3a"], metadata: { repo: null } });
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.body], ["PATCH", { tags: ["run-7f3a"], metadata: { repo: null } }]);
  await made.addTag("pr-412");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.path], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/tags/pr-412"]);
  assert.deepEqual(made.tags, ["claude", "run-7f3a", "pr-412"]);
  await made.removeTag("pr-412");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.path], ["DELETE", "/v1/sandboxes/sbx_0123456789abcdef/tags/pr-412"]);
});

test("a list follows every page, and a page is read alone with its filter, sort and cursor", async () => {
  const one = sandbox({ id: "sbx_0000000000000001", name: "a" });
  const two = sandbox({ id: "sbx_0000000000000002", name: "b" });
  const { agental, sent } = scripted(
    json(200, { sandboxes: [one], nextCursor: "c1" }),
    json(200, { sandboxes: [two], nextCursor: null }),
    json(200, { sandboxes: [two], nextCursor: "c2" }),
    // An API from before pages answers every sandbox and no nextCursor: the list ends there.
    json(200, { sandboxes: [one, two] }),
  );
  const all = await agental.sandboxes.list({ status: ["running", "stopped"], archived: false, notMetadata: { repo: "*" } });
  assert.deepEqual(all.map((each) => each.name), ["a", "b"]);
  assert.equal(sent[0]?.path, `/v1/sandboxes?status=running&status=stopped&archived=false&${encodeURIComponent("notMetadata[repo]")}=${encodeURIComponent("*")}&limit=200`);
  assert.equal(sent[1]?.path, `/v1/sandboxes?status=running&status=stopped&archived=false&${encodeURIComponent("notMetadata[repo]")}=${encodeURIComponent("*")}&limit=200&cursor=c1`);

  const page = await agental.sandboxes.page({ text: "b", createdAfter: new Date("2026-11-06T00:00:00Z") }, { sort: "-created", limit: 1 });
  assert.deepEqual([page.sandboxes.map((each) => each.name), page.nextCursor], [["b"], "c2"]);
  assert.equal(sent[2]?.path, `/v1/sandboxes?createdAfter=${encodeURIComponent("2026-11-06T00:00:00.000Z")}&q=b&sort=-created&limit=1`);

  assert.equal((await agental.sandboxes.list()).length, 2);
});

test("a summary is asked with the list's filter and the facets named, and answered as the API says it", async () => {
  const counted = {
    since: "2026-11-07T00:00:00.000Z",
    total: { count: 2, microsPerHour: 108000, spentMicros: 1200 },
    byState: { running: { count: 2, microsPerHour: 108000, spentMicros: 1200 } },
    ifStopped: { microsPerHour: 5400, withMemoryMicrosPerHour: 10800 },
    facets: { "metadata.repo": { values: [{ value: "acme/web", count: 2, microsPerHour: 108000 }], more: 0 } },
  };
  const { agental, sent } = scripted(json(200, counted));
  const summary = await agental.sandboxes.summary({ status: "running", metadata: { repo: "*" } }, { facets: ["status", "metadata.repo"] });
  assert.equal(summary.total.microsPerHour, 108000);
  assert.equal(sent[0]?.path, `/v1/sandbox-summary?status=running&${encodeURIComponent("metadata[repo]")}=${encodeURIComponent("*")}&facets=${encodeURIComponent("status,metadata.repo")}`);
});

test("a job is previewed by a filter, made from the preview with a key that makes it once, and waited on to its end", async () => {
  const counts = { pending: 0, acting: 0, accepted: 0, done: 2, skipped: 0, failed: 0, uncertain: 0 };
  const job = { id: "sjb_1", action: "stop", options: {}, state: "running", total: 2, counts, createdAt: "2026-11-07T00:00:00.000Z", endedAt: null, problems: [] };
  const { agental, sent } = scripted(
    json(201, { id: "sjp_1", action: "stop", options: {}, count: 2, sample: [], microsPerHour: { now: 108000, after: 5400 }, expiresAt: "2026-11-07T00:15:00.000Z" }),
    json(202, job),
    json(200, job),
    json(200, { ...job, state: "done", endedAt: "2026-11-07T00:01:00.000Z" }),
  );
  const preview = await agental.jobs.preview("stop", { filter: { status: "running", tag: "ci" } }, { keepMemory: true });
  assert.deepEqual(sent[0]?.body, { action: "stop", options: { keepMemory: true }, select: { filter: { status: "running", tag: "ci" } } });
  const made = await agental.jobs.create({ previewId: preview.id }, { idempotencyKey: "nightly-stop-1" });
  assert.equal(sent[1]?.headers.get("idempotency-key"), "nightly-stop-1");
  assert.deepEqual(sent[1]?.body, { previewId: "sjp_1" });
  const seen: string[] = [];
  const done = await agental.jobs.wait(made.id, { onProgress: (each) => seen.push(each.state) });
  assert.deepEqual([done.state, seen], ["done", ["running", "done"]]);
  assert.equal(sent[3]?.path, "/v1/sandbox-jobs/sjb_1");
});

test("a template is made with tags and metadata, changed, and tagged", async () => {
  const labelled = template({ tags: ["team-infra"], metadata: { team: "infra" } });
  const { agental, sent } = scripted(json(201, labelled), json(200, labelled), json(200, { ...labelled, tags: ["claude", "team-infra"] }), json(200, labelled), json(200, labelled));
  const made = await agental.templates.create("coding-agent", { tags: ["team-infra"], metadata: { team: "infra" } });
  assert.deepEqual(sent.at(-1)?.body, { name: "coding-agent", tags: ["team-infra"], metadata: { team: "infra" } });
  assert.deepEqual(made.tags, ["team-infra"]);
  assert.deepEqual(made.metadata, { team: "infra" });
  await made.update({ metadata: { team: null } });
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.body], ["PATCH", { metadata: { team: null } }]);
  await made.addTag("claude");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.path], ["PUT", `/v1/templates/${made.id}/tags/claude`]);
  await made.removeTag("claude");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.path], ["DELETE", `/v1/templates/${made.id}/tags/claude`]);
  await made.rename("other");
  assert.deepEqual([sent.at(-1)?.method, sent.at(-1)?.body], ["PATCH", { name: "other" }]);
});

test("a tag that is not one is refused before anything is sent, so no word can make its path another", async () => {
  const { agental, sent } = scripted(json(201, sandbox()), json(201, template()));
  const made = await agental.sandboxes.create({ name: "agent-1" });
  const tpl = await agental.templates.create("coding-agent");
  for (const bad of ["..", ".", "a/b", "", "-x", "no spaces"]) {
    await assert.rejects(made.removeTag(bad), AgentalError);
    await assert.rejects(made.addTag(bad), AgentalError);
    await assert.rejects(tpl.removeTag(bad), AgentalError);
  }
  assert.equal(sent.length, 2);
});

test("a team's members and invites are read and changed through organizations, in the team the key acts in", async () => {
  const own = { id: "org_own", name: "Ada", personal: true, role: "owner", membersAllowed: false, createdAt: "2026-10-30T10:00:00.000Z", ownerUserId: "usr_ada" };
  const acme = { id: "org_acme", name: "Acme", personal: false, role: "owner", membersAllowed: true, createdAt: "2026-10-30T11:00:00.000Z", ownerUserId: "usr_ada" };
  const cy = { userId: "usr_cy", name: "Cy", email: "cy@example.com", role: "member", addedAt: "2026-10-31T10:00:00.000Z", addedBy: "usr_ada" };
  const invite = {
    id: "inv_1",
    email: "dee@example.com",
    role: "admin",
    status: "open",
    invitedBy: "usr_ada",
    createdAt: "2026-10-31T10:00:00.000Z",
    expiresAt: "2026-11-07T10:00:00.000Z",
    delivery: "sent",
  };
  const { agental, sent } = scripted(
    json(200, { organizations: [own, acme] }),
    json(200, { organizations: [own, acme] }),
    json(200, { id: "usr_ada", activeOrganizationId: "org_acme" }),
    json(201, { organization: { ...acme, id: "org_beta", name: "Beta" }, created: true }),
    json(200, { members: [cy] }),
    json(200, { userId: "usr_cy", role: "admin" }),
    json(200, { revokedKeys: 2 }),
    json(201, invite),
    json(200, { invites: [invite] }),
    new Response(null, { status: 204 }),
  );

  assert.deepEqual((await agental.organizations.list()).map((organization) => organization.name), ["Ada", "Acme"]);
  assert.equal((await agental.organizations.current()).id, "org_acme");
  assert.equal((await agental.organizations.createTeam("Beta")).id, "org_beta");
  assert.deepEqual(sent[3]?.body, { kind: "team", name: "Beta" });
  assert.deepEqual(await agental.organizations.members("org_acme"), [cy]);
  assert.equal(await agental.organizations.setRole("org_acme", "usr_cy", "admin"), "admin");
  assert.deepEqual([sent[5]?.method, sent[5]?.path, sent[5]?.body], ["PATCH", "/v1/organizations/org_acme/members/usr_cy", { role: "admin" }]);
  assert.deepEqual(await agental.organizations.removeMember("org_acme", "usr_cy", { revokeKeys: true }), { revokedKeys: 2 });
  assert.deepEqual([sent[6]?.method, sent[6]?.path], ["DELETE", "/v1/organizations/org_acme/members/usr_cy?revokeKeys=true"]);
  assert.equal((await agental.organizations.invite("dee@example.com", { role: "admin" })).id, "inv_1");
  assert.deepEqual(sent[7]?.body, { email: "dee@example.com", role: "admin" });
  assert.deepEqual(await agental.organizations.invites(), [invite]);
  await agental.organizations.revokeInvite("inv_1");
  assert.deepEqual([sent[9]?.method, sent[9]?.path], ["DELETE", "/v1/invites/inv_1"]);
});

test("a sandbox's schedules are listed, made, read, changed, run, their runs read, and deleted, each by the call the API has for it", async () => {
  const run = { id: "run_1", scheduleId: "sch_1", sandboxId: "sbx_0123456789abcdef", dueAt: "2026-11-03T16:00:00.000Z", startedAt: null, finishedAt: null, outcome: "running", reason: null, exitCode: null, commandId: null, startedSandbox: false, stoppedSandbox: null } as const;
  const schedule = {
    id: "sch_1",
    sandboxId: "sbx_0123456789abcdef",
    name: "scrape",
    command: "python scrape.py",
    every: "1h",
    cron: null,
    timeZone: "UTC",
    timeoutMs: 600000,
    ifStopped: "start",
    keepMemory: false,
    overlap: "skip",
    enabled: true,
    nextRunAt: "2026-11-03T17:00:00.000Z",
    lastRun: null,
    createdAt: "2026-11-03T16:00:00.000Z",
    updatedAt: "2026-11-03T16:00:00.000Z",
  } as const;
  const { agental, sent } = scripted(
    json(200, sandbox()),
    json(200, { schedules: [schedule] }),
    json(201, schedule),
    json(200, schedule),
    json(200, { ...schedule, enabled: false, nextRunAt: null }),
    json(202, run),
    json(200, { runs: [run] }),
    new Response(null, { status: 204 }),
  );
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const base = "/v1/sandboxes/sbx_0123456789abcdef/schedules";

  assert.equal((await box.schedules.list())[0]?.id, "sch_1");
  assert.deepEqual([sent[1]?.method, sent[1]?.path], ["GET", base]);
  assert.equal((await box.schedules.create({ name: "scrape", command: "python scrape.py", every: "1h" })).every, "1h");
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["POST", base, { name: "scrape", command: "python scrape.py", every: "1h" }]);
  assert.equal((await box.schedules.get("sch_1")).name, "scrape");
  assert.deepEqual([sent[3]?.method, sent[3]?.path], ["GET", `${base}/sch_1`]);
  assert.equal((await box.schedules.update("sch_1", { enabled: false })).nextRunAt, null);
  assert.deepEqual([sent[4]?.method, sent[4]?.path, sent[4]?.body], ["PATCH", `${base}/sch_1`, { enabled: false }]);
  assert.equal((await box.schedules.run("sch_1")).outcome, "running");
  assert.deepEqual([sent[5]?.method, sent[5]?.path], ["POST", `${base}/sch_1/run`]);
  assert.equal((await box.schedules.runs("sch_1", { limit: 5 }))[0]?.id, "run_1");
  assert.deepEqual([sent[6]?.method, sent[6]?.path], ["GET", `${base}/sch_1/runs?limit=5`]);
  await box.schedules.delete("sch_1");
  assert.deepEqual([sent[7]?.method, sent[7]?.path], ["DELETE", `${base}/sch_1`]);
});

test("a schedule that runs once is asked to delete its sandbox after with deleteAfter, and its run says it did", async () => {
  const run = { id: "run_1", scheduleId: "sch_1", sandboxId: "sbx_0123456789abcdef", dueAt: "2026-11-04T09:00:20.000Z", startedAt: "2026-11-04T09:00:21.000Z", finishedAt: "2026-11-04T09:00:30.000Z", outcome: "succeeded", reason: null, exitCode: 0, commandId: "cmd_1", startedSandbox: false, stoppedSandbox: null, deletedSandbox: true } as const;
  const schedule = { id: "sch_1", sandboxId: "sbx_0123456789abcdef", name: "last", command: "./finish.sh", every: null, cron: null, at: "2026-11-04T09:00:00.000Z", timeZone: "UTC", timeoutMs: 600000, ifStopped: "start", keepMemory: false, overlap: "skip", deleteAfter: true, enabled: true, nextRunAt: null, pausedReason: null, lastRun: run, createdAt: "2026-11-03T16:00:00.000Z", updatedAt: "2026-11-03T16:00:00.000Z" } as const;
  const { agental, sent } = scripted(json(200, sandbox()), json(201, schedule), json(200, { runs: [run] }));
  const box = await agental.sandboxes.get("sbx_0123456789abcdef");
  const made = await box.schedules.create({ command: "./finish.sh", at: "2026-11-04T09:00:00Z", deleteAfter: true });
  assert.equal(made.deleteAfter, true);
  assert.deepEqual(sent[1]?.body, { command: "./finish.sh", at: "2026-11-04T09:00:00Z", deleteAfter: true });
  assert.equal((await box.schedules.runs("sch_1"))[0]?.deletedSandbox, true);
});

function egressAccount(changes: Partial<EgressAccount> = {}): EgressAccount {
  return {
    offered: true,
    enabled: false,
    missing: ["use_case"],
    refused: null,
    useCase: null,
    microsPerGb: 3_000_000,
    spentMicros: 0,
    budgetMicros: 50_000_000,
    budgetSet: false,
    defaultBudgetMicros: 50_000_000,
    blocked: null,
    ...changes,
  };
}

test("residential egress: the account's standing is read, its use case told and its budget set, and a sandbox and a template are sent out residential", async () => {
  const useCase = "Our agents test our customers' sign-up flows from the countries they sell in.";
  const residential = { via: "residential" as const, country: "de", session: "sticky" as const };
  const { agental, sent } = scripted(
    json(200, egressAccount()),
    json(200, egressAccount({ enabled: true, missing: [], useCase: { text: useCase, submittedAt: "2026-11-08T00:00:00.000Z" } })),
    json(200, egressAccount({ enabled: true, missing: [], budgetMicros: 0, budgetSet: true })),
    json(200, egressAccount({ enabled: true, missing: [] })),
    json(201, sandbox()),
    json(200, residential),
    json(200, { via: "box", country: null, session: null }),
    refusal(403, "egress_not_enabled"),
    json(200, { id: "tpl_0000000000000002", name: "coding-agent" }),
    json(200, residential),
    json(200, { via: "box", country: null, session: null }),
  );
  assert.deepEqual((await agental.egress()).missing, ["use_case"]);
  assert.deepEqual([sent[0]?.method, sent[0]?.path], ["GET", "/v1/egress"]);
  assert.equal((await agental.setEgressUseCase(useCase)).useCase?.text, useCase);
  assert.deepEqual([sent[1]?.method, sent[1]?.path, sent[1]?.body], ["PUT", "/v1/egress/use-case", { useCase }]);
  assert.equal((await agental.setEgressBudget(0)).budgetMicros, 0);
  assert.deepEqual([sent[2]?.method, sent[2]?.path, sent[2]?.body], ["PUT", "/v1/egress/budget", { budgetMicros: 0 }]);
  assert.equal((await agental.setEgressBudget(null)).budgetSet, false);
  assert.deepEqual(sent[3]?.body, { budgetMicros: null });

  // A create sends where it leaves from its first boot.
  const made = await agental.sandboxes.create({ name: "abroad", egress: { via: "residential", country: "de" } });
  assert.deepEqual(sent[4]?.body, { name: "abroad", egress: { via: "residential", country: "de" } });
  assert.deepEqual(await made.setEgress({ via: "residential", country: "de", session: "sticky" }), residential);
  assert.deepEqual([sent[5]?.method, sent[5]?.path, sent[5]?.body], ["PUT", "/v1/sandboxes/sbx_0123456789abcdef/egress", residential]);
  assert.equal((await made.egress()).via, "box");
  assert.deepEqual([sent[6]?.method, sent[6]?.path], ["GET", "/v1/sandboxes/sbx_0123456789abcdef/egress"]);
  // An account that may not use it is told what it still needs.
  await assert.rejects(made.setEgress(residential), (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "egress_not_enabled");

  const template = await agental.templates.get("tpl_0000000000000002");
  assert.deepEqual(await template.setEgress(residential), residential);
  assert.deepEqual([sent[9]?.method, sent[9]?.path, sent[9]?.body], ["PUT", "/v1/templates/tpl_0000000000000002/egress", residential]);
  assert.equal((await template.egress()).via, "box");
  assert.deepEqual([sent[10]?.method, sent[10]?.path], ["GET", "/v1/templates/tpl_0000000000000002/egress"]);
  assert.equal(sent.length, 11);
});
