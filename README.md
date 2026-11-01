# AT&T Mail development

Canonical source for the local mail server and Claude Cowork plugin. The baseline imports the existing locally hardened server and sanitizes personal plugin paths. See UPSTREAM.md for provenance.

Use Node from `.nvmrc`. Source belongs in a local Developer directory; installed runtimes live separately. Never point a production mail client at this repository's build output.

```sh
npm --prefix server ci --ignore-scripts
git config core.hooksPath .githooks
npm run check
npm run scan
```

`check` runs formatting, lint, typecheck, the server tests, and release/package tests. TLS integration tests use ephemeral loopback IMAP/SMTP services and generated test certificates. OpenSSL, Python 3, Git, and the pinned Node/npm installation are required. No real mail credential is required.

`npm run dev:offline` starts the built MCP with fake credentials, localhost endpoints, and server-enforced draft-only mode. It cannot connect to a provider. Configure production separately using macOS Keychain. `MAIL_OPERATION_MODE=read-only` exposes six read tools, `draft-only` adds the two draft tools, and `full` retains all fourteen existing tools. Restricted modes reject `markSeen=true`, moving, deletion, local attachment saving, and all SMTP operations; even connection checks skip SMTP. The production default remains `full` for compatibility.

Use ordinary feature branches. For parallel work, `git worktree add ../att-mail-feature -b feature/name` creates a separate checkout; install dependencies there independently. No worktree should share `node_modules` or be used as an installed runtime.

Run `npm run release:prepare`, inspect the result, then `npm run release:activate -- <release-name>`. Roll back with `npm run release:rollback`. Both selection commands verify the complete release inventory and probe MCP startup with fake credentials before switching the pointer. Details and recovery procedures are in [docs/RELEASING.md](docs/RELEASING.md).

Private GitHub holds source and offline CI only. Mail credentials, personal install archives, attachments, backups, and acceptance-test evidence stay outside Git. The pinned Gitleaks scanner is checksum-verified when downloaded and scans both source and all local history; the pre-commit hook scans the staged diff. Account security and separate encrypted machine backups remain necessary.
