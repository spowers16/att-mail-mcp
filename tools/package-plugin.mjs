import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root, run } from "./common.mjs";

export function renderConfig(host) {
  const required = [
    "NODE_COMMAND",
    "SERVER_ENTRY",
    "EMAIL_ADDRESS",
    "KEYCHAIN_SERVICE",
    "ATTACHMENT_ROOT",
  ];
  if (Object.keys(host).some((key) => !required.includes(key)))
    throw new Error("Unexpected host setting; credentials are not accepted");
  for (const name of required)
    if (typeof host[name] !== "string" || !host[name].trim())
      throw new Error(`Missing host setting: ${name}`);
  for (const name of ["NODE_COMMAND", "SERVER_ENTRY", "ATTACHMENT_ROOT"])
    if (!path.isAbsolute(host[name]))
      throw new Error(`${name} must be absolute`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(host.EMAIL_ADDRESS))
    throw new Error("Invalid account address");
  const template = JSON.parse(
    readFileSync(path.join(root, "cowork-plugin/.mcp.template.json")),
  );
  const replace = (value) =>
    typeof value === "string"
      ? value.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
          if (!required.includes(key))
            throw new Error(`Unknown template value: ${key}`);
          return host[key];
        })
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, replace(item)]),
            )
          : value;
  return replace(template);
}

export function validatePlugin() {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "cowork-plugin/.claude-plugin/plugin.json")),
  );
  const version = JSON.parse(
    readFileSync(path.join(root, "package.json")),
  ).version;
  if (manifest.name !== "att-mail-readonly" || manifest.version !== version)
    throw new Error("Plugin identity/version mismatch");
  for (const name of ["draft-mail", "reply-draft", "test-mail"]) {
    const skill = readFileSync(
      path.join(root, `cowork-plugin/skills/${name}/SKILL.md`),
      "utf8",
    );
    if (
      !skill.startsWith(`---\nname: ${name}\n`) ||
      !/^description: .+$/m.test(skill)
    )
      throw new Error(`Invalid skill: ${name}`);
    if (/\/Users\/[A-Za-z0-9_-]+\//.test(skill))
      throw new Error("Personal host path in source skill");
  }
  return manifest;
}

export function packagePlugin(host, output) {
  const manifest = validatePlugin();
  const directory = mkdtempSync(path.join(os.tmpdir(), "att-mail-plugin-"));
  try {
    for (const name of [
      ".claude-plugin/plugin.json",
      "README.md",
      "skills/draft-mail/SKILL.md",
      "skills/reply-draft/SKILL.md",
      "skills/test-mail/SKILL.md",
    ]) {
      mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      cpSync(
        path.join(root, "cowork-plugin", name),
        path.join(directory, name),
      );
    }
    writeFileSync(
      path.join(directory, ".mcp.json"),
      JSON.stringify(renderConfig(host), null, 2) + "\n",
    );
    mkdirSync(path.dirname(output), { recursive: true });
    if (existsSync(output))
      throw new Error("Refusing to overwrite an existing plugin archive");
    run("python3", [
      "-c",
      `import pathlib,sys,zipfile,json
source=pathlib.Path(sys.argv[1]);output=pathlib.Path(sys.argv[2])
files=sorted(p for p in source.rglob('*') if p.is_file())
with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED) as z:
 for p in files:z.write(p,str(p.relative_to(source)))
with zipfile.ZipFile(output) as z:
 assert z.testzip() is None
 assert len(z.namelist())==6
 assert '.mcp.template.json' not in z.namelist()
 assert 'EMAIL_PASS' not in json.loads(z.read('.mcp.json'))['mcpServers']['att_mail']['env']
 for p in files:assert z.read(str(p.relative_to(source)))==p.read_bytes()
`,
      directory,
      output,
    ]);
    return { version: manifest.version, output, files: 6 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [hostFile, output] = process.argv.slice(2);
  if (!hostFile || !output)
    throw new Error(
      "Usage: npm run plugin:package -- local/host.json artifacts/plugin.zip",
    );
  console.log(
    JSON.stringify(
      packagePlugin(JSON.parse(readFileSync(hostFile)), path.resolve(output)),
    ),
  );
}
