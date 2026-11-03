# agental

TypeScript SDK for [agental.io](https://agental.io): a Linux virtual machine of your own over HTTP. One call makes it, another runs a command in it, another stops it. Its disk is kept while it is stopped.

```bash
npm install agental
```

Node 20.16 or later. No dependencies. The package is ESM only: `import`, not `require`. It uses only `fetch` and Web Crypto, so Bun, Deno and Cloudflare Workers should run it too, but it is only tested on Node.

## The agental command

The same package is the `agental` command. To sign in on this computer and get a shell in a new sandbox:

```bash
npx agental@latest sh
```

`npx agental@latest` alone signs in through the browser, installs the command with `npm install -g agental`, and installs the agent skills. `agental help` lists every command: `agental create`, `agental exec`, `agental ssh` and the rest. The command's source is in agental's own repository, which builds and publishes this package. The public repository, agental-io/agental-typescript, has the SDK alone.

## Start

Make an API key in the console and put it in `AGENTAL_API_KEY`. Without one, the SDK uses the sign-in the agental command keeps on this computer, in `~/.config/agental/credentials.json`: `npx agental@latest` makes it.

```ts
import { Agental } from "agental";

const agental = new Agental();

const sandbox = await agental.sandboxes.create({ size: "small" }); // tiny, small, medium or large

const { stdout, exitCode } = await sandbox.exec("uname -a");
console.log(exitCode, stdout);

await sandbox.files.write("app/main.py", "print('hello')\n");
console.log((await sandbox.exec(["python3", "/opt/agental/app/main.py"])).stdout);

await sandbox.delete();
```

`create` answers when the machine is running. A sandbox you already have is `agental.sandboxes.get(id)`, and `agental.sandboxes.list()` gives all of them.

## Commands

```ts
await sandbox.exec(["ls", "-la", "/opt/agental"]); // the arguments exactly, no shell
await sandbox.exec("cd /opt/agental && npm test"); // a line of shell, run by sh -c
```

- A command that fails is an answer, not an error: read `exitCode`.
- Every command starts fresh, as root in `/root`. A `cd` or an `export` does not carry over to the next one.
- A command gets 60 seconds unless you pass `timeoutMs`, up to `90000`. One that runs out is killed and exits `124`. For longer, use `commands.run` below, up to `600000`.
- Each of `stdout` and `stderr` is cut at 1 MB, and `truncated` is then true.

To see output as it arrives:

```ts
for await (const event of sandbox.execStream("npm test")) {
  if (event.type === "exit") console.log("exited", event.exitCode);
  else process.stdout.write(event.data);
}
```

For a command that takes more than a minute, do not hold a request open for it:

```ts
const build = await sandbox.commands.run("cd /opt/agental && make", { timeoutMs: 600_000 });
console.log(build.status, build.exitCode, build.stdout);

// or start it and look later
const started = await sandbox.commands.start("make");
const now = await sandbox.commands.get(started.id);
```

For work that must outlast ten minutes, start it in the background inside the machine: `sandbox.exec("nohup npm run dev > dev.log 2>&1 < /dev/null &")`.

## Files

Paths are relative to the work folder, `/opt/agental`. A file can be up to 10 MB.

```ts
await sandbox.files.write("notes.txt", "hi");
await sandbox.files.read("notes.txt"); // "hi"
await sandbox.files.write("logo.png", bytes); // a Uint8Array
await sandbox.files.readBytes("logo.png");
```

## Stop, start, fork, snapshot

```ts
await sandbox.stop(); // the disk is kept, what was running is not, and it costs 5% of the running price
await sandbox.stop({ keepMemory: true }); // or keep its memory too, at 10%: start() puts back every process as it was
await sandbox.start(); // waits until it is running, also when it has to be brought back from storage

const copy = await sandbox.fork(); // a new sandbox with the same disk

const snapshot = await sandbox.snapshot("before-upgrade");
await sandbox.restore(snapshot.id); // roll the disk back
const fresh = await agental.sandboxes.create({ snapshotId: snapshot.id });
```

## Regions

```ts
const regions = await agental.regions(); // the default first, each with the sizes it has room for now
const sandbox = await agental.sandboxes.create({ size: "small", region: "eu" });
await agental.sandboxes.create({ size: "small", region: ["eu", "us"] }); // the first of them that has room
```

Left out, `region` is the default one. Each region has `name`, `label`, `about`, `default` and `sizesWithRoom`. A create that finds no room throws an `ApiError` with the status 409 and the code `capacity_exceeded`, whose `regionsWithRoom` names the other regions that have room for that size now, or none.

## When it stops

A sandbox runs until it is stopped, unless it has a time limit: then it is stopped once it has run for that long since its last start, and its disk is kept. The limit is `ttlSeconds`, in seconds: give it when you make a sandbox, on a template's start, or later.

```ts
const sandbox = await agental.sandboxes.create({ ttlSeconds: 7200 }); // two hours after each start
await sandbox.update({ ttlSeconds: 14_400 }); // four hours, from now on

// The run under way: when it stops, how long that is from now, and what decided it.
const { autoStopAt, secondsLeft, setBy } = await sandbox.autoStop(); // setBy "ttl": its last start and ttlSeconds

// Move that stop, later or sooner, for this run alone.
await sandbox.setAutoStop({ inSeconds: 3600 }); // an hour from now
await sandbox.setAutoStop({ at: new Date("2026-10-20T18:00:00Z") });

// Or take its time limit away: it runs until it is stopped.
await sandbox.clearAutoStop();
```

- The time limit comes from its create, its template, `update({ ttlSeconds })`, or a moved stop.
- Left out at a create, `ttlSeconds` is what the template's start says, and where that says none, the deployment's default. `null` is the deployment's default, whatever the template says. `(await agental.policy())` has `defaultTtlSeconds` and `maxTtlSeconds`: a limit over the ceiling throws an `ApiError` with the code `ttl_too_long`.
- A moved stop is 60 seconds from now at the least and `maxTtlSeconds` from now at the most, or it throws `auto_stop_too_soon` or `auto_stop_too_far` and the stop stays as it was. Each move counts from now, so a sandbox runs on for as long as something keeps moving its stop. A sandbox that is not running throws `invalid_state`.
- A move holds until the sandbox stops: its next start goes by `ttlSeconds` again. `update({ ttlSeconds })` while it runs puts the stop back to its last start and the new limit.
- `setBy` is `ttl`, `account` for a move by one of your keys or the console, or `sandbox` for a move by the sandbox itself. Every move is the event `sandbox.auto_stop_set`.

## Show what you built

```ts
const route = await sandbox.expose(8080);
console.log(route.url); // anyone can open it while the sandbox is running
```

The app must listen on `0.0.0.0`. Pass `{ public: false }` to keep the port behind your key.

## SSH

```ts
const ssh = await sandbox.ssh.on(); // where to connect: host, port, user, and the host key to pin
await sandbox.ssh.addKey("ssh-ed25519 AAAA... me@laptop"); // may log in as root
console.log(ssh.address, ssh.hostKey);
await sandbox.ssh.keys();
await sandbox.ssh.off(); // its port is closed
```

`sandbox.ssh.get()` reads it and changes nothing, and `removeKey(id)` takes a key away. SSH stays on through a stop, a start and a move, and `address` is null while the sandbox is not running. The command's `agental ssh <sandbox-id>` does all of it in one go.

## Desktop

```ts
const desktop = await sandbox.desktop.on(); // 1280 by 800 unless you give { width, height }
console.log(desktop.url); // watch and use it in a browser: keep it as a password is kept

await sandbox.desktop.click(640, 400);
await sandbox.desktop.type("hello");
await sandbox.desktop.key("ctrl+l");
const png = await sandbox.desktop.screenshot(); // the bytes of a PNG
const link = await sandbox.desktop.createLink({ access: "view", expiresIn: 600 }); // to show someone, for ten minutes
await sandbox.desktop.off();
```

A program in the sandbox opens its windows there with `DISPLAY` set to `desktop.display`. `screenshot` takes `format: "jpeg"`, a `region`, a `scale` and `cursor: false`, each cheaper for a model to read, and `screenshotBase64` gives the same picture as a model is handed it. `move`, `drag`, `scroll`, `clipboard` and `setClipboard` do what they say. What uses the pointer or the keyboard is never sent twice.

## Browser

A Chrome in the sandbox, driven from your own computer over the DevTools protocol:

```ts
import { chromium } from "playwright";

const { cdpUrl } = await sandbox.browser.on(); // on the desktop when one is on, or { headless: true }
const browser = await chromium.connectOverCDP(cdpUrl!);
```

Keep `cdpUrl` as a password is kept: whoever has it has the browser. Puppeteer, browser-use and Stagehand connect to it too, and `localCdpUrl` is the address from inside the sandbox. `sandbox.browser.get()` reads it, and `off()` cuts what was connected. What Chrome remembers stays on the sandbox's disk.

## Templates and secrets

A template is what a sandbox is made as and held to: its start (a size, a snapshot or a new machine, and a time limit), the variables and files every sandbox on it gets, and what every sandbox on it may reach (see below). Every account has one named `default`, which a sandbox is on when you name none.

```ts
const template = await agental.templates.create("coding-agent");
await template.secrets.set("GITHUB_TOKEN", process.env.GITHUB_TOKEN!);
await template.secrets.writeFile(".npmrc", "//registry.npmjs.org/:_authToken=...\n");
await template.setStart({ size: "medium" });

const sandbox = await agental.sandboxes.create({ template });
await sandbox.exec('gh auth status'); // GITHUB_TOKEN is in its environment

// A sandbox's own, on top of its template's, from its next command.
await sandbox.secrets.set("GITHUB_TOKEN", "a token for this one only");
```

A sandbox takes a change to its template when it next starts. To give it to the ones that are running now, apply it:

```ts
await template.secrets.set("GITHUB_TOKEN", "a new token");
console.log((await sandbox.template()).upToDate); // false
await template.apply(); // every running sandbox on it, or apply([sandbox.id])
```

`setStart({ size: "medium", ttlSeconds: 7200 })` has the template's sandboxes run for two hours after each start. `snapshotId` left out or `null` is a new machine. `ttlSeconds` left out stays as it was, and `null` is the deployment's default. Sandboxes made before keep their size, their disk and their time limit.

Values are read one at a time with `secrets.get(name)` and `secrets.readFile(path)`; `variables()` and `files()` give names and paths only. `sandbox.setTemplate(other)` puts a sandbox on another template, which it has from its next command. A template that sandboxes are on cannot be deleted.

## Keep a secret out of the sandbox

An agent can use a key without being able to read it. Set a variable with the hosts it is for, and it is kept out of the sandbox: its commands see a stand-in in its place, and when an HTTPS request leaves the sandbox for one of those hosts, the proxy on its server puts the value in place of the stand-in. Sent anywhere else, the stand-in is worth nothing.

```ts
const kept = await template.secrets.set("GITHUB_TOKEN", process.env.GITHUB_TOKEN!, { hosts: ["api.github.com", "github.com"] });
console.log(kept.standIn); // agental_hidden_..., what $GITHUB_TOKEN is in the sandbox
await template.apply(); // the running sandboxes on it take it now

// The request carries the stand-in out of the sandbox, and api.github.com is sent the token.
await sandbox.exec('curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user');

// Fewer hosts, without sending the value again. A new host needs set() with the value.
await template.secrets.setHosts("GITHUB_TOKEN", ["api.github.com"]);

const variable = await template.secrets.variable("GITHUB_TOKEN");
if (variable.hidden) console.log(variable.hosts, variable.standIn);
else console.log(variable.value);
```

The value is never given back, to you or anyone: `variable(name)` gives a kept-out variable's hosts and stand-in, `get(name)` throws an `AgentalError` for one, and `hidden()` names the variables kept out. The stand-in stays the same when the value is replaced, so a file that holds it keeps working. Set again without hosts, a variable is plain, and its commands read its value: give its hosts each time you replace one. A host is a name such as `api.github.com`, or `*.example.com` for every name under `example.com`, with no scheme, port or path, and a variable has 1 to 10 of them. A name on the Public Suffix List, such as `github.io`, is refused, and so is a wildcard over one, such as `*.com`: each throws an `ApiError` with the code `invalid_host`. Hosts do not open the template's outbound rule. `(await agental.policy()).hiddenVariables` says whether variables can be kept out where you are: where they cannot, setting one with hosts throws an `ApiError` with the code `hidden_variables_unavailable`.

## Decide what it may reach

A sandbox reaches the internet unless its template says otherwise. The rule lives on the template, and every sandbox on it is held to it, enforced outside the sandbox, so nothing running in it can change it, root included. A sandbox can add addresses of its own on top:

```ts
// Nothing gets out of a sandbox on this template...
const template = await agental.templates.create("locked-down");
await template.setNetwork({ outbound: "blocked" });

// ...but this one may reach its own database, from its first boot.
const sandbox = await agental.sandboxes.create({ template, network: { allow: ["203.0.113.7"] } });

// Its own addresses, from now on. The list replaces the one it had, and [] takes them away.
await sandbox.setNetwork({ allow: ["203.0.113.7", "198.51.100.0/24"] });

const network = await sandbox.network();
console.log(network.outbound, network.allow); // what it is held to: "allowlist", [...]
console.log(network.template, network.own); // the template's rule as it has it, and its own addresses
```

The rule is `open`, `blocked`, or `allowlist` with the addresses in `allow`, and `setNetwork` on a template sends the whole rule each time. A sandbox's own addresses add to an allowlist, let it out to them alone on a blocked template, and change nothing while its template is open. Together they come to 100 addresses at most. `allow` takes IPv4 addresses and ranges, not names.

A sandbox made from a template is held to its rule from its first boot. A change to the rule reaches a sandbox already on it when it next starts, or now with `template.apply()`: its `failed` names any sandbox whose server did not take the new rule, which stays held to the one it had. A sandbox's own addresses hold from when `setNetwork` answers. Nothing is restarted, and your commands, files and ports still reach it. `(await agental.policy()).networkPolicy` says whether sandboxes can be held to a rule where you are: where they cannot, asking for `blocked`, `allowlist` or addresses of a sandbox's own throws an `ApiError` with the code `network_policy_unavailable`.

## See what it uses

A sandbox's CPU, memory, disk and network are read once a minute, from outside it, and kept 15 days. Nothing is installed in it:

```ts
// The last hour of one sandbox, oldest first.
const { points, complete } = await sandbox.metrics();
const last = points.at(-1);
console.log(last?.cpuUtilization, last?.memoryUsedBytes); // 0.42 is 42% of its CPUs

// Another stretch, with a point every five minutes.
await sandbox.metrics({ since: new Date(Date.now() - 86_400_000), stepSeconds: 300 });

// Every sandbox you have, at one moment. Without at, now.
const { sandboxes } = await agental.metrics({ at: "2026-10-14T09:35:00Z" });
for (const each of sandboxes) console.log(each.name, each.reading?.memoryUsedBytes);

// How many of them were running, step by step, over the last 24 hours.
const running = await agental.runningOverTime();
console.log(running.points.at(-1)?.running);
```

A sandbox has no point for a moment it was stopped at, and its `reading` is then null. A figure its server did not have is null too. `complete` is false when a server did not answer, and readings may then be missing. `(await agental.policy()).metrics` says whether sandboxes are read where you are: where they are not, both `metrics` calls throw an `ApiError` with the code `metrics_unavailable`. `runningOverTime` answers either way.

## What it costs

```ts
// Where the account stands, in millionths of a US dollar.
const billing = await agental.billing();
console.log(billing.usedMicros, billing.topUpMicros);

// What is sold: plans with the sizes each makes, top-ups and their bonus, the free month and the hourly prices.
const prices = await agental.prices();

// Start paying $500 for $537 of credits. A person pays at url: nothing is charged before.
const { url } = await agental.checkout({ topUp: 500 });

// When the credits run out, charge the saved card $50 for a top-up, before anything is stopped.
await agental.setAutoReload(50);
```

`usedMicros` is the month's usage at list price, spent from the plan's credits first and then from the top-ups, which do not expire. A top-up is any whole number of dollars from $15 to $100,000. From $200 it adds a bonus: 2% at $200, growing evenly on a log scale to 25% at $10,000 and over, so $1,000 adds $1,115. `prices.topUps` lists what each offered amount adds, and `prices.topUpBonus` the curve. `checkout({ plan: "plan100" })` starts a plan the same way, or moves an account that has one at once, with `url` null and `changed` true. A checkout whose answer is lost is not sent again.

`setAutoReload(dollars)` has the card saved at the last purchase charged for a top-up of that much, with tax, when the month's credits and the top-ups run out, and the credits added at once, before any sandbox is stopped: at most three times a day, and not again for a day after a card that would not pay. `setAutoReload(null)` turns it off, and `billing().autoReload` says how it is set. It needs a plan or a top-up bought first, which saves the card: `billing().canAutoReload` says whether it can be set, and the call answers `409 no_card` until then.

The $20 plan makes tiny and small sandboxes, the $100 plan medium ones too, and the $500 and $2000 plans every size: `prices.tiers` lists the plans, and each plan's `sizes` says which. A create, fork or template start of a size the plan does not make throws an `ApiError` with the status 402 and the code `size_not_on_plan`, whose message names the plan that makes it. A sandbox made before a change of plan still starts at its own size.

## How many you run, and how fast you start them

Each plan runs so many small sandboxes at once, its running count, and starts so many at once for nothing, its free burst: a tiny counts half, a medium 2 and a large 4. The $20 plan runs 20 and bursts 20, the $100 plan 100 and 100, the $500 plan 600 and 200, the $2000 plan 2000 and 400; `prices().tiers` gives each plan's `runningUnits` and `freeBurstUnits`, and `burstFee` how fees are worked out. Each start adds its memory to a burst meter that halves every 15 minutes. Starting faster than the free burst is never refused for speed: it costs a burst fee, which grows with how far over the meter goes.

```ts
const burst = await agental.burst();
console.log(burst.runningUnits, burst.freeBurstUnits); // 100 100
console.log(burst.freeNowMb / 4096); // small sandboxes you may start now for nothing
console.log(burst.spentMicros, burst.budgetMicros); // burst fees this month, and the most you spend on them

// What starting 30 medium ones now would cost, and in how many seconds it would cost nothing.
const { quote } = await agental.burst({ size: "medium", count: 30 });
console.log(quote?.feeMicros, quote?.freeInSeconds);

// Spend at most $10 a month on burst fees; 0 refuses every start that would cost one, null puts back the default ($50).
await agental.setBurstBudget(10_000_000);
```

A create, fork or start takes `maxBurstFeeMicros`, the most it may pay, and the sandbox's `burstFeeMicros` says what it paid:

```ts
const sandbox = await agental.sandboxes.create({ maxBurstFeeMicros: 50_000 }); // at most 5 cents
console.log(sandbox.burstFeeMicros); // 0 within the free burst
await sandbox.start({ maxBurstFeeMicros: 0, maxBurstWaitMs: 300_000 }); // free, waiting up to 5 minutes for it to be
```

Where `enforced` is true, a start is refused with an `ApiError` of status 429 and one of these codes. `feeMicros` says what it would have cost and `retryAfterSeconds` when it would cost nothing, or null when waiting would not help:

- `running_limit_reached`: the account already runs its plan's running count. Stop something first.
- `burst_fee_too_high`: the start would cost more than `maxBurstFeeMicros`.
- `burst_budget_reached`: the fee would take this month's burst fees past the budget.
- `burst_in_free_month`: the start would cost a fee, which the free month does not pay.

With `maxBurstWaitMs`, a start refused with one of the last three waits `retryAfterSeconds`, if that is no longer than allowed, and is tried once more. It is off by default, and never waits for `running_limit_reached`. Burst fees come out of the plan's credits, then the top-ups, and `billing().burstMicros` is this month's.

## Send it to your own collector

Your sandboxes' metrics and lifecycle events can be sent to an OTLP/HTTP collector of your own:

```ts
// Set it, or replace the one you had. Nothing is sent yet.
await agental.setTelemetry({ endpoint: "https://otlp.example.com", headers: { "x-api-key": "..." } });

// Send it one empty export, and see what it answered.
console.log(await agental.testTelemetry()); // { ok: true, status: 200, message: null }

// Where it is, the names of its headers, and how the last export went. Null when none is set.
const telemetry = await agental.getTelemetry();
console.log(telemetry?.headers, telemetry?.lastExportAt, telemetry?.lastError);

// Stop sending to it.
await agental.deleteTelemetry();
```

`endpoint` is the collector's base address, https on port 443 or 4318: metrics go to `/v1/metrics` under it, every minute, and events to `/v1/logs`, as they happen. The values of `headers` are kept and never shown again. An event has the same id in the collector as in your webhooks. `deleteTelemetry` and `testTelemetry` throw an `ApiError` with the status 404 when none is set. `(await agental.policy()).telemetry` says whether anything is sent to a collector where you are: where it is not, these calls throw an `ApiError` with the code `telemetry_unavailable`. Metrics are sent only where `metrics` is true as well.

## What agental keeps about you

```ts
import { writeFile } from "node:fs/promises";

const exported = await agental.exportAccount();
console.log(exported.account.email, exported.sessions.length);
await writeFile("agental-account.json", JSON.stringify(exported, null, 2));
```

It is everything agental keeps about your account and the person behind it: the account, its sessions with the address and browser each began from, its keys by name, billing, payments, usage, and what it has made. Secrets are named, never given. It works with a key. Closing an account does not: only a person signed in to the console can close one, from Settings.

## How long history is kept

Your sandboxes' history is the output of their commands, their agent conversations and their events. It is kept 30 days until you choose:

```ts
const retention = await agental.getDataRetention();
console.log(retention.keepDays, retention.retained); // 30, and what agental keeps for periods of its own
await agental.setDataRetention(7); // 1, 7, 30 or 90 days, or null until the sandbox is deleted
```

History older than that is deleted within the hour and cannot be brought back. A deleted sandbox's history goes with it, whatever is set.

## Email

Every sandbox has a mail domain of its own, and any name before the `@` reaches it. Mail is off until you turn it on. One switch covers receiving and sending.

```ts
const { domain } = await sandbox.email.enable();
console.log(`support@${domain}`); // support@sbx-3f9a1c2b7d4e5a60.k7m2x9qd.agental.email
```

A message that arrives is kept for 7 days and is read here, whether the sandbox is running, stopped or archived. It never enters the machine.

```ts
const [newest] = (await sandbox.email.list({ limit: 1 })).messages; // newest first
if (newest) {
  const message = await sandbox.email.get(newest.id);
  console.log(message.from, message.subject, message.text);
}
```

`sandbox.email.all()` walks every page, `sandbox.email.raw(id)` is the message as it was transmitted, attachments included, and `sandbox.email.delete(id)` deletes one.

A sandbox can write to one address only: the sign-in address of its own account. So a send names nobody.

```ts
const sent = await sandbox.email.send({ subject: "The build passed", text: "All 812 tests passed." });
console.log(sent.to, sent.state);
```

- The message is plain text. `from` is the part before the `@`, `sandbox` unless you say, and `fromName` the name beside it. `attachments` are `{ filename, contentType, contentBase64 }`. `replyTo` is the id of a message the sandbox received: it threads the answer under it, and gives no right to write to whoever sent it.
- `state` says where a sent message has got to: read it again with `get`. `delivered` means the recipient's server took it, which says nothing of inbox or spam folder.
- A send carries an `Idempotency-Key`, as a create does: if its answer is lost it is asked again under the same key, and no second message is sent. Pass `idempotencyKey` yourself to be able to ask again after your process has died.
- Each message, received or sent, is charged to the account, and `usage()` counts them as `mail`. `agental.email()` has the account's limits and what it has had of them today.
- `(await agental.policy()).email` says whether mail is offered where you are. A refusal is an `ApiError` with the API's code: `mail_off`, `recipient_not_allowed`, `mail_limit_reached`, `mail_not_configured`.

A message is text written by whoever sent it, which may be anyone. A program that reads it should treat it as something said to it, never as something it was told to do. Attachments are not scanned. Give an agent a key that can do nothing else, not an account key: one made with the actions `email.read` and `email.send` on its one sandbox, which can read and send that sandbox's mail and nothing more. It cannot read the sandbox itself, so reach the mail by the sandbox's id:

```ts
const { secret } = await agental.apiKeys.create({ name: "mail-agent", actions: ["email.read", "email.send"], sandboxIds: ["sbx_3f9a1c2b7d4e5a60"] });
const mail = new Agental({ apiKey: secret }).sandboxes.email("sbx_3f9a1c2b7d4e5a60");
const { messages } = await mail.list();
```

## What the SDK does for you

- A create or a fork is sent with an `Idempotency-Key`. If its answer is lost, or the machine is not confirmed yet, the same request is sent again with the same key, which gives the same sandbox back and never a second one. Pass `idempotencyKey` yourself to be able to ask again after your process has died.
- Reads, file writes, starts and stops are sent again when a proxy answers in the API's place, when the connection drops, and when the sandbox was moved to another server mid-request.
- A command is never sent twice. One that was cut off may have done part of its work, so that is yours to decide.
- A delete carries the confirm header the API asks for.

## Errors

```ts
import { ApiError, ProxyError, TimeoutError } from "agental";

try {
  await sandbox.exec("make");
} catch (error) {
  if (error instanceof ApiError && error.code === "sandbox_not_running") {
    await sandbox.start();
  } else {
    throw error;
  }
}
```

- `ApiError` is the API's own refusal, with `status`, `code` and `message`. Decide from `code`. A start refused for its burst also has `feeMicros` and `retryAfterSeconds`: see [How many you run](#how-many-you-run-and-how-fast-you-start-them).
- `ProxyError` is a 502, a 504 or any error with no code in it: something in front of the API answered, and the request may still be running.
- `ConnectionError` is the API not being reached. `TimeoutError` is a wait that ran out.

All of them are `AgentalError`.

## Webhooks

```ts
const hook = await agental.createWebhook({ url: "https://example.com/hooks/agental", events: ["sandbox.stopped", "sandbox.error"] });
hook.signingSecret; // given this once
await agental.listWebhooks(); // each with its tries of the last 30 days
await agental.getWebhook(hook.id);
await agental.updateWebhook(hook.id, { events: ["*"] }); // every event, and any added later
await agental.rotateWebhookSecret(hook.id); // a new signingSecret; the old one stops working
await agental.deleteWebhook(hook.id);
```

`events` takes the kinds of event, such as `sandbox.started`, `sandbox.stopped` and `sandbox.error`. `sandbox.auto_stop_set` is a running sandbox's stop moved: its `data` has `autoStopAt`, `previousAutoStopAt`, and `by`, `account` or `sandbox`.

Check each post your server receives:

```ts
import { verifyWebhook } from "agental";

const genuine = await verifyWebhook(rawBody, request.headers.get("x-agental-signature"), signingSecret);
```

Pass the body exactly as it arrived, before any JSON parsing.

## API keys

A key does what it was made to do and nothing else: a preset, or the actions it may do named one by one. It can be limited to some sandboxes and templates, to a date, and to the addresses it is used from.

```ts
const key = await agental.apiKeys.create({
  name: "ci-github",
  preset: "ci", // use sandboxes, make, fork and resume them, and delete the ones it made
  templateIds: ["tpl_coding_agent"], // these templates and the sandboxes on them
  allowFrom: ["203.0.113.0/24", "2001:db8::/48"], // refused from anywhere else
  expiresAt: new Date(Date.now() + 30 * 86_400_000), // optional: when it stops working
});
key.secret; // given this once

await agental.apiKeys.list(); // never with their secrets
await agental.apiKeys.get(key.id); // with when and from where it was last used
await agental.apiKeys.setAllowFrom(key.id, []); // anywhere: the one thing that changes after it is made
await agental.apiKeys.usage(key.id); // what the sandboxes it made ran, at list price
await agental.apiKeys.delete(key.id);
```

- The presets are `read-only`, `full-sandbox`, `ci` and `admin`. Send `preset` or `actions`, not both. `actions` takes names such as `sandbox.read`, `exec` and `email.send` (the type `ApiKeyAction` lists them all), or `"*"` for everything.
- `sandbox.auto-stop` reads and moves when a running sandbox is to be stopped. It is in the `full-sandbox` and `ci` presets, but not in a key made with one before it was added: a preset is written out into a key's actions when the key is made.
- A key always reaches the sandboxes it makes. One limited to several templates, none of them your default, has to name a template when it makes a sandbox, or it is refused with `template_required`.
- A key used to make another makes only a weaker one: no action, sandbox or template it lacks, no later expiry, and addresses inside its own. A stronger one is refused with `key_exceeds_caller`.
- A key is refused with `key_action_forbidden` for what it was not made to do, `key_address_forbidden` from an address not on its list, and `key_expired` once it has expired.

`allowFrom` is for keys used outside agental, such as from CI or your own servers. A sandbox reaches the API from its server's shared IPv4 address, which changes when the sandbox moves, so limit a key used inside a sandbox with `sandboxIds` instead. On a network with IPv6 the API sees your IPv6 address, so a list of IPv4 addresses alone refuses you there.

## Options

```ts
new Agental({
  apiKey: "...", // default: AGENTAL_API_KEY, then the agental command's sign-in
  baseUrl: "https://agental.io", // default: AGENTAL_API_URL, then the API the command signed in to, then this
  maxRetries: 3, // how many times a request that is safe to send again is sent again
  retryDelayMs: 1000, // the shortest wait before it is
  pollIntervalMs: 2000, // how often something waited for is looked at
  fetch: myFetch,
});
```

Every request says `User-Agent: agental-typescript/<version>`, except in a browser, which sends its own.

The full API is OpenAPI 3.1 at `https://agental.io/openapi.json`.
