import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSourcePaths } from "../source-policy.mjs";
import {
  packagePlugin,
  renderConfig,
  validatePlugin,
} from "../package-plugin.mjs";

const host = {
  NODE_COMMAND: "/example/node",
  SERVER_ENTRY: "/example/current/dist/index.js",
  EMAIL_ADDRESS: "person@example.com",
  KEYCHAIN_SERVICE: "example-mail",
  ATTACHMENT_ROOT: "/example/attachments",
};

test("source policy rejects personal settings and mail artifacts even if forcibly staged", () => {
  for (const file of [
    "cowork-plugin/.mcp.json",
    "local/host.json",
    "artifacts/plugin.zip",
    "server/.env",
    "mail.eml",
    "key.pem",
    "server/node_modules/dependency/index.js",
  ]) {
    assert.throws(() => assertSourcePaths([file]), /cannot be committed/);
  }
  assert.doesNotThrow(() =>
    assertSourcePaths([
      "server/.env.example",
      "cowork-plugin/.mcp.template.json",
      "server/src/config.ts",
    ]),
  );
});
test("host rendering uses JSON values, retains file boundaries, and refuses credentials", () => {
  const config = renderConfig(host).mcpServers.att_mail;
  assert.equal(config.env.MAIL_ALLOWED_ROOTS, host.ATTACHMENT_ROOT);
  assert.equal(config.env.MAIL_OPERATION_MODE, "full");
  assert.equal(config.env.EMAIL_PASS, undefined);
  assert.deepEqual(config.args, [host.SERVER_ENTRY]);
  assert.throws(() => renderConfig({ ...host, EMAIL_PASS: "not-allowed" }));
  assert.throws(() => renderConfig({ ...host, SERVER_ENTRY: "relative/path" }));
  assert.throws(() => renderConfig({ ...host, EMAIL_ADDRESS: "invalid" }));
});
test("plugin archive is validated against the source and cannot overwrite an existing package", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(validatePlugin().version, "1.5.0");
  const output = path.join(directory, "plugin.zip");
  assert.equal(packagePlugin(host, output).files, 6);
  assert.throws(() => packagePlugin(host, output), /overwrite/);
});
