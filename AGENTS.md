# Working on AT&T mail

This repository is the canonical development source. Installed runtime directories are deployment outputs. Never edit, rebuild, clean, or run tests in an installed release or the legacy compatibility directory.

- Use the Node version in `.nvmrc` for development and deployment. Install independent dependencies in each worktree with `npm --prefix server ci --ignore-scripts`.
- Run `npm run check` and `npm run scan` before committing a change. The tests use fake credentials and loopback services; they do not require Keychain or real email.
- Keep personal host settings in ignored `local/host.json`. Never commit credentials, client configuration, attachments, mailbox exports, test correspondence, screenshots, or full backups. The plugin source uses a configuration template.
- Development with real mail requires separate user authorization and an explicit operation mode. The offline launcher supplies fake credentials, localhost ports, and draft-only mode. A worktree is not a credential sandbox.
- Prepare a release from a clean committed tree, then activate it explicitly. Never automatically deploy a GitHub push. See `docs/RELEASING.md`.
- A draft request does not authorize sending. Yahoo strips reply headers from edited IMAP-imported drafts; preserve this warning and the native Reply skill. Live provider acceptance is separate and opt-in, as described in `docs/ACCEPTANCE.md`.

- Strict scope (`MAIL_TEST_SCOPE`) is operator configuration. It forces SMTP off and binds reads/drafts to the configured own-account seed/folders. Do not disable it, use browser automation, or select another connector to get around a rejected operation. The normal production profile has no scope configured.
- Draft mutations require current `get_draft` identity/revision. On partial/unknown replacement or Trash movement, inspect before retrying. Preserve omitted attachments and native Yahoo reply limitations.
