import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const nodeVersion = readFileSync(
  path.join(root, ".nvmrc"),
  "utf8",
).trim();
export const minimumNodeVersion = JSON.parse(
  readFileSync(path.join(root, "server/package.json"), "utf8"),
).engines.node.replace(/^>=/, "");
const parts = (version) => version.split(".").map(Number);
function atLeast(actual, minimum) {
  const [a, b] = [parts(actual), parts(minimum)];
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] > b[index];
  return true;
}
// Releases and deployment need the exact .nvmrc version. Development checks
// accept any version allowed by server/package.json engines, with a warning.
export function checkNodeVersion(actual, { exact = true } = {}) {
  if (actual === nodeVersion) return {};
  if (exact) return { error: `Use Node ${nodeVersion}; got ${actual}` };
  if (!atLeast(actual, minimumNodeVersion))
    return {
      error: `Use Node ${minimumNodeVersion} or newer (${nodeVersion} for releases); got ${actual}`,
    };
  return {
    warning: `Using Node ${actual}; releases require Node ${nodeVersion} from .nvmrc`,
  };
}
export function requireNode(options) {
  const { error, warning } = checkNodeVersion(process.versions.node, options);
  if (error) throw new Error(error);
  if (warning) console.warn(`Warning: ${warning}`);
}
export function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(EMAIL_|IMAP_|SMTP_|MAIL_)/.test(name),
    ),
  );
}
export function offlineEnv(mode = "draft-only") {
  return {
    ...cleanEnv(),
    IMAP_HOST: "localhost",
    IMAP_PORT: "1",
    IMAP_SECURE: "true",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1",
    SMTP_SECURE: "true",
    EMAIL_USER: "offline@example.com",
    EMAIL_ADDRESS: "offline@example.com",
    EMAIL_PASS: "fake-offline-only",
    EMAIL_KEYCHAIN_SERVICE: "",
    MAIL_OPERATION_MODE: mode,
    MAIL_APPEND_SENT_COPY: "false",
  };
}
export function run(
  command,
  args,
  { cwd = root, capture = false, env = cleanEnv(), input } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ""}`,
    },
    encoding: "utf8",
    stdio: capture || input !== undefined ? "pipe" : "inherit",
    maxBuffer: 30 * 1024 * 1024,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})${capture ? `\n${result.stderr}` : ""}`,
    );
  return result.stdout?.trim();
}
export const npm = (args, options = {}) =>
  run(path.join(path.dirname(process.execPath), "npm"), args, options);
