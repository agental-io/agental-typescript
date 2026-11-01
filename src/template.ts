import { AgentalError } from "./errors.js";
import { tagSegment, type Http } from "./http.js";
import type {
  HiddenVariable,
  NetworkRule,
  PlainVariable,
  SecretVariable,
  Size,
  SshKey,
  TemplateApplied,
  TemplateInfo,
  TemplateNetwork,
  TemplateRepo,
  TemplateSandbox,
  TemplateSsh,
  TemplateStart,
} from "./types.js";

/**
 * Secrets: a template's, or a sandbox's own. Variables are in the environment of every
 * command run in a sandbox, and files are written into its work folder before each one.
 * A sandbox's own come on top of its template's: where both name the same variable or
 * path, its own is used. Values are read one at a time. A variable kept out of the sandbox
 * is in the environment as its stand-in, and its value is never given back.
 */
export class Secrets {
  constructor(
    private readonly http: Http,
    private readonly path: string,
  ) {}

  /** The names of the variables. hidden() says which of them are kept out of the sandbox. */
  async variables(): Promise<string[]> {
    return (await this.listed()).names;
  }

  /** The names of the variables kept out of the sandbox. */
  async hidden(): Promise<string[]> {
    return (await this.listed()).hidden;
  }

  /**
   * One variable's value. A variable kept out of the sandbox has none to give, and is
   * thrown as an AgentalError: variable() gives its hosts and its stand-in.
   */
  async get(name: string): Promise<string> {
    const found = await this.variable(name);
    if (found.hidden) {
      throw new AgentalError(`${name} is kept out of the sandbox, and its value is never given back. variable("${name}") gives its hosts and its stand-in.`);
    }
    return found.value;
  }

  /** One variable: a plain one with its value, or one kept out of the sandbox with its hosts and its stand-in. hidden says which. */
  async variable(name: string): Promise<SecretVariable> {
    return (await this.http.json<SecretVariable>({ method: "GET", path: this.variablePath(name), replay: true })).body;
  }

  /**
   * Sets a variable, and gives it as it is kept. With hosts it is kept out of the sandbox:
   * its commands see a stand-in, and the proxy on the sandbox's server puts the value in
   * place of the stand-in on HTTPS requests to those hosts, and nowhere else. Its stand-in
   * stays the same when its value is replaced. Without hosts it is plain, and its commands
   * read its value: one kept out that is set without hosts is plain from then on. A plain
   * one may be empty: delete removes a variable. Hosts are names such as api.github.com, or
   * *.example.com for every name under example.com, 1 to 10 of them, and only where
   * policy() says hiddenVariables. They do not open the template's outbound rule.
   */
  set(name: string, value: string, options: { hosts: string[] }): Promise<HiddenVariable>;
  set(name: string, value: string, options?: { hosts?: undefined }): Promise<PlainVariable>;
  set(name: string, value: string, options?: { hosts?: string[] }): Promise<SecretVariable>;
  async set(name: string, value: string, options: { hosts?: string[] } = {}): Promise<SecretVariable> {
    const body = options.hosts === undefined ? { value } : { value, hosts: options.hosts };
    return (await this.http.json<SecretVariable>({ method: "PUT", path: this.variablePath(name), body, replay: true })).body;
  }

  /**
   * Narrows the hosts a variable kept out of the sandbox is sent to, in place of the ones it
   * had, without sending its value again. Its value and its stand-in stay as they are. Each
   * host has to be one it is sent to now, or under one of its wildcards: a new one is refused
   * with hosts_widened, and needs set() with the value. A plain variable is refused with
   * not_hidden: set it with its value and hosts to keep it out.
   */
  async setHosts(name: string, hosts: string[]): Promise<HiddenVariable> {
    return (await this.http.json<HiddenVariable>({ method: "PUT", path: `${this.variablePath(name)}/hosts`, body: { hosts }, replay: true })).body;
  }

  async delete(name: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: this.variablePath(name) });
  }

  /** The paths of the files, relative to the work folder. */
  async files(): Promise<string[]> {
    return (await this.http.json<{ paths: string[] }>({ method: "GET", path: `${this.path}/files`, replay: true })).body.paths;
  }

  /** What one file holds. */
  async readFile(path: string): Promise<string> {
    return (await this.http.json<{ text: string }>({ method: "GET", path: `${this.path}/files`, query: { path }, replay: true })).body.text;
  }

  /** Sets a file, and gives the path as it is kept, written one way. */
  async writeFile(path: string, text: string): Promise<string> {
    return (await this.http.json<{ path: string }>({ method: "PUT", path: `${this.path}/files`, body: { path, text }, replay: true })).body.path;
  }

  /** Stops writing a file. A copy already written to a sandbox's disk stays there. */
  async deleteFile(path: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `${this.path}/files`, query: { path } });
  }

  private async listed(): Promise<{ names: string[]; hidden: string[] }> {
    const { body } = await this.http.json<{ names: string[]; hidden?: string[] }>({ method: "GET", path: `${this.path}/variables`, replay: true });
    // An API from before variables could be kept out of the sandbox says nothing of them.
    return { names: body.names, hidden: body.hidden ?? [] };
  }

  private variablePath(name: string): string {
    return `${this.path}/variables/${encodeURIComponent(name)}`;
  }
}

/**
 * A template: what a sandbox is made as and held to, under one name. Its start says the
 * size of a sandbox made from it, what it starts from and how long it runs after each
 * start, its secrets are what every sandbox on it gets, and its outbound rule is what every
 * sandbox on it may reach. A sandbox takes a change to its secrets and its rule when it
 * next starts, or at once when apply() names it.
 */
/** What Template.update() changes. Left out, a field is left as it is. */
export interface TemplateChanges {
  name?: string;
  /** Its tags, in place of the ones it has. */
  tags?: string[];
  /** Merged into its metadata. null takes a key away. */
  metadata?: Record<string, string | null>;
}

export class Template {
  readonly secrets: Secrets;
  /** The template as it was last read. refresh() reads it again. */
  info: TemplateInfo;
  private readonly path: string;

  constructor(
    private readonly http: Http,
    info: TemplateInfo,
  ) {
    this.info = info;
    this.path = `/v1/templates/${encodeURIComponent(info.id)}`;
    this.secrets = new Secrets(http, `${this.path}/secrets`);
  }

  get id(): string {
    return this.info.id;
  }

  get name(): string {
    return this.info.name;
  }

  /** Whether it is the account's default, which a sandbox is on when none is chosen. */
  get isDefault(): boolean {
    return this.info.default;
  }

  async refresh(): Promise<this> {
    this.info = (await this.http.json<TemplateInfo>({ method: "GET", path: this.path, replay: true })).body;
    return this;
  }

  async rename(name: string): Promise<this> {
    return await this.update({ name });
  }

  /** Its tags, which every sandbox on it is shown with too. */
  get tags(): string[] {
    return [...(this.info.tags ?? [])];
  }

  /** Its metadata, which every sandbox on it has too, under the sandbox's own value for a key. */
  get metadata(): Record<string, string> {
    return { ...this.info.metadata };
  }

  /**
   * Changes its name, its tags or its metadata. tags are put in place of the ones it has,
   * and metadata is merged in, null taking a key away. Every sandbox on it is shown the
   * change at once.
   */
  async update(changes: TemplateChanges): Promise<this> {
    this.info = (await this.http.json<TemplateInfo>({ method: "PATCH", path: this.path, body: changes, replay: true })).body;
    return this;
  }

  /** Gives it a tag, and so every sandbox on it. One it has already is left as it is. */
  async addTag(tag: string): Promise<this> {
    this.info = (await this.http.json<TemplateInfo>({ method: "PUT", path: `${this.path}/tags/${tagSegment(tag)}`, replay: true })).body;
    return this;
  }

  /** Takes a tag away. One it does not have is nothing to take. */
  async removeTag(tag: string): Promise<this> {
    this.info = (await this.http.json<TemplateInfo>({ method: "DELETE", path: `${this.path}/tags/${tagSegment(tag)}`, replay: true })).body;
    return this;
  }

  /** Deletes it. One that sandboxes are on is refused: put them on another template first. */
  async delete(): Promise<void> {
    await this.http.send({ method: "DELETE", path: this.path });
  }

  /** What a sandbox made from it starts as. */
  async start(): Promise<TemplateStart> {
    return (await this.http.json<TemplateStart>({ method: "GET", path: `${this.path}/start`, replay: true })).body;
  }

  /**
   * Sets what a sandbox made from it starts as, from now on: its size, the snapshot it starts
   * from, and how many seconds it runs after each start before it is stopped, 60 at the
   * least. snapshotId left out or null is a new machine. ttlSeconds left out stays as it was,
   * and null is the deployment's default. One over maxTtlSeconds of policy() is refused with
   * ttl_too_long. Sandboxes made before keep their size, their disk
   * and their time limit.
   */
  async setStart(start: { size: Size; snapshotId?: string | null; ttlSeconds?: number | null }): Promise<TemplateStart> {
    const set = (await this.http.json<TemplateStart>({ method: "PUT", path: `${this.path}/start`, body: start, replay: true })).body;
    this.info = { ...this.info, start: set };
    return set;
  }

  /** The repository it links to, for reference. Nothing is cloned. */
  async repo(): Promise<TemplateRepo | null> {
    return (await this.http.json<TemplateRepo | null>({ method: "GET", path: `${this.path}/repo`, replay: true })).body;
  }

  async setRepo(repo: { name: string; url: string }): Promise<TemplateRepo> {
    return (await this.http.json<TemplateRepo>({ method: "PUT", path: `${this.path}/repo`, body: repo, replay: true })).body;
  }

  async removeRepo(): Promise<void> {
    await this.http.send({ method: "DELETE", path: `${this.path}/repo`, replay: true });
  }

  /** What a sandbox on it may reach outside itself, before the addresses of its own. One that was never set is open. */
  async network(): Promise<TemplateNetwork> {
    return (await this.http.json<TemplateNetwork>({ method: "GET", path: `${this.path}/network`, replay: true })).body;
  }

  /**
   * Sets what a sandbox on it may reach outside itself, in place of the rule it had:
   * { outbound: "open" }, { outbound: "blocked" }, or { outbound: "allowlist", allow: [...] }
   * with every address it lets out to. A sandbox is held to it with its own addresses on
   * top. One made from it is held to it from its first boot, and one already on it takes it
   * when it next starts, or now when apply() names it. Only where policy() says networkPolicy.
   */
  async setNetwork(rule: NetworkRule): Promise<TemplateNetwork> {
    const set = (await this.http.json<TemplateNetwork>({ method: "PUT", path: `${this.path}/network`, body: rule, replay: true })).body;
    this.info = { ...this.info, network: set };
    return set;
  }

  /** What a sandbox made from it is given for SSH as it is made: whether SSH is turned on, and the keys let in. */
  async ssh(): Promise<TemplateSsh> {
    return (await this.http.json<TemplateSsh>({ method: "GET", path: `${this.path}/ssh`, replay: true })).body;
  }

  /**
   * Turns SSH on for every sandbox made from it from now on, as Sandbox.ssh.on() would as it
   * is made. A sandbox already made is not changed, and no key is let in: addSshKey() does
   * that. Only where policy() says ssh.
   */
  async sshOn(): Promise<TemplateSsh> {
    return await this.setSsh("PUT");
  }

  /** A sandbox made from it from now on has SSH off as it is made. Sandboxes already made, and the keys, are left as they are. */
  async sshOff(): Promise<TemplateSsh> {
    return await this.setSsh("DELETE");
  }

  /** Lets a public key, one line as in an authorized keys file, in as root to every sandbox made from it from now on. Sandboxes already made are not changed. */
  async addSshKey(publicKey: string): Promise<SshKey> {
    return (await this.http.json<SshKey>({ method: "POST", path: `${this.path}/ssh/keys`, body: { publicKey }, replay: true })).body;
  }

  /**
   * Takes a key, by its id, out of what the sandboxes made from it from now on are given.
   * The sandboxes already made keep it. A key that is not there answers not_found.
   */
  async removeSshKey(keyId: string): Promise<void> {
    await this.http.send({ method: "DELETE", path: `${this.path}/ssh/keys/${encodeURIComponent(keyId)}`, replay: true });
  }

  private async setSsh(method: "PUT" | "DELETE"): Promise<TemplateSsh> {
    const set = (await this.http.json<TemplateSsh>({ method, path: `${this.path}/ssh`, replay: true })).body;
    this.info = { ...this.info, ssh: set };
    return set;
  }

  /** The sandboxes on it, each with whether it has the template as it is now, and its own addresses. */
  async sandboxes(): Promise<TemplateSandbox[]> {
    return (await this.http.json<{ sandboxes: TemplateSandbox[] }>({ method: "GET", path: `${this.path}/sandboxes`, replay: true })).body.sandboxes;
  }

  /**
   * Brings running sandboxes on it up to date with it now: the ones named, or all of them.
   * Nothing is restarted. A stopped one takes it when it next starts. One whose server did
   * not take the outbound rule is in failed, and is held to the rule it had.
   */
  async apply(sandboxIds?: string[]): Promise<TemplateApplied> {
    const body = sandboxIds === undefined ? {} : { sandboxIds };
    return (await this.http.json<TemplateApplied>({ method: "POST", path: `${this.path}/apply`, body, replay: true })).body;
  }
}

/** Your templates. Every account has one named default. */
export class Templates {
  constructor(private readonly http: Http) {}

  /** Every template you have, default first. */
  async list(): Promise<Template[]> {
    const { body } = await this.http.json<{ templates: TemplateInfo[] }>({ method: "GET", path: "/v1/templates", replay: true });
    return body.templates.map((info) => new Template(this.http, info));
  }

  async get(id: string): Promise<Template> {
    return new Template(this.http, (await this.http.json<TemplateInfo>({ method: "GET", path: `/v1/templates/${encodeURIComponent(id)}`, replay: true })).body);
  }

  /** The template of this name, or null. */
  async find(name: string): Promise<Template | null> {
    return (await this.list()).find((template) => template.name === name) ?? null;
  }

  /** The account's default: the template a sandbox is on when none is chosen. */
  async default(): Promise<Template> {
    const found = (await this.list()).find((template) => template.isDefault);
    if (!found) {
      throw new Error("The API listed no default template.");
    }
    return found;
  }

  /** Makes a template with nothing in it but the tags and metadata given, which every sandbox on it is shown with. */
  async create(name: string, labels: { tags?: string[]; metadata?: Record<string, string> } = {}): Promise<Template> {
    return new Template(this.http, (await this.http.json<TemplateInfo>({ method: "POST", path: "/v1/templates", body: { name, ...labels } })).body);
  }
}
