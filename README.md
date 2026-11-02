# AT&T Mail development

[![Offline checks](https://github.com/spowers16/att-mail-mcp/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/spowers16/att-mail-mcp/actions/workflows/check.yml)

Canonical source for the local mail server and Claude Cowork plugin. The baseline imports the existing locally hardened server and sanitizes personal plugin paths. See UPSTREAM.md for provenance.

## Local development

```sh
git clone https://github.com/spowers16/att-mail-mcp.git
cd att-mail-mcp
```

Use Node from `.nvmrc`. Source belongs in a local Developer directory; installed runtimes live separately. Never point a production mail client at this repository's build output.
If you use nvm, run `nvm use` before installing dependencies or running checks.

```sh
npm --prefix server ci --ignore-scripts
git config core.hooksPath .githooks
npm run check
npm run scan
```

`check` runs formatting, lint, typecheck, the server tests, and release/package tests. TLS integration tests use ephemeral loopback IMAP/SMTP services and generated test certificates. OpenSSL, Python 3, Git, and the pinned Node/npm installation are required. No real mail credential is required.

`npm run dev:offline` starts the built MCP with fake credentials, localhost endpoints, and server-enforced draft-only mode. It cannot connect to a provider. Configure production separately using macOS Keychain. `MAIL_OPERATION_MODE=read-only` exposes ten read tools, `draft-only` adds the draft creation/update/discard tools, and `full` retains all twenty tools. Restricted modes reject `markSeen=true`, moving, deletion, local attachment saving, and all SMTP operations; even connection checks skip SMTP. The production default remains `full` for compatibility.

Use ordinary feature branches. For parallel work, `git worktree add ../att-mail-feature -b feature/name` creates a separate checkout; install dependencies there independently. No worktree should share `node_modules` or be used as an installed runtime.

## Pull requests and CI

Open a pull request into `main` for each change. The [Offline checks workflow](.github/workflows/check.yml) runs when a PR is opened, reopened, or updated, including draft PRs and documentation changes. It also runs on pushes to `main` after merging and can be started manually from the repository's Actions tab. Feature-branch pushes are checked through their PR, avoiding duplicate push and PR runs. A new commit cancels an outdated run for the same PR.

Both `check (ubuntu-latest)` and `check (macos-latest)` must pass before merging. Each job uses the pinned Node version and locked dependencies, scans source and Git history for secrets, and runs formatting, lint, TypeScript checks, the release bundle build, and the server/release/plugin tests. These tests use fake credentials, temporary files, and loopback mail fixtures. CI has read-only GitHub permissions and no mail credentials, Keychain access, live mailbox tests, or deployment steps.

`main` requires a pull request, an up-to-date branch with both successful checks, resolved review conversations, and linear history. Use **Squash and merge** or **Rebase and merge**. These rules apply to administrators; force pushes and branch deletion are blocked. Independent reviewer approval is optional so a sole maintainer can merge their own PR after checks pass. Keep the two job names aligned with branch protection if changing the workflow.

## Releases and private settings

Run `npm run release:prepare`, inspect the result, then `npm run release:activate -- <release-name>`. Roll back with `npm run release:rollback`. Both selection commands verify the complete release inventory and probe MCP startup with fake credentials before switching the pointer. Details and recovery procedures are in [docs/RELEASING.md](docs/RELEASING.md).

This public GitHub repository holds source and offline CI only. Mail credentials, personal install archives, attachments, backups, and acceptance-test evidence stay outside Git. Keep personal host settings in ignored `local/host.json`; the plugin's tracked `.mcp.template.json` contains placeholders. The pinned Gitleaks scanner is checksum-verified when downloaded and scans both source and all local history; the pre-commit hook scans the staged diff. Account security and separate encrypted machine backups remain necessary.

The v1.5 workflow tools are `get_capabilities`, `get_conversation`, `list_drafts`, `get_draft`, `update_draft`, and `discard_draft`. See [docs/MAIL-WORKFLOWS.md](docs/MAIL-WORKFLOWS.md) for strict test-scope configuration, revision semantics, limits and known provider behavior.
