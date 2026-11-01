# Releases and recovery

The Git repository contains `server/`, `cowork-plugin/`, and deployment tooling. `baseline-before-managed-releases` identifies the sanitized import before development/deployment changes. Keep upstream license/provenance when updating dependencies or importing upstream changes.

## Development

Use `.nvmrc` (the same version as the deployed Node command). Run `npm --prefix server ci --ignore-scripts`, `npm run check`, and `npm run scan`. Commit changes on a feature branch and review/merge them before release. CI performs the same offline checks on Linux and macOS, with read-only GitHub permissions and no mail secrets. Do not give CI mail credentials or access to the Mac's Keychain. Dependency or Node upgrades are separate, tested changes.

## Prepare and promote

1. Start from a clean committed checkout. `npm run release:prepare` scans source/history, exports the exact commit to temporary source, installs its locked dependencies, and reruns all checks there. It creates a new candidate with the compiled entry and production dependencies only, verifies startup through MCP, and records Node version, project/server versions, commit, and file checksums.
2. The candidate becomes `~/.local/share/codex-att-mail-mcp/releases/v<version>-<commit>/`. Preparation never selects it for clients. The same commit can reuse an existing verified release; other releases are never overwritten.
3. Run `npm run release:activate -- <release-name>`. It rejects path traversal, concurrent selection, altered/missing files, Node mismatch, or failed MCP startup. It retains the prior target as `previous`, then atomically replaces the `current` symlink. Selection metadata remains local. A stale `.deploy-lock` requires investigation before manual removal; do not delete it during an active deployment.
4. Start a fresh Codex/Cowork session or reconnect the mail MCP so it launches `current/dist/index.js`. Already-running processes can keep using the old version. Verify tool discovery first; authenticating to real mail is a separate opt-in check. Never send an email as an automatic deployment check.

The CLI accepts `--root /absolute/path` for isolated deployment tests. Releases are treated as immutable; there is no build/test source or development dependency installation in them. Never run npm install/clean/build within an installed release. Its inventory also includes internal dependency symlinks; external symlinks are refused.

## Rollback

Run `npm run release:status`, then `npm run release:rollback`. It verifies/probes `previous` and swaps the pointers using the same activation path. Restart the client sessions. The previous and current releases are retained; rollback can be reversed. This changes code only; it does not undo sent emails, drafts, or mailbox changes. Do not use Git reset or copy individual files into a release directory.

The initial migration retains the original full-runtime backup outside Git. Its original server/ and cowork-plugin/ trees and client-configuration snapshot support restoring the pre-migration installation if needed. The baseline tag is source history, not a backup of Keychain or personal settings.

## Personal Claude package

Create ignored `local/host.json` with string values for `NODE_COMMAND`, `SERVER_ENTRY` (the stable current entry), `EMAIL_ADDRESS`, `KEYCHAIN_SERVICE`, and `ATTACHMENT_ROOT`. No password field is accepted. Paths must be absolute.

Run `npm run plugin:package -- local/host.json artifacts/att-mail-cowork-plugin.zip`. The packager renders JSON safely, validates the source identity/version and skills, excludes the template, and verifies all six ZIP files. It refuses to overwrite an existing archive. Personal ZIPs are local outputs; do not commit them. Update/import through Claude Desktop and open a fresh Cowork session. The retained `att-mail-readonly` identifier supports updates.

Legacy client paths may be retained through a local compatibility symlink pointing to `current/dist/index.js`. The legacy source is marked installed and its destructive development scripts are guarded. The canonical source remains this Git repository; never maintain a second development copy on the Desktop.
