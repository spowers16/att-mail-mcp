# Local security-pinned build

- Upstream: `https://github.com/yunfeizhu/mcp-mail-server`
- Upstream commit: `4ad4bab306ee5176c40202dcc141643881d75509`
- Upstream package version: `2.0.2`
- Audited: `2026-09-20`

Local hardening changes:

1. Runtime dependencies are pinned to exact, advisory-clean versions in `package-lock.json` and fetched from `registry.npmjs.org` with integrity hashes.
2. macOS Keychain retrieval is supported through `EMAIL_KEYCHAIN_SERVICE` and `EMAIL_KEYCHAIN_ACCOUNT`; the credential is read in memory by a fixed `/usr/bin/security` invocation and is never supplied in process arguments or Codex configuration.
3. Nodemailer 10's optional SMTP response field is normalized to an empty string for compatibility with the existing result schema.

The upstream quality gate (format, lint, TypeScript, build, and 64 tests) passes with these changes. No credential is stored in this directory.

## Local draft extension — 2026-10-31

- Added `create_draft`, which composes MIME using an in-memory stream transport and saves it using IMAP APPEND with Draft and Seen flags. It does not request, access, or connect to SMTP.
- Supports text/HTML, signatures, To/CC/BCC, recipient-free drafts, and local attachments through the existing filesystem allowlist.
- Checks both aggregate raw attachment bytes and the full encoded draft size. Stops on ambiguous APPEND outcomes rather than risking a duplicate.
- Original source, dependencies, compiled runtime, and AT&T configuration were archived and hash-verified before modifications. No Git repository was present.
- Live draft-only verification on 2026-10-31 passed: Yahoo recognized the imported draft, preserved its 69-byte text attachment, previewed the correct contents, and saved an edit that survived reopening and a fresh IMAP readback. The draft had no recipients, and Sent contained no matching message. Yahoo does not retain the IMAP Draft flag; its Draft folder still opens the message in the compose editor. The local test suite itself creates no live messages.

## Threaded reply draft extension — 2026-11-01

- Added `create_reply_draft` with required mailbox UIDVALIDITY, an optional expected Message-ID guard, and rejection of parents without Message-ID.
- Preserves In-Reply-To, References, Reply-To/To/CC handling, signatures, and quoted original content. Local attachments use the existing allowlist and byte limits.
- New and reply drafts share the IMAP-only save path. Parent reads remain read-only; reply drafts never request an SMTP connection.
- The live validation is restricted to a uniquely tagged test message sent to the account itself. Its reply draft remains unsent; other messages are outside the test scope.

- Live edit test found a provider limitation: Yahoo rewrites IMAP-imported reply drafts without In-Reply-To or parent References. Initial MIME correctness does not imply the reviewed draft remains threaded. Tool description/results now disclose this.
- A native Yahoo Reply draft retained both parent headers after adding the 107-byte test attachment, editing, and saving. The Cowork reply-draft skill therefore uses native Yahoo Reply with browser control and read-only header verification, and stops with manual steps if browser control is unavailable. No reply was sent.

## Managed development and releases — 2026-11-01

- Canonical development is isolated from the installed runtime. Development scripts reject an installed-runtime marker before deleting or rebuilding output.
- MAIL_OPERATION_MODE supports read-only, draft-only, and full. Restricted modes hide blocked tools and enforce the policy at dispatch, including rejecting markSeen=true. Connection checks skip SMTP in restricted modes. The default full mode preserves production behavior.
- Offline compiled-server integration uses generated certificates and loopback TLS IMAP/SMTP fixtures. It checks attachment bytes, reply headers, Bcc envelope behavior, and zero SMTP connections for restricted modes. Real credentials and mailbox data are not needed.
- Runtime releases include locked production dependencies, a complete checksum inventory, source commit, and Node/local version metadata. Candidate preparation is separate from atomic activation; startup/verification failures leave the active release selected.

## Workflow extension — v1.5

- Strict operator-configured own-account test scope validates a mailbox UID/UIDVALIDITY/Message-ID seed, adds search restrictions and header preflights, and disables every SMTP tool. Batch reads preflight all UIDs before fetching bodies. The normal production profile remains unscoped.
- Capability reporting returns whitelisted release/mode/limit/path data and cached protocol support; it never dumps credentials or authentication identifiers and opens no mail connections.
- Conversation reconstruction uses exact reply headers, deduplicates mailbox copies, and reports missing ancestors, mailbox failures, body truncation and bounded-search limits.
- Draft updates require a raw-MIME revision and Message-ID, preserve omitted fields/attachments/inline CIDs, and verify replacement content before a fresh check and move to Trash. Discard uses Trash, not permanent deletion. Unknown/partial outcomes do not trigger automatic retries. Signed/encrypted rewrites are refused.
- The test boundary covers MCP operations only. Skills explicitly prohibit browser/other-connector workarounds; native Yahoo review behavior remains a separately authorized acceptance test.
