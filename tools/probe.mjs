import { spawn } from "node:child_process";
import { offlineEnv } from "./common.mjs";

// Protocol-only probe: it initializes/list-tools, with fake credentials and
// localhost endpoints. It never invokes a mail operation.
export async function probe(entry, expectedVersion) {
  const child = spawn(process.execPath, [entry], {
    env: offlineEnv("full"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let closing;
  const exited = new Promise((resolve) => child.once("close", resolve));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Runtime probe timed out: ${stderr.slice(-1000)}`));
      }, 10000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) => {
        if (!closing) fail(new Error(`Runtime probe exited early (${code})`));
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.error) throw new Error(JSON.stringify(message.error));
            if (message.id === 1) {
              if (message.result.serverInfo.version !== expectedVersion)
                throw new Error("Runtime version mismatch");
              send({ jsonrpc: "2.0", method: "notifications/initialized" });
              send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            }
            if (message.id === 2) {
              const names = message.result.tools.map((tool) => tool.name);
              if (
                names.length !== 14 ||
                !names.includes("create_reply_draft") ||
                !names.includes("send_email")
              )
                throw new Error("Runtime tool set mismatch");
              clearTimeout(timer);
              closing = true;
              resolve({
                version: expectedVersion,
                tools: names.length,
                mailOperations: 0,
              });
            }
          } catch (error) {
            fail(error);
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "offline-release-probe", version: "1.0.0" },
        },
      });
    });
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timeout);
  }
}
