import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { root, run } from "./common.mjs";
import { assertSourcePaths } from "./source-policy.mjs";

const version = "8.30.1";
const checksums = {
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64:
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  linux_arm64:
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
};
const platform = `${process.platform}_${process.arch}`;
if (!checksums[platform])
  throw new Error(`Unsupported Gitleaks platform: ${platform}`);
const cache = path.join(root, ".tools", `gitleaks-${version}-${platform}`);
const executable = path.join(cache, "gitleaks");
if (!existsSync(executable)) {
  mkdirSync(cache, { recursive: true });
  const archive = Buffer.from(
    await (
      await fetch(
        `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`,
      )
    ).arrayBuffer(),
  );
  if (
    createHash("sha256").update(archive).digest("hex") !== checksums[platform]
  )
    throw new Error("Gitleaks download checksum mismatch");
  const file = path.join(cache, "download.tar.gz");
  writeFileSync(file, archive);
  run("tar", ["-xzf", file, "-C", cache, "gitleaks"]);
  rmSync(file);
  chmodSync(executable, 0o755);
}
const common = [
  "--no-banner",
  "--redact",
  "--config",
  path.join(root, ".gitleaks.toml"),
];
const names = run(
  "git",
  process.argv.includes("--staged")
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files"],
  { capture: true },
);
assertSourcePaths(names.split("\n").filter(Boolean));
if (process.argv.includes("--staged")) {
  const staged = run("git", ["diff", "--cached", "--no-ext-diff", "--binary"], {
    capture: true,
  });
  run(executable, ["stdin", ...common], { input: staged });
} else {
  run(executable, ["dir", root, ...common]);
  run(executable, ["git", root, "--log-opts=--all", ...common]);
}
