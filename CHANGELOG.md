# Changelog

Project releases, matching the version in `package.json` and the plugin manifest. The server package version is shown in parentheses. Changes made before this repository existed are recorded in [server/LOCAL_SECURITY_NOTES.md](server/LOCAL_SECURITY_NOTES.md), and upstream changes in [server/CHANGELOG.md](server/CHANGELOG.md).

## Unreleased

- Rewrote the README for people new to the project, and added CONTRIBUTING.md, SECURITY.md, docs/MAINTAINING.md and this changelog.
- Required Linux and macOS pull request checks, and updated the pinned CI actions to Node 24 runtimes.
- Added Dependabot for npm and GitHub Actions, dependency review on pull requests, actionlint and zizmor workflow linting, and informational Node 22/24 compatibility jobs. The secret scan now runs once in its own job.
- `npm run check` and `npm run dev:offline` now run on any Node version allowed by `engines`, with a warning; release commands still require the exact `.nvmrc` version.
- Added a pull request template and CODEOWNERS.

## 1.5.0 (server 2.0.3-att.2) - 2026-11-01

- Added `get_capabilities`, which reports the running release, mode, limits and tools without connecting to mail.
- Added `get_conversation`, which rebuilds a thread from reply headers across folders and reports missing messages and limits.
- Added `list_drafts`, `get_draft`, `update_draft` and `discard_draft`, with revision checks and verified replacement.
- Added strict test scope (`MAIL_TEST_SCOPE`).

## 1.4.0 (server 2.0.3-att.1) - 2026-11-01

- Added `MAIL_OPERATION_MODE` with `read-only`, `draft-only` and `full`.
- Added managed releases with checksum inventories, explicit activation and rollback.
- Added offline TLS tests against loopback IMAP/SMTP fixtures, Gitleaks secret scanning, a pre-commit hook and `dev:offline`.
- Carried over the earlier local extensions: macOS Keychain credentials, `create_draft` and `create_reply_draft`.
