// Bundles the agental command into this package as dist/cli.js, the `agental` bin, so that
// `npx agental@latest` signs in, installs the command and the agent skills, and `sh` opens a
// shell in a new sandbox.
//
// The command's source is not in this folder: it is src/cli.ts of the agental monorepo, beside
// the API it is tested against. So this runs, and the package is published, from the agental
// monorepo. The public copy of this folder has the SDK's source and not the command's, and
// cannot build the bin.
//
// The published command talks to https://agental.io unless AGENTAL_API_URL says otherwise. It
// has no development key, and leaves out the commands that are run only from the monorepo:
// each such module is replaced by the stub below.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.resolve(root, "../../src/cli.ts");
if (!existsSync(entry)) {
  console.error(`The command's source is not at ${entry}: build it, and publish, from the agental monorepo.`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** What the published command has in place of the modules it leaves out. Each export the command imports from them is here. */
const LEFT_OUT = {
  "cli-operator": [
    'export const OPERATOR_USAGE = "";',
    'export const OPERATOR_HELP = "";',
    'const away = () => { throw new Error("That command is not in the published agental."); };',
    "export const smoke = away;",
    "export const suspensions = away;",
    "export const move = away;",
  ].join(" "),
  "cli-dev-key": "export const DEV_KEY = null;",
};

const leaveOut = {
  name: "leave-out",
  setup(context) {
    context.onResolve({ filter: /(^|\/)(cli-operator|cli-dev-key)\.js$/ }, (args) => ({ path: path.basename(args.path, ".js"), namespace: "left-out" }));
    context.onLoad({ filter: /.*/, namespace: "left-out" }, (args) => ({ contents: LEFT_OUT[args.path], loader: "js" }));
  },
};

const result = await build({
  entryPoints: [entry],
  outfile: path.join(root, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __AGENTAL_CLI_VERSION__: JSON.stringify(version),
    __AGENTAL_CLI_API_URL__: JSON.stringify("https://agental.io"),
  },
  plugins: [leaveOut],
  metafile: true,
  logLevel: "warning",
});

// Nothing that is left out may reach the bundle another way.
const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter((input) => /(^|\/)(smoke|smtp-probe|cdp-probe|rfb-probe|cli-operator)\.ts$/.test(input) || input.includes("node_modules"));
if (leaked.length > 0) {
  console.error(`The published command would carry what it leaves out: ${leaked.join(", ")}`);
  process.exit(1);
}
if (readFileSync(path.join(root, "dist/cli.js"), "utf8").includes("ag_dev_")) {
  console.error("The published command would carry the dev key.");
  process.exit(1);
}
const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes;
console.log(`dist/cli.js: agental ${version}, ${inputs.length} files, ${Math.round(bytes / 1024)} KiB`);
