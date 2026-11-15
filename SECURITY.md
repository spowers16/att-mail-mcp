# Security policy

This project gives an AI assistant access to an email account, so security reports are taken seriously.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.

Include the version or commit, your operation mode and relevant configuration (with personal values removed), and steps to reproduce. Use example data only. Never send real credentials, secure mail keys or real email content.

This project has a single maintainer, so reports are handled on a best-effort basis. You should get an initial reply within about a week.

## Supported versions

Fixes are made on `main` and included in the next release. Older releases don't receive separate fixes.

## In scope

- Running a tool in an operation mode that should block it, or escaping strict test scope (`MAIL_TEST_SCOPE`)
- Reading or writing files outside `MAIL_ALLOWED_ROOTS`
- Exposing credentials through logs, errors, tool results, capability reports or process arguments
- Bypassing TLS certificate verification
- Email content causing the server itself to take an action it wasn't asked to take
- Weaknesses in release verification, such as the checksum inventory, activation or rollback

## Out of scope

- An MCP client or model calling a tool that the configured mode allows. Prompt injection that leads to an allowed call is a client and model concern; use a stricter mode to limit it. Reports of ways the server could reduce that risk are still welcome as regular issues.
- Vulnerabilities in AT&T or Yahoo services
- Attacks that require someone who can already run code as your user or read your Keychain

## Security model

- The operation mode (`read-only`, `draft-only` or `full`) is enforced by the server at dispatch, not just by hiding tools.
- On macOS the secure mail key is read from the Keychain at startup and never written to configuration files.
- Local file access is limited to `MAIL_ALLOWED_ROOTS` using canonical path checks, and is off when unset.
- TLS certificate verification is on by default.
- CI runs with read-only permissions and without credentials. Releases are prepared and activated locally, never deployed automatically from GitHub.
