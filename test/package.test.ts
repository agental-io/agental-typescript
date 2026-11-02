import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[] };

// npm checks the bin before prepublishOnly builds dist/, and publishes without it when the file is
// not there yet: from a fresh clone, `npx agental` would have been no command at all.
test("the agental bin is a file the repository holds, not one the build makes", () => {
  const bin = manifest.bin["agental"] ?? "";
  assert.ok(!bin.includes("dist/"), `the bin is ${bin}, which a fresh clone does not have`);
  // npm 11 takes a bin path written as "./bin/..." for an invalid one, and drops it as well.
  assert.ok(!bin.startsWith("./"), `the bin is ${bin}: npm wants it without "./"`);
  assert.ok(existsSync(path.join(root, bin)), `${bin} is not in the repository`);
  assert.ok((statSync(path.join(root, bin)).mode & 0o111) !== 0, `${bin} is not executable`);
  assert.ok(manifest.files.includes(bin.split("/")[0] ?? ""), `${bin} is not in files`);
  assert.match(readFileSync(path.join(root, bin), "utf8"), /^#!\/usr\/bin\/env node\n[\s\S]*import "\.\.\/dist\/cli\.js";/);
});
