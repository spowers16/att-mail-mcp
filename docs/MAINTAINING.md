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

## Dependencies and CI tools

- Dependabot proposes npm and GitHub Actions updates weekly (`.github/dependabot.yml`). Each update is its own pull request and goes through the same checks. Runtime dependencies stay exactly pinned.
- Dependabot doesn't update `.nvmrc`. A Node upgrade is a separate change: update `.nvmrc`, install that version as the deployed Node command, prepare a new release, and update the plugin's `NODE_COMMAND` if its path changes. The `compat` jobs show whether newer Node versions pass first.
- actionlint is downloaded in the `workflow lint` job and checked against a pinned SHA-256. To update it, change `ACTIONLINT_VERSION` and `ACTIONLINT_SHA256` together, using the release's checksums file. The zizmor version is pinned in the same job.

## Repository settings

Branch protection on `main`:

- Require a pull request before merging. Approvals are optional, so a sole maintainer can merge their own pull request after checks pass.
- Require the `check (ubuntu-latest)`, `check (macos-latest)`, `scan`, `workflow lint` and `dependency review` status checks, with the branch up to date. The `compat` jobs are informational and stay optional.
- Require conversation resolution and linear history.
- Apply the rules to administrators, and block force pushes and branch deletion.
- Allow only **Squash and merge** and **Rebase and merge**.

Keep the required check names in sync with the job names in `.github/workflows/check.yml` if the workflow changes.

Also enable:

- Private vulnerability reporting, which [SECURITY.md](../SECURITY.md) relies on
- Secret scanning with push protection, as a second layer behind Gitleaks
- CodeQL default setup for JavaScript/TypeScript and GitHub Actions
- Dependabot alerts and security updates
- Automatically deleting head branches after merge

## Releases and acceptance

- Release preparation, activation, rollback and plugin packaging: [RELEASING.md](RELEASING.md)
- Optional live testing against a real mailbox: [ACCEPTANCE.md](ACCEPTANCE.md)
- Tags use `att-mail-vX.Y.Z`. `baseline-before-managed-releases` marks the sanitized import.
