import { Http, sleep, type AgentalOptions } from "./http.js";
import { CREATE_TIMEOUT_MS, Email, iso, made, makeSandbox, Sandbox, type CreateOptions } from "./sandbox.js";
import { Templates } from "./template.js";
import type {
  AccountEmail,
  AccountExport,
  ApiKey,
  ApiKeyUsage,
  Billing,
  Headroom,
  HeadroomNow,
  HeadroomRange,
  Catalog,
  HostRoute,
  Invite,
  Me,
  Member,
  Organization,
  Region,
  AutoReload,
  BillingCard,
  BillingDetails,
  BillingInvoice,
  BillingInvoices,
  Checkout,
  DataRetention,
  CreateApiKey,
  CreatedApiKey,
  MetricsAtMoment,
  Policy,
  Prices,
  RunningOverTime,
  SandboxInfo,
  SandboxSummary,
  BulkAction,
  BulkActionItem,
  BulkActionPreview,
  Snapshot,
  Team,
  TeamRole,
  Telemetry,
  TelemetryTest,
  ClaudeConnection,
  ClaudeSession,
  RunsOnRepository,
  RunsOnRepositories,
  Usage,
  Webhook,
  EgressAccount,
  CreateJob,
  Job,
  JobRun,
  JobRunOutcome,
  JobRunWithOutput,
  JobUsage,
  PutJob,
  UpdateJob,
  JobTrigger,
  JobTriggerWithSecret,
  CreateJobTrigger,
  UpdateJobTrigger,
  RefusedJobCall,
} from "./types.js";

/** What a list of sandboxes is narrowed to. Each field left out narrows nothing; a list of values is any of them. */
export interface SandboxFilter {
  /** Tags every sandbox has. */
  tag?: string | readonly string[];
  /** Tags no sandbox has. */
  notTag?: string | readonly string[];
  /** creating, running, stopped, error, restoring or migrating. */
  status?: string | readonly string[];
  /** true for only archived sandboxes, false for none. */
  archived?: boolean;
  size?: string | readonly string[];
  region?: string | readonly string[];
  templateId?: string | readonly string[];
  /** Who made them, as createdBy says it. */
  createdBy?: string | readonly string[];
  createdAfter?: string | Date;
  createdBefore?: string | Date;
  stoppedBefore?: string | Date;
  /** Their autoStopAt is before this. */
  stopsBefore?: string | Date;
  /** never: they have no autoStopAt. */
  stops?: "never";
  memoryKept?: boolean;
  /** open, blocked or allowlist. */
  outbound?: string | readonly string[];
  /** What they are doing: low-cpu, disk-full, memory-full, agent-silent or not-read. Any of them. */
  activity?: string | readonly string[];
  /** None of these. */
  notActivity?: string | readonly string[];
  /** Each key at this value; "*" for any value, the key being set. */
  metadata?: Record<string, string>;
  /** No key at this value; "*" for the key not being set. */
  notMetadata?: Record<string, string>;
  /** Text found in the name or the id, case ignored. */
  text?: string;
}

/** How a page of sandboxes is sorted. Only created and -created keep a walk through the pages exact while sandboxes change. */
export type SandboxSort = "created" | "-created" | "name" | "-name" | "status" | "-status" | "stopped" | "-stopped" | "cost" | "-cost" | "-cpu" | "-memory" | "-disk";

/** A page of sandboxes, and what to pass as cursor for the next one: null when this is the last. */
export interface SandboxPage {
  sandboxes: Sandbox[];
  nextCursor: string | null;
}

/** A filter as GET /v1/sandboxes and /v1/sandbox-summary take it. */
function filterQuery(filter: SandboxFilter): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const many = (name: string, value: string | readonly string[] | undefined) => {
    if (value !== undefined) {
      query[name] = typeof value === "string" ? value : [...value];
    }
  };
  const time = (value: string | Date | undefined) => (value instanceof Date ? value.toISOString() : value);
  many("tag", filter.tag);
  many("notTag", filter.notTag);
  many("status", filter.status);
  many("size", filter.size);
  many("region", filter.region);
  many("templateId", filter.templateId);
  many("createdBy", filter.createdBy);
  many("outbound", filter.outbound);
  many("activity", filter.activity);
  many("notActivity", filter.notActivity);
  many("createdAfter", time(filter.createdAfter));
  many("createdBefore", time(filter.createdBefore));
  many("stoppedBefore", time(filter.stoppedBefore));
  many("stopsBefore", time(filter.stopsBefore));
  many("stops", filter.stops);
  many("q", filter.text);
  if (filter.archived !== undefined) {
    query["archived"] = String(filter.archived);
  }
  if (filter.memoryKept !== undefined) {
    query["memoryKept"] = String(filter.memoryKept);
  }
  for (const [key, value] of Object.entries(filter.metadata ?? {})) {
    query[`metadata[${key}]`] = value;
  }
  for (const [key, value] of Object.entries(filter.notMetadata ?? {})) {
    query[`notMetadata[${key}]`] = value;
  }
  return query;
}

/** What a job does to each sandbox, and how. */
export type BulkActionType = "stop" | "start" | "archive" | "snapshot" | "auto-stop" | "labels" | "delete";
export interface BulkActionOptions {
  /** For stop: keep their memory too. */
  keepMemory?: boolean;
  /** For snapshot: its name. */
  name?: string;
  /** For auto-stop: when to stop, or null to take the time limit away. */
  at?: string | Date | null;
  /** For auto-stop: seconds from now, fixed to a time when the job is made. */
  inSeconds?: number;
  /** For labels: own tags to add and take away, own metadata to set (null takes a key away). */
  addTags?: string[];
  removeTags?: string[];
  metadata?: Record<string, string | null>;
}

/**
 * Jobs that act on many sandboxes at once. A preview fixes the sandboxes a filter finds; a job
 * acts on exactly those, checking each again just before, and on no other.
 */
class BulkActions {
  constructor(private readonly http: Http) {}

  /** The sandboxes a job would act on, fixed, with how many, the first of them, and the money before and after. Nothing is done. */
  async preview(action: BulkActionType, select: { filter: SandboxFilter } | { ids: readonly string[] }, options: BulkActionOptions = {}): Promise<BulkActionPreview> {
    const body = {
      action,
      options: jobOptions(options),
      select: "ids" in select ? { ids: [...select.ids] } : { filter: filterQuery(select.filter) },
    };
    return (await this.http.json<BulkActionPreview>({ method: "POST", path: "/v1/bulk-actions/preview", body })).body;
  }

  /**
   * Makes a job from a preview, or from sandbox IDs named outright. Sent again with the same
   * idempotencyKey, the same job is answered.
   */
  async create(
    from: { previewId: string; confirm?: number } | { action: BulkActionType; ids: readonly string[]; options?: BulkActionOptions; confirm?: number },
    options: { idempotencyKey?: string } = {},
  ): Promise<BulkAction> {
    // A delete is made with confirm: the count its preview showed.
    const confirm = from.confirm === undefined ? {} : { confirm: from.confirm };
    const body = "previewId" in from ? { previewId: from.previewId, ...confirm } : { action: from.action, ids: [...from.ids], options: jobOptions(from.options ?? {}), ...confirm };
    const key = options.idempotencyKey ?? `sdk-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    return (await this.http.json<BulkAction>({ method: "POST", path: "/v1/bulk-actions", body, headers: { "Idempotency-Key": key }, replay: true })).body;
  }

  async get(id: string): Promise<BulkAction> {
    return (await this.http.json<BulkAction>({ method: "GET", path: `/v1/bulk-actions/${encodeURIComponent(id)}`, replay: true })).body;
  }

  /** The organization's last 50 jobs, the newest first. */
  async list(): Promise<BulkAction[]> {
    return (await this.http.json<{ actions: BulkAction[] }>({ method: "GET", path: "/v1/bulk-actions", replay: true })).body.actions;
  }

  /** A page of a job's items, in order, each with its state, why, and what it made or follows. */
  async items(id: string, options: { state?: string; limit?: number; cursor?: string } = {}): Promise<{ items: BulkActionItem[]; nextCursor: string | null }> {
    const query: Record<string, string> = {};
    if (options.state) query["state"] = options.state;
    if (options.limit !== undefined) query["limit"] = String(options.limit);
    if (options.cursor) query["cursor"] = options.cursor;
    return (await this.http.json<{ items: BulkActionItem[]; nextCursor: string | null }>({ method: "GET", path: `/v1/bulk-actions/${encodeURIComponent(id)}/items`, query, replay: true })).body;
  }

  /** No item that has not begun begins; those under way are followed to their end. */
  async cancel(id: string): Promise<BulkAction> {
    return (await this.http.json<BulkAction>({ method: "POST", path: `/v1/bulk-actions/${encodeURIComponent(id)}/cancel`, replay: true })).body;
  }

  /** Reads the job until it has ended, telling onProgress each time, and answers it ended. */
  async wait(id: string, options: { onProgress?: (job: BulkAction) => void; signal?: AbortSignal } = {}): Promise<BulkAction> {
    for (;;) {
      const job = await this.get(id);
      options.onProgress?.(job);
      if (job.state !== "running") {
        return job;
      }
      await sleep(this.http.pollIntervalMs, options.signal);
    }
  }
}

function jobOptions(options: BulkActionOptions): Record<string, unknown> {
  const { at, ...rest } = options;
  return { ...rest, ...(at === undefined ? {} : { at: at instanceof Date ? at.toISOString() : at }) };
}

/** What jobs.run() and jobs.runAgain() wait for: left out, they answer as the run begins. */
export interface JobRunOptions {
  /** Seconds to wait for the run to end, reading it until it has, and to answer it with its output. */
  wait?: number;
  /** Stops the wait early. */
  signal?: AbortSignal;
}

/** What jobs.run() gives the run: values for the job's inputs, by name, over their defaults. */
export interface JobRunInputs {
  inputs?: Record<string, string>;
}

/** What jobs.put() answers: the job as it is now, whether it was made, and whether it changed. */
export interface JobPut {
  job: Job;
  /** It was not there, and was made. */
  created: boolean;
  /** It was made, or changed; false where it was this already. */
  changed: boolean;
}

/**
 * The most seconds a call asks the API to hold it for a run to end: the API holds one 90 seconds
 * at most, as the proxy in front of it gives up at 100. The rest of a longer wait is spent reading
 * the run.
 */
const HELD_SECONDS = 90;

/**
 * Commands that run in a sandbox on a timer: every so many minutes, hours or days, as a cron
 * expression says in a time zone, once at a time, or only when asked. The API keeps them, so a
 * run that finds its sandbox stopped starts it, by default, and stops it again when the command
 * ends, keeping its disk. A job on fresh sandboxes makes one from a template for each run
 * instead, and deletes it after a run that succeeds. Each takes the job's id or its name.
 */
class Jobs {
  /** A job's HTTP addresses: each starts a run when it is called, from anywhere, with its secret. */
  readonly triggers: JobTriggers;

  constructor(private readonly http: Http) {
    this.triggers = new JobTriggers(http);
  }

  /**
   * Makes a job: the sandbox it runs in (target.sandbox, its id or name), or a template to make a
   * fresh sandbox from for each run (target.template, its id or name, and target.size, else the
   * template's); what it runs, through
   * sh -c, and every ("15m", "1h", "1d"), cron ("0 7 * * 1-5", in timeZone), at, once
   * ("2026-11-04T09:00:00Z"), or none of them for one that runs only when asked. A run gets
   * 600000 ms unless timeoutMs says, up to six hours. One that may start the sandbox needs a key
   * that may start and stop it; ifStopped "skip" runs only while it runs. after "delete", with at
   * only, deletes the sandbox once the run's command exits 0, and needs a key that may delete it.
   * A fresh run's sandbox is deleted after a run that succeeds; after one that fails it is kept,
   * stopped, for keepFailedFor ("0", "30m", "24h" by default, up to "7d"), then deleted, unless
   * keepSandbox() keeps it for good. ifStopped and after are for a sandbox you keep only.
   * retries (0 to 5, 0 by default) tries a run that failed or ran out of time again, after 30
   * seconds, then 2 minutes, 8, 32 and about 2 hours, each try a run of its own with its attempt;
   * the last fails for good (failedForGood). alerts says who is told when a run fails for good and
   * when the job works again: "email" by default, its maker and the organization's owners and
   * admins; "webhook", the events job.run_failed and job.recovered; "both"; or "none". failingSince
   * says since when a job has been failing, null while it works. maxMonthlySpendMicros (from
   * 10000, $0.01) is the most its runs may cost in a calendar month (UTC), at the list price of the
   * running time they cause: reached, the job pauses itself, says why in pausedReason, and mails as
   * alerts says; spentThisMonthMicros is what they cost so far. Null, the default: no limit.
   */
  async create(job: CreateJob): Promise<Job> {
    return (await this.http.json<Job>({ method: "POST", path: "/v1/jobs", body: job })).body;
  }

  /**
   * The organization's jobs, oldest first, each with its last run; with sandbox, only those that
   * run in it, and with template, only those that make their fresh sandboxes from it (each by its
   * id or name).
   */
  async list(options: { sandbox?: string; template?: string } = {}): Promise<Job[]> {
    return (await this.http.json<{ jobs: Job[] }>({ method: "GET", path: "/v1/jobs", query: { sandbox: options.sandbox, template: options.template }, replay: true })).body.jobs;
  }

  /** A job, with its next run and its last. */
  async get(idOrName: string): Promise<Job> {
    return (await this.http.json<Job>({ method: "GET", path: this.path(idOrName), replay: true })).body;
  }

  /** Changes a job. What is left out is as it was; enabled false pauses it, and drops a retry that waits. */
  async update(idOrName: string, changes: UpdateJob): Promise<Job> {
    return (await this.http.json<Job>({ method: "PATCH", path: this.path(idOrName), body: changes, replay: true })).body;
  }

  /** Pauses a job: it does not run on its timer until resumed. A run under way goes on to its end. */
  async pause(idOrName: string): Promise<Job> {
    return await this.update(idOrName, { enabled: false });
  }

  /** Resumes a paused job, clearing why it paused itself. */
  async resume(idOrName: string): Promise<Job> {
    return await this.update(idOrName, { enabled: true });
  }

  /** Deletes a job and its runs. A run under way goes on to its end. */
  async delete(idOrName: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: this.path(idOrName), replay: true });
  }

  /**
   * Makes the job of this name, or changes it to exactly this body: whatever it leaves out goes
   * back to its default, as on a new job. The same body twice changes nothing. Answers the job,
   * whether it was made (created), and whether it changed: what agental job apply does for each
   * job of a file.
   */
  async put(name: string, job: PutJob): Promise<JobPut> {
    const answer = await this.http.json<Job>({ method: "PUT", path: this.path(name), body: job, replay: true });
    const created = answer.status === 201;
    return { job: answer.body, created, changed: created || answer.headers.get("agental-changed") !== "false" };
  }

  /**
   * Makes a run now, by the job's own rules, paused or not; its next run does not move. inputs
   * gives values for the job's inputs over their defaults; one it does not name is refused with
   * unknown_input, and one it needs and was not given with input_required. Without wait it
   * answers as the run begins. With wait, in seconds, the API holds the call until the run ends,
   * and after that it is read until it has ended or the wait runs out; it answers the run as it
   * last read it, with its stdout and stderr: read finishedAt to know which.
   */
  async run(idOrName: string): Promise<JobRun>;
  async run(idOrName: string, options: JobRunOptions & JobRunInputs & { wait: number }): Promise<JobRunWithOutput>;
  async run(idOrName: string, options?: JobRunOptions & JobRunInputs): Promise<JobRun | JobRunWithOutput>;
  async run(idOrName: string, options: JobRunOptions & JobRunInputs = {}): Promise<JobRun | JobRunWithOutput> {
    return await this.made(`${this.path(idOrName)}/run`, options.inputs === undefined ? undefined : { inputs: options.inputs }, options);
  }

  /**
   * Runs the job again now with what one of its runs was given, its secret inputs too; an input
   * the job no longer names is left out. wait is as run() takes it.
   */
  async runAgain(idOrName: string, runId: string): Promise<JobRun>;
  async runAgain(idOrName: string, runId: string, options: JobRunOptions & { wait: number }): Promise<JobRunWithOutput>;
  async runAgain(idOrName: string, runId: string, options?: JobRunOptions): Promise<JobRun | JobRunWithOutput>;
  async runAgain(idOrName: string, runId: string, options: JobRunOptions = {}): Promise<JobRun | JobRunWithOutput> {
    return await this.made(`${this.path(idOrName)}/runs/${encodeURIComponent(runId)}/again`, undefined, options);
  }

  /** A run made at path: answered as it begins, or, with wait, held by the API and then read until it ends or the wait runs out. */
  private async made(path: string, body: unknown, options: JobRunOptions): Promise<JobRun | JobRunWithOutput> {
    const deadline = options.wait === undefined ? 0 : Date.now() + options.wait * 1000;
    const held = options.wait === undefined ? undefined : Math.max(0, Math.min(HELD_SECONDS, Math.floor(options.wait)));
    const answer = await this.http.json<JobRun | JobRunWithOutput>({
      method: "POST",
      path,
      ...(held === undefined ? {} : { query: { wait: String(held) } }),
      ...(body === undefined ? {} : { body }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // 200 is the run ended within the wait, with its output.
    if (options.wait === undefined || answer.status === 200) {
      return answer.body;
    }
    const started = answer.body;
    for (;;) {
      const run = await this.runOutput(started.jobId, started.id);
      if (run.finishedAt !== null || Date.now() + this.http.pollIntervalMs >= deadline) {
        return run;
      }
      await sleep(this.http.pollIntervalMs, options.signal);
    }
  }

  /**
   * Its runs, the latest first: 100 unless limit says, at most 500. Each try of a run its retries
   * make is a run of its own: attempt is 1 for the first, and failedForGood marks the one with no
   * tries left.
   */
  async runs(idOrName: string, options: { limit?: number } = {}): Promise<JobRun[]> {
    return (await this.http.json<{ runs: JobRun[] }>({ method: "GET", path: `${this.path(idOrName)}/runs`, query: { limit: options.limit?.toString() }, replay: true })).body.runs;
  }

  /**
   * One run, with the last 262,144 characters its command wrote to stdout and to stderr;
   * stdoutCut and stderrCut say where that is the end of more.
   */
  async runOutput(idOrName: string, runId: string): Promise<JobRunWithOutput> {
    return (await this.http.json<JobRunWithOutput>({ method: "GET", path: `${this.path(idOrName)}/runs/${encodeURIComponent(runId)}`, replay: true })).body;
  }

  /**
   * Keep it: makes the sandbox of a failed fresh run, kept stopped until keepUntil, an ordinary
   * sandbox of yours, out of the job: it is no longer deleted when keepFailedFor passes. Answers
   * the run, with sandboxKept true. A run in a sandbox you keep is refused with not_fresh, one
   * still running with run_running, and one whose sandbox is gone with sandbox_gone.
   */
  async keepSandbox(idOrName: string, runId: string): Promise<JobRun> {
    return (await this.http.json<JobRun>({ method: "POST", path: `${this.path(idOrName)}/runs/${encodeURIComponent(runId)}/keep-sandbox`, replay: true })).body;
  }

  /**
   * The calls of the job's addresses that were refused in the last 7 days, the latest first, 100
   * at most, each with why: a secret or signature that was not right, too many calls, the job
   * paused, an input it needs not given. What answers "my webhook did not fire".
   */
  async calls(idOrName: string): Promise<RefusedJobCall[]> {
    return (await this.http.json<{ calls: RefusedJobCall[] }>({ method: "GET", path: `${this.path(idOrName)}/calls`, replay: true })).body.calls;
  }

  /** Running time and list cost by job, for the runs due in a window: this month in UTC unless since and until say. */
  async usage(window: { since?: string | Date; until?: string | Date } = {}): Promise<JobUsage> {
    return (await this.http.json<JobUsage>({ method: "GET", path: "/v1/usage/jobs", query: { since: iso(window.since), until: iso(window.until) }, replay: true })).body;
  }

  private path(idOrName: string): string {
    return `/v1/jobs/${encodeURIComponent(idOrName)}`;
  }
}

/**
 * A job's HTTP addresses. POST to a trigger's url starts a run of its job, from anywhere, with no
 * API key: the caller sends the trigger's secret as Authorization: Bearer, or signs the body with
 * it as GitHub (X-Hub-Signature-256), Stripe (Stripe-Signature) or any sender of an HMAC-SHA256
 * header does. The fields of a JSON body that the job names in its inputs are given to the run,
 * and the whole request is a file its command reads at $AGENTAL_REQUEST. A run a call starts has
 * startedBy "http". Each takes the job's id or its name.
 */
class JobTriggers {
  constructor(private readonly http: Http) {}

  /** The job's triggers, oldest first. Their secrets are never shown again. */
  async list(idOrName: string): Promise<JobTrigger[]> {
    return (await this.http.json<{ triggers: JobTrigger[] }>({ method: "GET", path: this.path(idOrName), replay: true })).body.triggers;
  }

  /**
   * Gives the job an HTTP address: signature "bearer" unless given ("github", "stripe" or
   * "hmac-sha256", whose header is X-Signature unless given); respond "accepted", answered at
   * once with the run's id, or "wait", held until the run ends, up to 60 seconds; ratePerMinute 60
   * unless given, 600 at most. Answers it with its secret, which is shown this once: keep it.
   * Needs a key that may change the job.
   */
  async create(idOrName: string, trigger: CreateJobTrigger = {}): Promise<JobTriggerWithSecret> {
    return (await this.http.json<JobTriggerWithSecret>({ method: "POST", path: this.path(idOrName), body: trigger })).body;
  }

  /** Changes how a trigger answers and how many calls a minute it takes. Its address and its secret stay. */
  async update(idOrName: string, triggerId: string, changes: UpdateJobTrigger): Promise<JobTrigger> {
    return (await this.http.json<JobTrigger>({ method: "PATCH", path: `${this.path(idOrName)}/${encodeURIComponent(triggerId)}`, body: changes, replay: true })).body;
  }

  /** Gives a trigger a new secret, at once: the old one no longer calls it. Its address stays. Answers the new secret, shown this once. */
  async rotate(idOrName: string, triggerId: string): Promise<JobTriggerWithSecret> {
    return (await this.http.json<JobTriggerWithSecret>({ method: "POST", path: `${this.path(idOrName)}/${encodeURIComponent(triggerId)}/rotate` })).body;
  }

  /** Deletes a trigger: its address no longer starts a run. */
  async delete(idOrName: string, triggerId: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `${this.path(idOrName)}/${encodeURIComponent(triggerId)}`, replay: true });
  }

  private path(idOrName: string): string {
    return `/v1/jobs/${encodeURIComponent(idOrName)}/triggers`;
  }
}

class Sandboxes {
  constructor(private readonly http: Http) {}

  /**
   * Makes a sandbox and waits until it is running. If the create fails part way or its
   * answer is lost, it is sent again with the same key, which gives the same machine back
   * and never a second one. What it paid in burst fees is in the sandbox's burstFeeMicros.
   */
  async create(options: CreateOptions = {}): Promise<Sandbox> {
    const body = {
      name: options.name ?? made("sbx"),
      ...(options.template ? { templateId: typeof options.template === "string" ? options.template : options.template.id } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.region === undefined ? {} : Array.isArray(options.region) ? { regions: options.region } : { region: options.region }),
      ...(options.snapshotId !== undefined ? { snapshotId: options.snapshotId } : {}),
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.onTimeout !== undefined ? { onTimeout: options.onTimeout } : {}),
      ...(options.network ? { network: options.network } : {}),
      ...(options.egress ? { egress: options.egress } : {}),
      ...(options.sshKeys !== undefined ? { sshKeys: options.sshKeys } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    };
    const { info, burstFeeMicros } = await makeSandbox(this.http, "/v1/sandboxes", body, options.idempotencyKey ?? made("sdk"), options.timeoutMs ?? CREATE_TIMEOUT_MS, options);
    return new Sandbox(this.http, info, burstFeeMicros);
  }

  /** One of your sandboxes, by its id. */
  async get(id: string): Promise<Sandbox> {
    const { body } = await this.http.json<SandboxInfo>({ method: "GET", path: `/v1/sandboxes/${encodeURIComponent(id)}`, replay: true });
    return new Sandbox(this.http, body);
  }

  /**
   * Every sandbox of yours that matches the filter, stopped ones included, oldest first. With
   * no filter, every sandbox. It reads a page of 200 at a time and follows them to the end.
   * Tags and metadata are judged as the sandbox shows them: its template's count, and its own
   * value for a key wins over its template's.
   */
  async list(filter: SandboxFilter = {}): Promise<Sandbox[]> {
    const found: Sandbox[] = [];
    let cursor: string | null = null;
    do {
      const page: SandboxPage = await this.page(filter, { limit: 200, ...(cursor === null ? {} : { cursor }) });
      found.push(...page.sandboxes);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return found;
  }

  /**
   * One page of the sandboxes that match the filter: up to limit of them, and nextCursor to pass
   * as cursor, with the same sort, for the page after it. Sorted by anything but created, a
   * sandbox that changes while the pages are read can be missed or met twice.
   */
  async page(filter: SandboxFilter = {}, options: { sort?: SandboxSort; limit?: number; cursor?: string } = {}): Promise<SandboxPage> {
    const query = filterQuery(filter);
    const many = (name: string, value: string | undefined) => {
      if (value !== undefined) {
        query[name] = value;
      }
    };
    many("sort", options.sort);
    many("limit", options.limit === undefined ? undefined : String(options.limit));
    many("cursor", options.cursor);
    const { body } = await this.http.json<{ sandboxes: SandboxInfo[]; nextCursor?: string | null }>({ method: "GET", path: "/v1/sandboxes", query, replay: true });
    // An API from before pages answers every sandbox at once, and no nextCursor.
    return { sandboxes: body.sandboxes.map((info) => new Sandbox(this.http, info)), nextCursor: body.nextCursor ?? null };
  }

  /**
   * How many sandboxes the filter finds and what they cost: an hour as each is charged now, and
   * since midnight UTC today; what the running among them would cost stopped; and, for each field
   * in facets (status, size, region, templateId, tag, outbound, metadataKeys, metadata.<key>), the
   * count and hourly cost of each value. Money is in millionths of a US dollar. Spent is for the
   * sandboxes found, not the account: the account's whole month is on billing.
   */
  async summary(filter: SandboxFilter = {}, options: { facets?: readonly string[] } = {}): Promise<SandboxSummary> {
    const query = filterQuery(filter);
    if (options.facets !== undefined && options.facets.length > 0) {
      query["facets"] = options.facets.join(",");
    }
    const { body } = await this.http.json<SandboxSummary>({ method: "GET", path: "/v1/sandbox-summary", query, replay: true });
    return body;
  }

  /**
   * The mail of one sandbox, by the sandbox's id, without reading the sandbox. It asks
   * nothing by itself. It is the way in for a key made with only email.read and
   * email.send on this sandbox, which may read and send its mail and is refused
   * everything else, get(id) included.
   */
  email(id: string): Email {
    return new Email(this.http, `/v1/sandboxes/${encodeURIComponent(id)}/email`);
  }
}

class Snapshots {
  constructor(private readonly http: Http) {}

  /** Every snapshot you have, those of sandboxes since deleted included. */
  async list(): Promise<Snapshot[]> {
    return (await this.http.json<{ snapshots: Snapshot[] }>({ method: "GET", path: "/v1/snapshots", replay: true })).body.snapshots;
  }

  async get(id: string): Promise<Snapshot> {
    return (await this.http.json<Snapshot>({ method: "GET", path: `/v1/snapshots/${encodeURIComponent(id)}`, replay: true })).body;
  }

  async delete(id: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/v1/snapshots/${encodeURIComponent(id)}` });
  }
}

/**
 * Your API keys. A key may do what it was made to do and nothing else, and a key used to
 * make one makes only a weaker one. Using any of these takes a key with key.manage.
 */
class ApiKeys {
  constructor(private readonly http: Http) {}

  /** Every key of the account, oldest first. Their secrets are never given. */
  async list(): Promise<ApiKey[]> {
    return (await this.http.json<{ apiKeys: ApiKey[] }>({ method: "GET", path: "/v1/api-keys", replay: true })).body.apiKeys;
  }

  async get(id: string): Promise<ApiKey> {
    return (await this.http.json<ApiKey>({ method: "GET", path: this.path(id), replay: true })).body;
  }

  /**
   * Makes a key with a preset, or with the actions named, and limited by the rest: to some
   * sandboxes and templates, until expiresAt, and to the addresses in allowFrom. The
   * answer holds secret, the one time it is given. It is sent once, so a lost answer is
   * not sent again.
   */
  async create(key: CreateApiKey): Promise<CreatedApiKey> {
    // What is left out is not sent: JSON has no undefined.
    const body = { ...key, expiresAt: iso(key.expiresAt) };
    return (await this.http.json<CreatedApiKey>({ method: "POST", path: "/v1/api-keys", body })).body;
  }

  /**
   * Replaces the addresses and ranges a key may be used from, from its next request. It is
   * the one thing about a key that changes after it is made. An empty list is anywhere.
   */
  async setAllowFrom(id: string, allowFrom: string[]): Promise<ApiKey> {
    return (await this.http.json<ApiKey>({ method: "PUT", path: `${this.path(id)}/allow-from`, body: { allowFrom }, replay: true })).body;
  }

  /** Deletes a key. Whatever holds it is refused from its next request, and the sandboxes it made stay the account's. */
  async delete(id: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: this.path(id) });
  }

  /** How long the sandboxes a key made ran, and what that comes to at the list price. Without since, everything they ever ran. */
  async usage(id: string, window: { since?: string | Date; until?: string | Date } = {}): Promise<ApiKeyUsage> {
    const query = { since: iso(window.since), until: iso(window.until) };
    return (await this.http.json<ApiKeyUsage>({ method: "GET", path: `${this.path(id)}/usage`, query, replay: true })).body;
  }

  private path(id: string): string {
    return `/v1/api-keys/${encodeURIComponent(id)}`;
  }
}

/**
 * The organizations the key's person is in, and the team the key acts in. A key acts in the
 * organization it was made in, for good: its person's own or a team. What a key may do of a
 * team's is held by its actions, members.read and members.admin (or account.read and
 * account.admin), and by its person's role in the team.
 */
class Organizations {
  constructor(private readonly http: Http) {}

  /** Every organization the key's person is in, with their role in each, their own first. */
  async list(): Promise<Organization[]> {
    return (await this.http.json<{ organizations: Organization[] }>({ method: "GET", path: "/v1/organizations", replay: true })).body.organizations;
  }

  /** The one the key acts in. */
  async current(): Promise<Organization> {
    const [list, me] = await Promise.all([this.list(), this.http.json<Me>({ method: "GET", path: "/v1/me", replay: true })]);
    const found = list.find((organization) => organization.id === me.body.activeOrganizationId);
    if (!found) {
      throw new Error(`The key acts in ${me.body.activeOrganizationId}, which is not among its person's organizations.`);
    }
    return found;
  }

  /**
   * Makes a team, with the key's person as its owner. The key goes on acting where it was made:
   * a key for the team is made in the console, or with the CLI's agental org use.
   */
  async createTeam(name: string): Promise<Team> {
    return (await this.http.json<{ organization: Team }>({ method: "POST", path: "/v1/organizations", body: { kind: "team", name } })).body.organization;
  }

  /** Renames a team. Only an owner does. */
  async rename(id: string, name: string): Promise<Team> {
    return (await this.http.json<Team>({ method: "PATCH", path: this.path(id), body: { name }, replay: true })).body;
  }

  /** A team's members, the earliest first. Every member reads them. */
  async members(id: string): Promise<Member[]> {
    return (await this.http.json<{ members: Member[] }>({ method: "GET", path: `${this.path(id)}/members`, replay: true })).body.members;
  }

  /** Changes a member's role: an owner any, an admin up to admin and never an owner's. */
  async setRole(id: string, userId: string, role: TeamRole): Promise<TeamRole> {
    const path = `${this.path(id)}/members/${encodeURIComponent(userId)}`;
    return (await this.http.json<{ userId: string; role: TeamRole }>({ method: "PATCH", path, body: { role }, replay: true })).body.role;
  }

  /**
   * Removes a member, or the key's person themself. The keys they made in the team go on
   * working, as a member's, unless revokeKeys revokes them in the same request.
   */
  async removeMember(id: string, userId: string, options: { revokeKeys?: boolean } = {}): Promise<{ revokedKeys: number }> {
    const path = `${this.path(id)}/members/${encodeURIComponent(userId)}`;
    const query = options.revokeKeys ? { revokeKeys: "true" } : {};
    return (await this.http.json<{ revokedKeys: number }>({ method: "DELETE", path, query })).body;
  }

  /** The invites of the team the key acts in, for its owners and admins. */
  async invites(): Promise<Invite[]> {
    return (await this.http.json<{ invites: Invite[] }>({ method: "GET", path: "/v1/invites", replay: true })).body.invites;
  }

  /** Invites an email address to the team the key acts in, as a member or an admin. The team's plan has to allow members. */
  async invite(email: string, options: { role?: "member" | "admin" } = {}): Promise<Invite> {
    return (await this.http.json<Invite>({ method: "POST", path: "/v1/invites", body: { email, role: options.role ?? "member" } })).body;
  }

  /** Revokes an open invite: its link answers 410 from then on. */
  async revokeInvite(inviteId: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/v1/invites/${encodeURIComponent(inviteId)}` });
  }

  private path(id: string): string {
    return `/v1/organizations/${encodeURIComponent(id)}`;
  }
}

/**
 * The agental API.
 *
 * ```ts
 * const agental = new Agental(); // reads AGENTAL_API_KEY
 * const sandbox = await agental.sandboxes.create();
 * const { stdout } = await sandbox.exec("uname -a");
 * await sandbox.delete();
 * ```
 */
export class Agental {
  readonly sandboxes: Sandboxes;
  readonly snapshots: Snapshots;
  /** What sandboxes are made as and held to: a start, the variables and files every sandbox on one gets, and what it may reach. */
  readonly templates: Templates;
  /** The account's API keys: what each may do, which sandboxes and templates it reaches, until when, and from where. */
  readonly apiKeys: ApiKeys;
  /** The organizations the key's person is in, and the members and invites of a team. */
  readonly organizations: Organizations;
  /** Actions on many sandboxes at once: a preview fixes the set, a bulk action acts on exactly it. */
  readonly bulkActions: BulkActions;
  /** Commands that run in a sandbox on a timer, or when asked. */
  readonly jobs: Jobs;
  private readonly http: Http;

  constructor(options: AgentalOptions = {}) {
    this.http = new Http(options);
    this.sandboxes = new Sandboxes(this.http);
    this.snapshots = new Snapshots(this.http);
    this.templates = new Templates(this.http);
    this.apiKeys = new ApiKeys(this.http);
    this.organizations = new Organizations(this.http);
    this.bulkActions = new BulkActions(this.http);
    this.jobs = new Jobs(this.http);
  }

  /** Every job's runs in the organization, the latest first: 100 unless limit says, at most 500; job (its id or name) and outcome narrow them. */
  async jobRuns(options: { limit?: number; job?: string; outcome?: JobRunOutcome } = {}): Promise<JobRun[]> {
    const query = { limit: options.limit?.toString(), job: options.job, outcome: options.outcome };
    return (await this.http.json<{ runs: JobRun[] }>({ method: "GET", path: "/v1/job-runs", query, replay: true })).body.runs;
  }

  /** The regions sandboxes can be made in now, the default first, with the sizes each has room for. */
  async regions(): Promise<Region[]> {
    return (await this.http.json<{ regions: Region[] }>({ method: "GET", path: "/v1/regions", replay: true })).body.regions;
  }

  /** Who the key belongs to: the account's id, name and address, its role, and whether it is closed. */
  async me(): Promise<Me> {
    return (await this.http.json<Me>({ method: "GET", path: "/v1/me", replay: true })).body;
  }

  /** Every port given an address, across the account's sandboxes that the key reaches. A sandbox's own are in its routes(). */
  async hostRoutes(): Promise<HostRoute[]> {
    return (await this.http.json<{ routes: HostRoute[] }>({ method: "GET", path: "/v1/host-routes", replay: true })).body.routes;
  }

  /** Hides a port's address: it answers not found from then on. There is no undoing it; give the port an address again instead. */
  async hideHostRoute(routeId: string): Promise<HostRoute> {
    return (await this.http.json<HostRoute>({ method: "POST", path: `/v1/host-routes/${encodeURIComponent(routeId)}/hide`, replay: true })).body;
  }

  /** The sizes on offer, the regions, and how many of your sandboxes are creating, running or stopped. */
  async limits(): Promise<Catalog> {
    return (await this.http.json<Catalog>({ method: "GET", path: "/v1/limits", replay: true })).body;
  }

  /** What applies to every account here: how many sandboxes, how long one runs, whether ports get public addresses. */
  async policy(): Promise<Policy> {
    return (await this.http.json<Policy>({ method: "GET", path: "/v1/policy", replay: true })).body;
  }

  /**
   * What is sold: the list price an hour of each size, the plans, the free one first, the
   * top-ups offered with what each adds, the range a top-up may be and its bonus, and the free
   * plan's monthly allowance and what it runs at once before the account has paid. It needs no key.
   */
  async prices(): Promise<Prices> {
    return (await this.http.json<Prices>({ method: "GET", path: "/v1/billing/plans", replay: true })).body;
  }

  /**
   * Where the account stands: its plan, the free one included, what it has used this month at list price,
   * what is left of its credits, and whether it may run a sandbox. On the free plan, `free` says whether a
   * card is saved, whether the account has paid for anything, and its monthly allowance and how much of it is used. Amounts are millionths of a US dollar.
   */
  async billing(): Promise<Billing> {
    return (await this.http.json<Billing>({ method: "GET", path: "/v1/billing", replay: true })).body;
  }

  /**
   * Starts a purchase, or a card saved, and gives the address of the page, for a person to
   * open: a plan; a top-up of credits that do not expire, any whole number of US dollars from
   * 15 to 100,000; or `{ card: true }`, which saves a card for the free plan and charges
   * nothing. Once the card is saved, the account has the free plan's monthly allowance, once a card, and may
   * run sandboxes; an account with a card saved already is refused with 409 card_saved.
   * From $200 a top-up adds a bonus, 2% there and growing to 25% at $10,000: $500 adds $537.
   * prices() says what each adds. An account that already has a plan and asks for another is
   * moved to it at once: url is null and changed is true. Nothing is charged until the person
   * pays. To go back to the free plan, cancel the plan in the billing portal.
   */
  async checkout(purchase: { plan: "plan100" | "plan500" | "plan2000" } | { topUp: number } | { card: true }): Promise<Checkout> {
    return (await this.http.json<Checkout>({ method: "POST", path: "/v1/billing/checkout", body: purchase })).body;
  }

  /**
   * Sets the auto-reload, or turns it off with null: when the month's credits and the top-ups run
   * out, the card saved at the last purchase is charged for a top-up of this many US dollars, with
   * tax, and its credits are added at once, before any sandbox is stopped. At most three times a
   * day, and not again for a day after a card that would not pay. It needs a card saved
   * first, by checkout(): billing().canAutoReload says whether it can be set.
   */
  async setAutoReload(dollars: number | null): Promise<AutoReload> {
    return (await this.http.json<AutoReload>({ method: "PUT", path: "/v1/billing/auto-reload", body: { dollars } })).body;
  }

  /**
   * The account's invoices, newest first, read from the payment provider: a plan's months, top-ups
   * and auto-reloads, drafts left out. 25 unless limit says otherwise, 100 at most; pass a page's
   * next as startingAfter for the page after it. An admin is given no pageUrl or pdfUrl.
   */
  async invoices(options: { limit?: number; startingAfter?: string } = {}): Promise<BillingInvoices> {
    const query = { limit: options.limit === undefined ? undefined : String(options.limit), startingAfter: options.startingAfter };
    return (await this.http.json<BillingInvoices>({ method: "GET", path: "/v1/billing/invoices", query, replay: true })).body;
  }

  /** Every invoice, newest first, read a page at a time as they are asked for. */
  async *allInvoices(options: { limit?: number } = {}): AsyncGenerator<BillingInvoice, void, void> {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await this.invoices({ ...options, ...(startingAfter === undefined ? {} : { startingAfter }) });
      yield* page.invoices;
      if (page.next === null) {
        return;
      }
      startingAfter = page.next;
    }
  }

  /** The card the account pays with now, the one an auto-reload charges: its brand, last four, expiry and wallet, or null where none is saved. */
  async card(): Promise<BillingCard> {
    return (await this.http.json<BillingCard>({ method: "GET", path: "/v1/billing/card", replay: true })).body;
  }

  /** Who the account's invoices are made out to: the email they go to, the name and address on them, and its tax ids. Null before it has bought anything. An owner's to read: an admin is refused with 403. */
  async billingDetails(): Promise<BillingDetails> {
    return (await this.http.json<BillingDetails>({ method: "GET", path: "/v1/billing/details", replay: true })).body;
  }

  /** The account's mail: the handle every address of its sandboxes carries, what its plan allows, and what it has had of that today. */
  async email(): Promise<AccountEmail> {
    return (await this.http.json<AccountEmail>({ method: "GET", path: "/v1/email", replay: true })).body;
  }

  /**
   * How close your account runs to its plan's limits. `now` is where it stands: how many small
   * sandboxes it runs and may run at once (runningUnits; a tiny counts half, a medium 2, a
   * large 4), what its burst meter reads against the free burst, what it has spent on burst
   * fees this month against its budget, and what one sandbox of each size would cost to start
   * now. Over the range, today (UTC) unless from and to say otherwise: what it ran against its
   * running count (series, atRunningCountMs), each burst, what did not start and why
   * (refused), and how fast what started ran (speed). A range covers 90 days at most.
   *
   * Where `now.enforced` is true, a create, fork or start past the running count throws an
   * `ApiError` 429 `running_limit_reached`; one faster than the free burst costs a burst fee,
   * and is refused with `burst_budget_reached` past the monthly budget.
   * On the free plan, until the account has paid for something (`now.unpaid`), the running
   * count is `free.unpaidUnits` of prices(). Amounts are millionths of a US dollar.
   */
  async headroom(range: HeadroomRange = {}): Promise<Headroom> {
    const iso = (at: Date | string | undefined): string | undefined => (at instanceof Date ? at.toISOString() : at);
    const query = { from: iso(range.from), to: iso(range.to), step: range.step };
    return (await this.http.json<Headroom>({ method: "GET", path: "/v1/headroom", query, replay: true })).body;
  }

  /**
   * Sets the most the account spends on burst fees in a month, in millionths of a US dollar:
   * 0 refuses every start that would cost one. null gives it the default again,
   * defaultBudgetMicros. It answers with where the account stands now, as headroom().now.
   */
  async setHeadroomBudget(budgetMicros: number | null): Promise<HeadroomNow> {
    return (await this.http.json<HeadroomNow>({ method: "PUT", path: "/v1/headroom/budget", body: { budgetMicros }, replay: true })).body;
  }

  /**
   * Whether the account may send sandboxes out through residential addresses, and what it
   * still needs: plan (Fleet or larger), card (one saved), use_case (setEgressUseCase()).
   * With what a GB costs, what it has spent this month, its budget, and why its residential
   * connections are refused now, if they are. Amounts are millionths of a US dollar.
   */
  async egress(): Promise<EgressAccount> {
    return (await this.http.json<EgressAccount>({ method: "GET", path: "/v1/egress", replay: true })).body;
  }

  /**
   * Tells us what the account's sandboxes will use residential addresses for, in a few
   * sentences (20 to 2,000 characters): said once for the whole account. Sent again, it
   * replaces what was sent. An owner's key only. Only where policy() says residentialEgress.
   */
  async setEgressUseCase(useCase: string): Promise<EgressAccount> {
    return (await this.http.json<EgressAccount>({ method: "PUT", path: "/v1/egress/use-case", body: { useCase }, replay: true })).body;
  }

  /**
   * Sets the most the account's residential traffic costs in a month, in millionths of a US
   * dollar: 0 refuses all of it. null gives it the default again, defaultBudgetMicros. An
   * owner's key only. Only where policy() says residentialEgress.
   */
  async setEgressBudget(budgetMicros: number | null): Promise<EgressAccount> {
    return (await this.http.json<EgressAccount>({ method: "PUT", path: "/v1/egress/budget", body: { budgetMicros }, replay: true })).body;
  }

  /**
   * Running time and what it comes to at the list price, by sandbox, by key, by day and by hour, and the mail of the same
   * window. With apiKeyId, one key or several, only the sandboxes those keys made, "console" standing for those made in
   * the console: the keys stay the whole account's.
   */
  async usage(options: { since?: string | Date; until?: string | Date; apiKeyId?: string | string[] } = {}): Promise<Usage> {
    const keys = options.apiKeyId;
    const query = { since: iso(options.since), until: iso(options.until), apiKeyId: Array.isArray(keys) ? keys.join(",") : keys };
    return (await this.http.json<Usage>({ method: "GET", path: "/v1/usage", query, replay: true })).body;
  }

  /**
   * What each of your sandboxes read at one moment: now, unless at says another. A sandbox
   * that was stopped then has a null reading, and so has one on a server that did not
   * answer, which complete says. Only where policy() says metrics.
   */
  async metrics(moment: { at?: string | Date } = {}): Promise<MetricsAtMoment> {
    return (await this.http.json<MetricsAtMoment>({ method: "GET", path: "/v1/metrics", query: { at: iso(moment.at) }, replay: true })).body;
  }

  /**
   * How many of your sandboxes were running at each step between two moments. Without
   * since, the last 24 hours. It is counted from the record of what ran, so it answers
   * wherever sandboxes run, and a sandbox deleted since is still counted.
   */
  async runningOverTime(window: { since?: string | Date; until?: string | Date; stepSeconds?: number } = {}): Promise<RunningOverTime> {
    const query = { since: iso(window.since), until: iso(window.until), stepSeconds: window.stepSeconds?.toString() };
    return (await this.http.json<RunningOverTime>({ method: "GET", path: "/v1/metrics/running", query, replay: true })).body;
  }

  /**
   * The OTLP/HTTP collector your sandboxes' metrics and lifecycle events are sent to, with
   * the names of its headers and how the last export went. Null when none is set. Only
   * where policy() says telemetry.
   */
  async getTelemetry(): Promise<Telemetry | null> {
    return (await this.http.json<{ telemetry: Telemetry | null }>({ method: "GET", path: "/v1/telemetry", replay: true })).body.telemetry;
  }

  /**
   * Sets the collector your sandboxes' metrics and lifecycle events are sent to, in place of
   * the one set before. endpoint is its base address, https on port 443 or 4318. headers are
   * sent with each export, such as the collector's API key, and their values are never
   * shown again. Nothing is sent now: testTelemetry() does that. From the next whole minute
   * it is sent the metrics every minute, and each event as it happens.
   */
  async setTelemetry(collector: { endpoint: string; headers?: Record<string, string> }): Promise<Telemetry> {
    const body = { endpoint: collector.endpoint, ...(collector.headers ? { headers: collector.headers } : {}) };
    return (await this.http.json<{ telemetry: Telemetry }>({ method: "PUT", path: "/v1/telemetry", body, replay: true })).body.telemetry;
  }

  /**
   * Sends your collector one empty export, with its headers, and says what it answered. ok
   * is false when it refused, did not answer in 10 seconds, or is at an address that is not
   * sent to. Nothing else is changed.
   */
  async testTelemetry(): Promise<TelemetryTest> {
    return (await this.http.json<TelemetryTest>({ method: "POST", path: "/v1/telemetry/test" })).body;
  }

  /** Removes your collector, with its headers, and nothing more is sent to it. When none is set it throws an ApiError with the status 404. */
  async deleteTelemetry(): Promise<void> {
    await this.http.send({ method: "DELETE", path: "/v1/telemetry" });
  }

  /**
   * The Claude Managed Agents self-hosted environments connected to your account. Each
   * session of one runs its tool calls in a sandbox of your own. Their keys and signing
   * secrets are never shown. Only where policy() says managedAgents.
   */
  async listClaudeConnections(): Promise<ClaudeConnection[]> {
    return (await this.http.json<{ data: ClaudeConnection[] }>({ method: "GET", path: "/v1/claude/connections", replay: true })).body.data;
  }

  /**
   * Connects a self-hosted environment from the Claude Console: its id, its environment key,
   * and, for a turn to start at once, its webhook's signing secret. The key and secret are
   * kept sealed and never shown again, and the key never goes into a sandbox. Each session
   * gets a sandbox on templateId (the account's default when left out), stopped between turns
   * and deleted once it has slept keepDays (7). Set the answer's webhookUrl as the
   * environment's webhook for session.status_run_started in the Claude Console.
   */
  async connectClaude(connection: { environmentId: string; environmentKey: string; webhookSecret?: string; templateId?: string | null; keepDays?: number }): Promise<ClaudeConnection> {
    return (await this.http.json<{ connection: ClaudeConnection }>({ method: "POST", path: "/v1/claude/connections", body: connection })).body.connection;
  }

  /** One connected environment. */
  async getClaudeConnection(id: string): Promise<ClaudeConnection> {
    return (await this.http.json<{ connection: ClaudeConnection }>({ method: "GET", path: `/v1/claude/connections/${encodeURIComponent(id)}`, replay: true })).body.connection;
  }

  /** The sessions of a connected environment that have run here, the latest active first: each one's sandbox, whether it runs or sleeps, when a sleeping one's sandbox is deleted, and why its last turn was not served. */
  async listClaudeSessions(id: string): Promise<ClaudeSession[]> {
    return (await this.http.json<{ data: ClaudeSession[] }>({ method: "GET", path: `/v1/claude/connections/${encodeURIComponent(id)}/sessions`, replay: true })).body.data;
  }

  /** Changes a connection: a new key or signing secret (null forgets it), another template (null for the default), or keepDays. What is left out stays as it was. */
  async updateClaudeConnection(id: string, change: { environmentKey?: string; webhookSecret?: string | null; templateId?: string | null; keepDays?: number }): Promise<ClaudeConnection> {
    return (await this.http.json<{ connection: ClaudeConnection }>({ method: "PATCH", path: `/v1/claude/connections/${encodeURIComponent(id)}`, body: change, replay: true })).body.connection;
  }

  /** Disconnects an environment: its key and signing secret are forgotten, and no more of its work is claimed. Its sessions' sandboxes are left as they are. */
  async disconnectClaude(id: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/v1/claude/connections/${encodeURIComponent(id)}` });
  }

  /**
   * GitHub Actions jobs on sandboxes: each repository's pool, how many sandboxes of each size it
   * keeps and the template they are made on. available is false where jobs do not run on
   * sandboxes here. GitHub itself is connected in the console.
   */
  async runsOnRepositories(): Promise<RunsOnRepositories> {
    return (await this.http.json<RunsOnRepositories>({ method: "GET", path: "/v1/runs-on/repositories", replay: true })).body;
  }

  /**
   * Sets a repository's pool, given as owner/name: poolMax, 1 to 50 sandboxes of each size, and
   * templateId, one of your templates, each null for the default and left out to keep what was set.
   * The template is used only where GitHub says the repository is private and runs no workflows
   * from fork pull requests.
   */
  async setRunsOnRepository(repository: string, settings: { poolMax?: number | null; templateId?: string | null }): Promise<RunsOnRepository> {
    return (await this.http.json<RunsOnRepository>({ method: "PUT", path: `/v1/runs-on/repositories/${repoPath(repository)}`, body: settings, replay: true })).body;
  }

  /** Puts a repository's pool back to the defaults. Its sandboxes are kept. When it has no settings it throws an ApiError with the status 404. */
  async resetRunsOnRepository(repository: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/v1/runs-on/repositories/${repoPath(repository)}` });
  }

  /**
   * How long your sandboxes' history is kept: the output of their commands, their agent
   * conversations and their events. keepDays is 1, 7, 30 or 90, or null to keep it until the
   * sandbox is deleted; 30 until you choose. retained lists what is kept for periods agental sets.
   */
  async getDataRetention(): Promise<DataRetention> {
    return (await this.http.json<DataRetention>({ method: "GET", path: "/v1/data-retention", replay: true })).body;
  }

  /**
   * Sets how long your sandboxes' history is kept: 1, 7, 30 or 90 days, or null until the
   * sandbox is deleted. History older than that is deleted within the hour and cannot be
   * brought back. A deleted sandbox's history is deleted with it, whatever is set, its events a day later.
   */
  async setDataRetention(keepDays: 1 | 7 | 30 | 90 | null): Promise<DataRetention> {
    return (await this.http.json<DataRetention>({ method: "PATCH", path: "/v1/data-retention", body: { keepDays }, replay: true })).body;
  }

  /** The webhooks your account's events are posted to, each with its tries of the last 30 days. Their secrets are not given. */
  async listWebhooks(): Promise<Webhook[]> {
    return (await this.http.json<{ webhooks: Webhook[] }>({ method: "GET", path: "/v1/webhooks", replay: true })).body.webhooks;
  }

  /**
   * Adds a webhook. url is posted each event it takes, and has to be on the public internet.
   * events names the kinds it takes, such as sandbox.stopped or headroom.burst_ended, a group
   * of them by its name and .*, such as "headroom.*", which takes the group's kinds added later
   * too, or "*" for every one and any added later, which is what it takes when events is left
   * out. A * anywhere else is refused. The answer holds
   * signingSecret, the one time it is given: each post's X-Agental-Signature is checked
   * against it with verifyWebhook. It is sent once, so a lost answer is not sent again.
   */
  async createWebhook(webhook: { url: string; events?: string[]; description?: string }): Promise<Webhook> {
    return (await this.http.json<Webhook>({ method: "POST", path: "/v1/webhooks", body: webhook })).body;
  }

  /** One webhook, with every try of the last 30 days: the status each was answered, the event it was a try of, and which try. */
  async getWebhook(id: string): Promise<Webhook> {
    return (await this.http.json<Webhook>({ method: "GET", path: `/v1/webhooks/${encodeURIComponent(id)}`, replay: true })).body;
  }

  /**
   * Changes a webhook's url, events or description, and keeps what is left out. A changed url
   * is used from the next try on. enabled turns it off (false) or on again (true), as
   * disableWebhook and enableWebhook do.
   */
  async updateWebhook(id: string, changes: { url?: string; events?: string[]; description?: string; enabled?: boolean }): Promise<Webhook> {
    return (await this.http.json<Webhook>({ method: "PATCH", path: `/v1/webhooks/${encodeURIComponent(id)}`, body: changes, replay: true })).body;
  }

  /**
   * Turns a webhook off: it is posted nothing, and the events still owed to it are given up.
   * A webhook also turns itself off when an event fails its last try and none of its tries
   * has been taken for 3 days; its disabledAt and disabledReason say when and why.
   */
  async disableWebhook(id: string): Promise<Webhook> {
    return await this.updateWebhook(id, { enabled: false });
  }

  /** Turns a webhook on again. It is posted the events made from now on; none given up while it was off is sent. */
  async enableWebhook(id: string): Promise<Webhook> {
    return await this.updateWebhook(id, { enabled: true });
  }

  /** Gives a webhook a new signing secret, in its signingSecret, once. The old one stops working at once. */
  async rotateWebhookSecret(id: string): Promise<Webhook> {
    return (await this.http.json<Webhook>({ method: "POST", path: `/v1/webhooks/${encodeURIComponent(id)}/rotate` })).body;
  }

  /** Deletes a webhook, the events still owed to it, and its tries. */
  async deleteWebhook(id: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `/v1/webhooks/${encodeURIComponent(id)}` });
  }

  /**
   * Everything agental keeps about your account and the person behind it: the account, its
   * sessions with the address and browser each began from, its keys by name, billing,
   * payments, usage, and what it has made. Secrets are named, never given. Closing an
   * account is not here: only a person signed in to the console can close one.
   */
  async exportAccount(): Promise<AccountExport> {
    return (await this.http.json<AccountExport>({ method: "GET", path: "/v1/me/export", replay: true })).body;
  }
}

/** owner/name as a path: each part encoded, the slash between them kept. */
function repoPath(repository: string): string {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new TypeError(`A repository is owner/name, as acme/app, and not ${JSON.stringify(repository)}.`);
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
