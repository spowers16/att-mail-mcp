import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireNode, root, run, npm } from "./common.mjs";
import { activate, pointer, rollback, seal, verify } from "./release-lib.mjs";
import { probe } from "./probe.mjs";

requireNode();
const [action, ...args] = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const base =
  rootIndex < 0
    ? path.join(os.homedir(), ".local/share/codex-att-mail-mcp")
    : path.resolve(args[rootIndex + 1]);
if (action === "prepare") {
  if (run("git", ["status", "--porcelain"], { capture: true }))
    throw new Error("Commit source changes before preparing a release");
  run(process.execPath, ["tools/secret-scan.mjs"]);
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const version = JSON.parse(
    readFileSync(path.join(root, "package.json")),
  ).version;
  const name = `v${version}-${commit.slice(0, 12)}`;
  const releases = path.join(base, "releases");
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const final = path.join(releases, name);
  if (existsSync(final)) {
    verify(final);
    console.log(JSON.stringify({ prepared: name, reused: true }));
    process.exit(0);
  }
  const source = mkdtempSync(path.join(os.tmpdir(), "att-mail-source-"));
  const candidate = mkdtempSync(path.join(releases, ".candidate-"));
  try {
    const archive = execFileSync("git", ["archive", commit], {
      cwd: root,
      maxBuffer: 30 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
    npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: path.join(source, "server"),
    });
    run(process.execPath, ["tools/check.mjs"], { cwd: source });
    for (const name of ["dist", "package.json", "package-lock.json"])
      cpSync(path.join(source, "server", name), path.join(candidate, name), {
        recursive: true,
      });
    npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: candidate,
    });
    const serverVersion = JSON.parse(
      readFileSync(path.join(candidate, "package.json")),
    ).version;
    const discovery = await probe(
      path.join(candidate, "dist/index.js"),
      serverVersion,
    );
    seal(candidate, {
      commit,
      version,
      serverVersion,
      tools: discovery.toolNames,
      node: process.versions.node,
      createdAt: new Date().toISOString(),
    });
    verify(candidate);
    renameSync(candidate, final);
    console.log(JSON.stringify({ prepared: name, activated: false, commit }));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(candidate, { recursive: true, force: true });
  }
} else if (action === "activate") {
  const name = args[0];
  if (!name || name === "--root")
    throw new Error("Supply the prepared release name");
  console.log(
    JSON.stringify(await activate(base, name), (key, value) =>
      key === "files" ? undefined : value,
    ),
  );
} else if (action === "rollback") {
  console.log(
    JSON.stringify(await rollback(base), (key, value) =>
      key === "files" ? undefined : value,
    ),
  );
} else if (action === "status") {
  console.log(
    JSON.stringify(
      {
        current: pointer(base, "current"),
        previous: pointer(base, "previous"),
      },
      null,
      2,
    ),
  );
} else throw new Error("Use prepare, activate, rollback, or status");
