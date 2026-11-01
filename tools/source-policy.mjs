export function assertSourcePaths(paths) {
  for (const file of paths) {
    if (
      /(^|\/)(node_modules|dist|artifacts|local|backups|outputs)\//.test(
        file,
      ) ||
      /(^|\/)\.mcp\.json$/.test(file) ||
      (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith(".env.example")) ||
      /\.(zip|tar|gz|eml|mbox|sqlite|db|pem|key)$/i.test(file)
    ) {
      throw new Error(`Private/generated file cannot be committed: ${file}`);
    }
  }
}
