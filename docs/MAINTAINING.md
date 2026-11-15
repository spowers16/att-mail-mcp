# Maintaining

Notes on the maintainer's own setup and the repository settings. Contributors don't need this; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Local layout

- The source checkout lives in a development directory. Installed runtimes live separately under `~/.local/share/codex-att-mail-mcp`. Never point a production mail client at a checkout's build output, because a rebuild would change the code it's running. Use the release flow in [RELEASING.md](RELEASING.md).
- Use the Node version in `.nvmrc` for both development and the deployed Node command.
- Each worktree gets its own `node_modules`. No worktree should be used as an installed runtime.
- Development against real mail needs separate authorization and an explicit operation mode. A worktree isn't a credential sandbox.

## Private settings

- Personal host settings live in `local/host.json`, which Git ignores. The tracked `cowork-plugin/.mcp.template.json` only contains placeholders.
- Mail credentials, personal plugin ZIPs, attachments, backups and acceptance-test evidence stay outside Git.
- Account security and separate encrypted machine backups are still needed; the repository isn't a backup.

## Secret scanning

- `npm run scan` downloads a pinned Gitleaks release, verifies its SHA-256 checksum, caches it in `.tools/`, and scans tracked files and all local history.
- The pre-commit hook scans the staged diff. The source policy in `tools/source-policy.mjs` refuses private or generated paths even if they're force-added.
- To update Gitleaks, change the version and all four platform checksums in `tools/secret-scan.mjs`.

## Repository settings

Branch protection on `main`:

- Require a pull request before merging. Approvals are optional, so a sole maintainer can merge their own pull request after checks pass.
- Require the `check (ubuntu-latest)` and `check (macos-latest)` status checks, with the branch up to date.
- Require conversation resolution and linear history.
- Apply the rules to administrators, and block force pushes and branch deletion.
- Allow only **Squash and merge** and **Rebase and merge**.

Keep the required check names in sync with the job names in `.github/workflows/check.yml` if the workflow changes.

Also enable:

- Private vulnerability reporting, which [SECURITY.md](../SECURITY.md) relies on
- Secret scanning with push protection, as a second layer behind Gitleaks
- Automatically deleting head branches after merge

## Releases and acceptance

- Release preparation, activation, rollback and plugin packaging: [RELEASING.md](RELEASING.md)
- Optional live testing against a real mailbox: [ACCEPTANCE.md](ACCEPTANCE.md)
- Tags use `att-mail-vX.Y.Z`. `baseline-before-managed-releases` marks the sanitized import.
