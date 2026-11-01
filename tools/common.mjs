import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const nodeVersion = readFileSync(
  path.join(root, ".nvmrc"),
  "utf8",
).trim();
export function requireNode() {
  if (process.versions.node !== nodeVersion)
    throw new Error(`Use Node ${nodeVersion}; got ${process.versions.node}`);
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
