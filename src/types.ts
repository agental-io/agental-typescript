import type { components, operations } from "./openapi.js";

type Schemas = components["schemas"];

/** A sandbox as the API reports it. */
export type SandboxInfo = Schemas["Sandbox"];
/** What a filter finds, counted and costed: GET /v1/sandbox-summary. Money is in millionths of a US dollar; spent is since midnight UTC. */
export type SandboxSummary = Schemas["SandboxSummary"];
/** A job that acts on many sandboxes: its state, its items counted by state, and its first problems. */
export type BulkAction = Schemas["BulkAction"];
/** The sandboxes a job would act on, fixed, and what they cost an hour before and after. */
export type BulkActionPreview = Schemas["BulkActionPreview"];
/** One sandbox of a job: its state, why, and what it made or follows. */
export interface BulkActionItem {
  id: string;
  sandboxId: string;
  state: "pending" | "acting" | "accepted" | "done" | "skipped" | "failed" | "uncertain";
  reason: string | null;
  link: Record<string, string>;
  startedAt: string | null;
  endedAt: string | null;
}
export type SandboxStatus = SandboxInfo["status"];
/**
 * When a running sandbox is to be stopped, how many seconds that is from now, and what
 * decided it: ttl for its last start and ttlSeconds, account for a move by one of its
 * account's keys or the console, sandbox for a move by the sandbox itself.
 */
export type SandboxAutoStop = Schemas["SandboxAutoStop"];
/**
 * Where to move the stop of a sandbox's run under way: to a time, which may be a Date, or a
 * number of seconds from now, 60 at the least. One of them, never both.
 */
export type SetAutoStop = { at: string | Date; inSeconds?: never } | { inSeconds: number; at?: never };
/** What a sandbox may reach outside itself: everything, nothing, or only the addresses in allow. Its template's rule with its own addresses on top. */
export type SandboxNetwork = Schemas["SandboxNetwork"];
/**
 * What a sandbox may reach outside itself, and what that comes from: its template's rule as
 * the sandbox has it, and its own addresses on top.
 */
export type SandboxNetworkDetail = Schemas["SandboxNetworkDetail"];
/** The addresses a sandbox may reach on top of its template's rule: IPv4 addresses and ranges. */
export type SandboxOwnNetwork = Schemas["SandboxOwnNetworkInput"];
/** What a sandbox on a template may reach outside itself, before its own addresses. */
export type TemplateNetwork = Schemas["TemplateNetwork"];
/** A rule to hold a template's sandboxes to: open, blocked, or allowlist with the IPv4 addresses and ranges in allow. */
export type NetworkRule = Schemas["TemplateNetworkInput"];
/** Where a sandbox's web traffic leaves: from its server (box), or through a residential address in a country. */
export type Egress = Schemas["Egress"];
/**
 * Where to send a sandbox's web traffic out: { via: "box" }, or { via: "residential",
 * country: "de", session?: "sticky" | "rotating" }. Residential is charged at $3 a GB, both
 * directions counted, and only ports 80 and 443 over TCP go through it.
 */
export type EgressInput = Schemas["EgressInput"];
/** Whether the account may send sandboxes out residential, what it still needs, and what it has spent and may spend this month. */
export type EgressAccount = Schemas["EgressAccount"];
export type Size = SandboxInfo["size"];
/** What makes a sandbox spot, and its chance of being stopped in the next minute: null on a normal sandbox. */
export type SandboxSpot = NonNullable<SandboxInfo["spot"]>;
/** A spot sandbox's settings as a create or update() gives them: what a reclaim does to it, and the chance it is warned at. */
export type SpotOptions = Schemas["SpotInput"];
/** What a command ended with. A command that failed is still an answer: read exitCode. */
export type ExecResult = Schemas["ExecResult"];
/** A command left running in the background, and its output so far. */
export type Command = Schemas["Command"];
/** A command that runs in a sandbox you keep, or in a fresh one made from a template for each run, on a timer (every, cron or at) or only when asked, with its last run. */
export type Job = Schemas["Job"];
/** One run of a job: when it was due, how it ended, what started it, and whether it started, stopped or deleted its sandbox. */
export type JobRun = Schemas["JobRun"];
/** One run of a job with the last of what its command wrote to stdout and stderr. */
export type JobRunWithOutput = Schemas["JobRunWithOutput"];
/** How a run ended, or running. */
export type JobRunOutcome = JobRun["outcome"];
/** What a new job is: the sandbox it runs in or the template of its fresh sandboxes, what it runs, and every, cron, at or none of them. */
export type CreateJob = Schemas["CreateJob"];
/** What a job runs in: a sandbox you keep ({ sandbox }), or a fresh sandbox made from a template for each run ({ template, size }). */
export type JobTarget = Schemas["JobTarget"];
/** What to change in a job. What is left out is as it was. */
export type UpdateJob = Schemas["UpdateJob"];
/** A job as jobs.put() sends it, by its name: exactly this, whatever is left out at its default. */
export type PutJob = Schemas["PutJob"];
/** A job's inputs, by name: a default, null for one a run must be given, or { default, secret }. */
export type JobInputs = NonNullable<CreateJob["inputs"]>;
/** An event that starts a job, as create(), update() and put() take it: another job's run ending ({ on: "job.run_finished", job, outcome }), or mail to a sandbox ({ on: "email.received", sandbox }). */
export type JobEvent = NonNullable<CreateJob["events"]>[number];
/** A job's HTTP address: POST to its url starts a run, from anywhere, with the secret it was made with. */
export type JobTrigger = Schemas["JobTrigger"];
/** A trigger with its secret, as jobs.triggers.create() and rotate() answer it: the secret is shown this once. */
export type JobTriggerWithSecret = Schemas["JobTriggerWithSecret"];
/** What a new trigger is: how a caller proves it may call (signature, and header for hmac-sha256), how a call is answered, and how many calls a minute it takes. */
export type CreateJobTrigger = Schemas["MakeJobTrigger"];
/** What to change in a trigger. What is left out is as it was; its secret stays. */
export type UpdateJobTrigger = Pick<CreateJobTrigger, "respond" | "ratePerMinute">;
/** How a caller proves it may call a trigger. */
export type JobTriggerSignature = JobTrigger["signature"];
/** A call of a job's address that was refused, with why: kept 7 days. */
export type RefusedJobCall = operations["listRefusedJobCalls"]["responses"][200]["content"]["application/json"]["calls"][number];
/** Running time and list cost by job over a window: GET /v1/usage/jobs. */
export type JobUsage = Schemas["JobUsage"];
export type Snapshot = Schemas["Snapshot"];
/** A port of a sandbox, and the address it is reached at. */
export type HostRoute = Schemas["HostRoute"];
/** Whether a sandbox has a desktop turned on, the size of its screen, and where it is watched. */
export type DesktopState = Schemas["DesktopState"];
/** A picture of a sandbox's screen in base64, with its media type, its size and the part of the screen it shows. */
export type DesktopScreenshot = Schemas["DesktopScreenshot"];
/** What is on a sandbox's screen as its programs tell it: its windows, and the buttons, fields, menus and texts in them, each with its place on the screen. */
export type DesktopTree = Schemas["DesktopTree"];
/** A link to a sandbox's desktop: to watch it or to use it, until it expires. */
export type DesktopLink = Schemas["DesktopLink"];
/** Whether a sandbox's browser is turned on to be driven from outside it, whether it has a window, and where to connect. */
export type BrowserState = Schemas["BrowserState"];
/** Whether SSH into a sandbox is on, and where to connect while it is: host, port, user, and the host key to pin. */
export type SshState = Schemas["SshState"];
/** A key that may log in to a sandbox as root: its id, fingerprint, type and comment. */
export type SshKey = Schemas["SshKey"];
/** A file read from a sandbox: its path, its size, when it was last changed (null for a sandbox made before that could be read), and its text or base64. */
export type FileContents = Schemas["FileContents"];
/** A file written into a sandbox: its path, its size, and when it was last changed. */
export type FileWritten = Schemas["FileWritten"];
export type FileLink = Schemas["FileLink"];
/** A folder in a sandbox and what it holds, by name. */
export type Folder = Schemas["Folder"];
/** One thing in a folder: a file, a folder, a link or something else, with its size and when it was last changed. */
export type FolderEntry = Schemas["FolderEntry"];
/** A shell kept in a sandbox: its id and number, what runs in its foreground and where, whether a terminal has it open, the bytes it has printed, and how it ended (null while it runs). */
export type KeptTerminal = Schemas["SandboxKeptTerminal"];
/** Who a key or session belongs to: the account, its role, and whether it is closed. */
export type Me = operations["getMe"]["responses"][200]["content"]["application/json"];
export type Operation = Schemas["Operation"];
/** The sizes on offer and the room there is. */
export type Catalog = Schemas["Catalog"];
/** A region sandboxes can be made in: what it is called, where its servers are, and the sizes it has room for now. */
export type Region = Schemas["Region"];
export type Usage = Schemas["Usage"];
/** Usage by UTC day, and the snapshots kept: GET /v1/usage/days. */
export type UsageDays = Schemas["UsageDays"];
/**
 * Where your account stands against its plan now: what it runs against its running count,
 * what it started in the last 15 minutes against its free starts, what it spent on burst fees this month
 * against its budget, and what one sandbox of each size would cost to start now.
 */
export type HeadroomNow = Omit<Schemas["Burst"], "quote"> & {
  /** Always null here. */
  quote: BurstQuote | null;
};
/**
 * How close your account runs to its plan's limits: where it stands now, and over a range,
 * what it ran against its running count, what it started in each 15 minutes against its free starts, each burst
 * (a stretch when it was past its free starts, so every start in it paid a fee), what
 * did not start and why, and how fast what started ran.
 */
export type Headroom = Omit<Schemas["Headroom"], "now"> & { now: HeadroomNow };
/**
 * Your account's last full month priced on every plan (GET /v1/burst/replay): the same use at list
 * price, each plan's burst fees worked out again against its free starts, and its price and included
 * credits. Your own plan is the month as charged. A plan that would have refused the month, or a
 * month whose starts were refused, has no amount. period is null where that month is not known whole.
 */
export type PlanReplay = operations["replayLastMonth"]["responses"][200]["content"]["application/json"];
/** How often headroom() reads its series: every 10 minutes, hour or day. */
export type HeadroomStep = Schemas["Headroom"]["step"];
/** The range headroom() covers. Left out, today (UTC) to now. */
export interface HeadroomRange {
  /** Where the range begins: a Date, or a time in ISO 8601. */
  from?: Date | string;
  /** Where it ends, never later than now. */
  to?: Date | string;
  /** Left out, 10m up to two days, hour up to 8, day past that. */
  step?: HeadroomStep;
}
/** What starting so many sandboxes of one size now would cost in burst fees, and when it would cost nothing. */
export type BurstQuote = Schemas["BurstQuote"];
/** What a start costs when an account starts more than its plan's free starts in 15 minutes, and the default monthly budget. */
export type BurstFee = Schemas["Prices"]["burstFee"];
/**
 * A monthly plan: its price, the credits it includes, its running count, its free starts and its sizes.
 * The API still sends sandboxesAtOnce and burst, the shape tiers had; they are not read here.
 */
export type Plan = Omit<Schemas["Prices"]["tiers"][number], "sandboxesAtOnce" | "burst">;
export type SandboxUsage = Schemas["SandboxUsage"];
/** What a sandbox read at one moment: its CPU, memory, disk and network. A figure its server did not have then is null. */
export type MetricsReading = Schemas["MetricsReading"];
/** What one sandbox read between two moments, oldest first. */
export type SandboxMetrics = Schemas["SandboxMetrics"];
/** What each of your sandboxes read at one moment. A sandbox that was stopped then has a null reading. */
export type MetricsAtMoment = Schemas["MetricsAtMoment"];
/** How many of your sandboxes were running, step by step. */
export type RunningOverTime = Schemas["RunningOverTime"];
/** Where your sandboxes' metrics and events are sent, the names of its headers, and how the last export went. */
export type Telemetry = Schemas["Telemetry"];
/** How long an account keeps its sandboxes' history, and what agental keeps besides. */
export type DataRetention = Schemas["DataRetention"];
export type AccountExport = Schemas["AccountExport"];
/** What your collector answered one empty export. */
export type TelemetryTest = Schemas["TelemetryTest"];
/** A Claude Managed Agents self-hosted environment connected to your account: its sessions' tool calls run in your sandboxes. Its key and signing secret are never shown. */
export type ClaudeConnection = Schemas["ClaudeConnection"];
/** A session of a connected environment that has run here: its sandbox, whether it runs or sleeps, and why its last turn was not served. */
export type ClaudeSession = Schemas["ClaudeSession"];
/** A repository's runs-on pool: how many sandboxes of each size it keeps, the template they are made on, and the ones it has. */
export type RunsOnRepository = Schemas["RunsOnRepository"];
/** Each repository's runs-on pool, and the size a pool keeps where none was set. */
export type RunsOnRepositories = Schemas["RunsOnRepositories"];
export type Policy = Schemas["Policy"];
/** What is sold: the hourly price of each size, the plans in tiers (the free one first), the top-ups and their bonus, storage and the free plan's terms. */
export type Prices = Omit<Schemas["Prices"], "tiers" | "volumeDiscount"> & { tiers: Plan[] };
/** Where the account stands: its plan, the free one included, what it has used of the month, what is left of its credits, and whether it may run a sandbox. */
export type Billing = Omit<Schemas["Billing"], "plan" | "discount" | "sandboxesAtOnce"> & {
  plan: Omit<NonNullable<Schemas["Billing"]["plan"]>, "sandboxesAtOnce" | "burst"> | null;
};
/** Where to send a person to pay or to save a card, or null with changed true when a plan was moved at once. */
export type Checkout = Schemas["Checkout"];
/** The auto-reload as it is now: the top-up the saved card is charged for when the credits run out, or null while it is off. */
export type AutoReload = Schemas["AutoReload"];
/** A page of the account's invoices, newest first, and the value to pass as startingAfter for the page after it, null on the last. */
export type BillingInvoices = Schemas["BillingInvoices"];
/** An invoice: its number, state, what it was for, what it came to in millionths, and the payment provider's page and PDF for it (an owner's only). */
export type BillingInvoice = Schemas["BillingInvoices"]["invoices"][number];
/** The card the account pays with now, or null where it has none: brand, last four, expiry and wallet only. */
export type BillingCard = Schemas["BillingCard"];
export type BillingDetails = Schemas["BillingDetails"];
/** Whether mail is on for a sandbox, and the domain its addresses end in. */
export type SandboxEmail = Schemas["SandboxEmail"];
/** A message as a list gives it: who it is from and for, what was made of its sender, and where a sent one has got to. */
export type EmailMessageSummary = Schemas["EmailMessageSummary"];
/** A message with its headers and what it says. What it says was written by whoever sent it, which may be anyone. */
export type EmailMessage = Schemas["EmailMessage"];
/** A page of messages, newest first, and the cursor for the page after it. */
export type EmailMessageList = Schemas["EmailMessageList"];
/** The account's mail: the handle its addresses carry, what its plan allows, and what it has had of that today. */
export type AccountEmail = Schemas["AccountEmail"];
/** A message for a sandbox to send. It goes to the address of the sandbox's own account and to no other. */
export type SendEmail = Schemas["SendEmail"];
/** A template as the API reports it: its start, its outbound rule, and the names of its variables and files, never their values. */
export type TemplateInfo = Schemas["Template"];
/**
 * A variable of a template or of a sandbox: a plain one with its value, or one kept out of
 * the sandbox with its hosts and its stand-in, never its value. hidden says which.
 */
export type SecretVariable = Schemas["SecretVariable"];
/** A variable whose commands read its value. */
export type PlainVariable = Schemas["PlainVariable"];
/**
 * A variable kept out of the sandbox: its commands see standIn, and the proxy on the
 * sandbox's server puts the value in place of the stand-in on HTTPS requests to its hosts.
 * Its value is never given back, to its owner or anyone.
 */
export type HiddenVariable = Schemas["HiddenVariable"];
/** What a sandbox made from a template starts as: its size, a snapshot or a new machine, and how many seconds it runs after each start. */
export type TemplateStart = Schemas["TemplateStart"];
/** What a sandbox made from a template is given for SSH as it is made: whether SSH is turned on, and the keys let in. */
export type TemplateSsh = Schemas["TemplateSsh"];
/** A sandbox on a template, whether it has the template as it is now, and the addresses of its own it may reach on top of the template's rule. */
export type TemplateSandbox = Schemas["TemplateSandboxes"]["sandboxes"][number];
/** The sandboxes an apply brought up to date, and those whose server did not take the template's rule, each with what went wrong. */
export type TemplateApplied = Schemas["TemplateApplied"];
/** Which template a sandbox is on, whether it is up to date with it, and the names of what it has from it. */
export type SandboxTemplate = Schemas["SandboxTemplate"];
/** An address your account's events are posted to, with its tries of the last 30 days. signingSecret is there only when it is made or given a new one. */
export type Webhook = operations["getWebhook"]["responses"][200]["content"]["application/json"];
/** One try at posting an event to a webhook: what was answered, which event it was a try of, and which try. */
export type WebhookDelivery = Webhook["deliveries"][number];
/** An API key as the API reports it: what it may do, which sandboxes and templates it reaches, until when, and from where. Never its secret. */
export type ApiKey = Schemas["ApiKey"];
/** A key just made, with its secret in secret. The secret is given this once, and only its hash is kept. */
export type CreatedApiKey = Schemas["CreatedApiKey"];
/** Something a key may be made to do, such as sandbox.read, exec or email.send, or "*" for everything, now and later. */
export type ApiKeyAction = ApiKey["actions"][number];
/** A named set of actions a key can be made with: read-only, full-sandbox, ci or admin. */
export type ApiKeyPreset = NonNullable<ApiKey["preset"]>;
/**
 * What a key is made with: a name, a preset or the actions named, never both, and what
 * limits it. expiresAt may be a Date.
 */
export type CreateApiKey = Omit<Schemas["CreateApiKey"], "preset" | "actions" | "expiresAt"> & { expiresAt?: string | Date } & (
    | { preset: ApiKeyPreset; actions?: never }
    | { actions: ApiKeyAction[]; preset?: never }
  );
/** An organization the key's person is in, with their role in it: their own, or a team. */
export type Organization = operations["listOrganizations"]["responses"][200]["content"]["application/json"]["organizations"][number];
/** A team, with the caller's role in it. */
export type Team = Schemas["Team"];
/** Someone in a team, with their role and when they were added. */
export type Member = Schemas["Member"];
/** An invitation to a team, open for seven days. */
export type Invite = Schemas["Invite"];
/** A role in a team. An owner is made from a member who is there; an invite asks for member or admin. */
export type TeamRole = Member["role"];
/** Running time of the sandboxes one key made, and what it comes to at the list price. */
export type ApiKeyUsage = Schemas["ApiKeyUsage"];
