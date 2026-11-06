import { Http, type AgentalOptions } from "./http.js";
import { CREATE_TIMEOUT_MS, Email, iso, made, makeSandbox, Sandbox, type CreateOptions } from "./sandbox.js";
import { Templates } from "./template.js";
import type {
  AccountEmail,
  AccountExport,
  ApiKey,
  ApiKeyUsage,
  Billing,
  Burst,
  Catalog,
  HostRoute,
  Invite,
  Me,
  Member,
  Organization,
  Region,
  AutoReload,
  Checkout,
  DataRetention,
  CreateApiKey,
  CreatedApiKey,
  MetricsAtMoment,
  Policy,
  Prices,
  RunningOverTime,
  SandboxInfo,
  Size,
  Snapshot,
  Team,
  TeamRole,
  Telemetry,
  TelemetryTest,
  RunsOnRepository,
  RunsOnRepositories,
  Usage,
  Webhook,
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
  /** Each key at this value; "*" for any value, the key being set. */
  metadata?: Record<string, string>;
  /** No key at this value; "*" for the key not being set. */
  notMetadata?: Record<string, string>;
  /** Text found in the name or the id, case ignored. */
  text?: string;
}

/** How a page of sandboxes is sorted. Only created and -created keep a walk through the pages exact while sandboxes change. */
export type SandboxSort = "created" | "-created" | "name" | "-name" | "status" | "-status" | "stopped" | "-stopped";

/** A page of sandboxes, and what to pass as cursor for the next one: null when this is the last. */
export interface SandboxPage {
  sandboxes: Sandbox[];
  nextCursor: string | null;
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
      ...(options.network ? { network: options.network } : {}),
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
    many("sort", options.sort);
    many("limit", options.limit === undefined ? undefined : String(options.limit));
    many("cursor", options.cursor);
    const { body } = await this.http.json<{ sandboxes: SandboxInfo[]; nextCursor?: string | null }>({ method: "GET", path: "/v1/sandboxes", query, replay: true });
    // An API from before pages answers every sandbox at once, and no nextCursor.
    return { sandboxes: body.sandboxes.map((info) => new Sandbox(this.http, info)), nextCursor: body.nextCursor ?? null };
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
  private readonly http: Http;

  constructor(options: AgentalOptions = {}) {
    this.http = new Http(options);
    this.sandboxes = new Sandboxes(this.http);
    this.snapshots = new Snapshots(this.http);
    this.templates = new Templates(this.http);
    this.apiKeys = new ApiKeys(this.http);
    this.organizations = new Organizations(this.http);
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

  /** The sizes on offer, and how much room there is. */
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
   * plan's credit and what it runs at once before the account has paid. It needs no key.
   */
  async prices(): Promise<Prices> {
    return (await this.http.json<Prices>({ method: "GET", path: "/v1/billing/plans", replay: true })).body;
  }

  /**
   * Where the account stands: its plan, the free one included, what it has used this month at list price,
   * what is left of its credits, and whether it may run a sandbox. On the free plan, `free` says whether a
   * card is saved and whether the account has paid for anything. Amounts are millionths of a US dollar.
   */
  async billing(): Promise<Billing> {
    return (await this.http.json<Billing>({ method: "GET", path: "/v1/billing", replay: true })).body;
  }

  /**
   * Starts a purchase, or a card saved, and gives the address of the page, for a person to
   * open: a plan; a top-up of credits that do not expire, any whole number of US dollars from
   * 15 to 100,000; or `{ card: true }`, which saves a card for the free plan and charges
   * nothing. Once the card is saved, the account is given the free plan's credit, once, and may
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

  /** The account's mail: the handle every address of its sandboxes carries, what its plan allows, and what it has had of that today. */
  async email(): Promise<AccountEmail> {
    return (await this.http.json<AccountEmail>({ method: "GET", path: "/v1/email", replay: true })).body;
  }

  /**
   * Where your account stands against its plan: how many small sandboxes it runs and may run
   * at once (runningUnits; a tiny counts half, a medium 2, a large 4), what its burst meter
   * reads against the free burst, what it has spent on burst fees this month against its
   * budget, and what one sandbox of each size would cost to start now. With a size, and a
   * count, quote says what starting that many now would cost.
   *
   * Where `enforced` is true, a create, fork or start past the running count throws an
   * `ApiError` 429 `running_limit_reached`; one faster than the free burst costs a burst fee,
   * and is refused with `burst_budget_reached` past the monthly budget.
   * On the free plan, until the account has paid for something (`unpaid`), the running count
   * is `free.unpaidUnits` of prices(). Amounts are millionths of a US dollar.
   */
  async burst(quote?: { size: Size; count?: number }): Promise<Burst> {
    const query = { size: quote?.size, count: quote?.count?.toString() };
    return (await this.http.json<Burst>({ method: "GET", path: "/v1/burst", query, replay: true })).body;
  }

  /**
   * Sets the most the account spends on burst fees in a month, in millionths of a US dollar:
   * 0 refuses every start that would cost one. null gives it the default again,
   * defaultBudgetMicros. It answers with the account's burst as it stands now.
   */
  async setBurstBudget(budgetMicros: number | null): Promise<Burst> {
    return (await this.http.json<Burst>({ method: "PUT", path: "/v1/burst/budget", body: { budgetMicros }, replay: true })).body;
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
   * events names the kinds it takes, such as sandbox.stopped, or "*" for every one and any
   * added later, which is what it takes when events is left out. The answer holds
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

  /** Changes a webhook's url, events or description, and keeps what is left out. A changed url is used from the next try on. */
  async updateWebhook(id: string, changes: { url?: string; events?: string[]; description?: string }): Promise<Webhook> {
    return (await this.http.json<Webhook>({ method: "PATCH", path: `/v1/webhooks/${encodeURIComponent(id)}`, body: changes, replay: true })).body;
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
