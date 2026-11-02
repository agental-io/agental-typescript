#!/usr/bin/env node
// The `agental` command. npm checks that a package's bin exists before prepublishOnly builds
// dist/, and drops one that does not: so the bin is this file, which is always there, and the
// command itself is dist/cli.js, bundled by scripts/bundle-cli.mjs.
import "../dist/cli.js";
