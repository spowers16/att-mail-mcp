import { spawn } from "node:child_process";
import { requireNode, root, offlineEnv } from "./common.mjs";
requireNode();
const child = spawn(process.execPath, ["server/dist/index.js"], {
  cwd: root,
  env: offlineEnv(),
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
