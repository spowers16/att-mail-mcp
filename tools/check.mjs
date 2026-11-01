import { readFileSync } from "node:fs";
import path from "node:path";
import { requireNode, root, npm, run } from "./common.mjs";
requireNode();
run(process.execPath, [
  "server/node_modules/prettier/bin/prettier.cjs",
  "--check",
  "tools",
  "docs",
  "cowork-plugin",
  ".github",
  "README.md",
  "AGENTS.md",
  "package.json",
]);
const server = JSON.parse(readFileSync(path.join(root, "server/package.json")));
const versionSource = readFileSync(
  path.join(root, "server/src/version.ts"),
  "utf8",
);
if (!versionSource.includes(`'${server.version}'`))
  throw new Error("Server package and advertised versions differ");
npm(["run", "check"], { cwd: path.join(root, "server") });
run(process.execPath, [
  "--test",
  "tools/test/release.test.mjs",
  "tools/test/package.test.mjs",
]);
