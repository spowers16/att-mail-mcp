import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { probe } from "./probe.mjs";

export function inventory(directory) {
  const files = {};
  const base = realpathSync(directory);
  function visit(relative = "") {
    for (const name of readdirSync(path.join(base, relative)).sort()) {
      const key = path.posix.join(relative, name);
      if (key === "release.json") continue;
      const file = path.join(base, key);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const resolved = realpathSync(file);
        if (!resolved.startsWith(base + path.sep))
          throw new Error(`Release symlink escapes directory: ${key}`);
        files[key] = { link: readlinkSync(file) };
      } else if (stat.isDirectory()) visit(key);
      else if (stat.isFile())
        files[key] = {
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        };
      else throw new Error(`Unsupported release file: ${key}`);
    }
  }
  visit();
  return files;
}

export function seal(directory, metadata) {
  writeFileSync(
    path.join(directory, ".att-mail-installed.json"),
    JSON.stringify({ developmentAllowed: false }) + "\n",
  );
  const manifest = { format: 1, ...metadata, files: inventory(directory) };
  writeFileSync(
    path.join(directory, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

export function verify(directory) {
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Release directory cannot be a symlink");
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "release.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    manifest.node !== process.versions.node
  )
    throw new Error("Invalid release metadata or Node version mismatch");
  if (
    !manifest.files["dist/index.js"] ||
    !manifest.files["package-lock.json"] ||
    !manifest.files[".att-mail-installed.json"]
  )
    throw new Error("Incomplete release");
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(manifest.files))
    throw new Error("Release checksum/file inventory mismatch");
  return manifest;
}

export function pointer(base, name) {
  const file = path.join(base, name);
  if (
    !existsSync(file) &&
    !(() => {
      try {
        return lstatSync(file).isSymbolicLink();
      } catch {
        return false;
      }
    })()
  )
    return null;
  if (!lstatSync(file).isSymbolicLink())
    throw new Error(`${name} must be a symlink`);
  const target = readlinkSync(file);
  if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target))
    throw new Error(`Unsafe ${name} pointer`);
  return target;
}

function replacePointer(base, name, target) {
  const temporary = path.join(base, `.${name}-${randomUUID()}`);
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, path.join(base, name));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function activate(base, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new Error("Invalid release name");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const lock = path.join(base, ".deploy-lock");
  mkdirSync(lock); // Fail if another activation is in progress.
  try {
    const target = `releases/${name}`;
    const directory = path.join(base, target);
    const manifest = verify(directory);
    await probe(path.join(directory, "dist/index.js"), manifest.serverVersion);
    const old = pointer(base, "current");
    if (old === target) return manifest;
    if (old) {
      verify(path.join(base, old));
      replacePointer(base, "previous", old);
    }
    replacePointer(base, "current", target);
    writeFileSync(
      path.join(base, "activation.json"),
      JSON.stringify(
        {
          current: target,
          previous: old,
          activatedAt: new Date().toISOString(),
          commit: manifest.commit,
        },
        null,
        2,
      ) + "\n",
    );
    return manifest;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function rollback(base) {
  const target = pointer(base, "previous");
  if (!target) throw new Error("No previous managed release exists");
  return activate(base, path.basename(target));
}
