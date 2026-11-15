# Contributing

Thanks for your interest. Issues and pull requests are welcome. Because this project gives an AI assistant access to someone's mailbox, changes are held to a high bar for safety and test coverage.

## Ground rules

- Never commit credentials, secure mail keys, real email content, mailbox exports, screenshots of mail, or personal configuration such as `local/host.json` and `cowork-plugin/.mcp.json`. The secret scan and source policy check catch common cases, but they don't replace care.
- Tests use fake credentials and local loopback IMAP/SMTP servers. Don't add tests that connect to a real mailbox. Live testing is a separate, opt-in process described in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
- Treat email content as untrusted input, both in server code and in skill instructions.
- Don't run builds, tests or `npm install` inside an installed release directory. The development scripts refuse to.

## Set up

You need Git, OpenSSL, Python 3, and the exact Node.js version in [`.nvmrc`](.nvmrc). The repository tools refuse to run on any other version.

```sh
git clone https://github.com/spowers16/att-mail-mcp.git
cd att-mail-mcp
nvm install
npm --prefix server ci --ignore-scripts
git config core.hooksPath .githooks
```

The pre-commit hook scans your staged changes for secrets.

## Checks

| Command               | What it does                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`       | Formatting, lint, TypeScript checks, the release bundle build, server tests, and release/plugin tooling tests.                                    |
| `npm run scan`        | Gitleaks over tracked files and the full Git history, plus a check that no private or generated files are tracked.                                |
| `npm run dev:offline` | Starts the built server (after `npm run check`) with fake credentials, localhost endpoints and `draft-only` mode. It can't reach a real provider. |

Run `npm run check` and `npm run scan` before opening a pull request.

## Making a change

- Branch from `main` and keep each pull request to one change.
- For parallel work, `git worktree add ../att-mail-feature -b feature/name` creates a separate checkout. Install dependencies in each worktree; don't share `node_modules`.
- Update the documentation and [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

### Adding or changing a tool

1. Define it in `server/src/tool-definitions.ts` with accurate annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
2. Classify it in `server/src/operation-policy.ts`. **The policy blocks the tools it lists, so a tool you don't add there is allowed in every mode, including `read-only`.** Add tests to `server/test/operation-policy.test.ts` showing it's blocked in each mode where it shouldn't run.
3. If it reads or changes messages, make it respect strict test scope (`server/src/mail-scope.ts`) and test that.
4. Cover IMAP/SMTP behavior with the loopback fixtures in `server/test/protocol.test.ts`.
5. Update the tool lists in [README.md](README.md) and [cowork-plugin/README.md](cowork-plugin/README.md), and the plugin skills if the workflow changes.

### Versions

- The project version in `package.json` and the plugin version in `cowork-plugin/.claude-plugin/plugin.json` must match. The plugin packager checks this.
- The server package keeps its own upstream-based version (`2.0.3-att.N`), which must match `server/src/version.ts`. `npm run check` enforces this.
- Release tags use the form `att-mail-vX.Y.Z`.

## Pull requests and CI

The [Offline checks workflow](.github/workflows/check.yml) runs when a pull request into `main` is opened, reopened or updated, including drafts and documentation-only changes. It also runs after merges to `main` and can be started manually from the Actions tab. A new commit cancels the outdated run for the same pull request.

Both `check (ubuntu-latest)` and `check (macos-latest)` must pass. Each job uses the pinned Node version and locked dependencies, scans source and history for secrets, and runs `npm run check`. CI has read-only repository permissions and no mail credentials, Keychain access, live mailbox tests or deployment steps.

Before merging, your branch must be up to date with `main` and all review conversations must be resolved. Pull requests are merged with **Squash and merge** or **Rebase and merge** to keep history linear.
