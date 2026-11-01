import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activate,
  inventory,
  pointer,
  rollback,
  seal,
  verify,
} from "../release-lib.mjs";
import { root } from "../common.mjs";

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "release-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function release(name, entry) {
    const directory = path.join(base, "releases", name);
    mkdirSync(path.join(directory, "dist"), { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(path.join(directory, "package-lock.json"), "{}\n");
    writeFileSync(
      path.join(directory, "dist/index.js"),
      entry ??
        `import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.id===1?{serverInfo:{version:'fixture'}}:{tools:['send_email','create_reply_draft',...Array.from({length:12},(_,i)=>'tool'+i)].map(name=>({name}))}}));});`,
    );
    seal(directory, {
      commit: "a".repeat(40),
      node: process.versions.node,
      serverVersion: "fixture",
      version: name,
    });
    return directory;
  }
  return { base, release };
}

test("activation and rollback select complete releases and preserve the prior runtime", async (t) => {
  const { base, release } = fixture(t);
  const first = release("first");
  release("second");
  const before = readFileSync(path.join(first, "dist/index.js"), "utf8");
  await activate(base, "first");
  await activate(base, "second");
  assert.equal(pointer(base, "current"), "releases/second");
  assert.equal(pointer(base, "previous"), "releases/first");
  await rollback(base);
  assert.equal(pointer(base, "current"), "releases/first");
  assert.equal(pointer(base, "previous"), "releases/second");
  assert.equal(readFileSync(path.join(first, "dist/index.js"), "utf8"), before);
});

test("a corrupt or incomplete candidate leaves active and previous pointers unchanged", async (t) => {
  const { base, release } = fixture(t);
  release("good");
  const broken = release("broken");
  await activate(base, "good");
  writeFileSync(path.join(broken, "dist/index.js"), "corrupt");
  await assert.rejects(activate(base, "broken"), /inventory mismatch/);
  await assert.rejects(activate(base, "missing"));
  assert.equal(pointer(base, "current"), "releases/good");
  assert.equal(pointer(base, "previous"), null);
});

test("a checksummed runtime that cannot initialize is never activated", async (t) => {
  const { base, release } = fixture(t);
  release("good");
  release("cannot-start", "process.exit(7);");
  await activate(base, "good");
  await assert.rejects(activate(base, "cannot-start"), /exited early/);
  assert.equal(pointer(base, "current"), "releases/good");
});

test("a release with a different advertised tool set is never activated", async (t) => {
  const { base, release } = fixture(t);
  release("good");
  const candidate = release("wrong-tools");
  const manifest = JSON.parse(
    readFileSync(path.join(candidate, "release.json")),
  );
  manifest.tools = ["send_email", "create_reply_draft", "unexpected-tool"];
  writeFileSync(path.join(candidate, "release.json"), JSON.stringify(manifest));
  await activate(base, "good");
  await assert.rejects(activate(base, "wrong-tools"), /tool set mismatch/);
  assert.equal(pointer(base, "current"), "releases/good");
});

test("extra files, escaping symlinks, and malformed metadata fail verification", (t) => {
  const { base, release } = fixture(t);
  const directory = release("one");
  writeFileSync(path.join(directory, "unexpected.txt"), "extra");
  assert.throws(() => verify(directory), /inventory mismatch/);
  rmSync(path.join(directory, "unexpected.txt"));
  symlinkSync(path.join(base, "releases"), path.join(directory, "escape"));
  assert.throws(() => inventory(directory), /escapes/);
  rmSync(path.join(directory, "escape"));
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "release.json")),
  );
  manifest.node = "wrong";
  writeFileSync(path.join(directory, "release.json"), JSON.stringify(manifest));
  assert.throws(() => verify(directory), /Node version mismatch/);
});

test("path traversal and concurrent deployment are rejected", async (t) => {
  const { base, release } = fixture(t);
  release("one");
  await assert.rejects(activate(base, "../one"), /Invalid/);
  mkdirSync(path.join(base, ".deploy-lock"));
  await assert.rejects(activate(base, "one"));
  assert.equal(pointer(base, "current"), null);
});

test("installed-runtime guard stops development before its existing bundle can be removed", (t) => {
  const { base } = fixture(t);
  mkdirSync(path.join(base, "scripts"));
  mkdirSync(path.join(base, "dist"));
  writeFileSync(path.join(base, ".att-mail-installed.json"), "{}");
  writeFileSync(path.join(base, "dist/index.js"), "preserve me");
  copyFileSync(
    path.join(root, "server/scripts/development-guard.ts"),
    path.join(base, "scripts/development-guard.mjs"),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(base, "scripts/development-guard.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed mail runtime/);
  assert.equal(
    readFileSync(path.join(base, "dist/index.js"), "utf8"),
    "preserve me",
  );
});
