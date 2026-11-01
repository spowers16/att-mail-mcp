# Opt-in provider acceptance

Offline CI verifies the compiled MCP against loopback TLS IMAP and SMTP services. It cannot establish Yahoo's browser editor behavior. Do not connect an automated test to a real account by default, and never reuse an unrelated email as test data.

For a mail-facing release, separately obtain the user's authorization for the exact live test. Prefer a dedicated test account. If using the normal account, restrict every operation to a newly authorized unique test conversation; sending a seed is a separate explicitly authorized action. Record the seed Message-ID, mailbox UID, UIDVALIDITY, exact recipient, and unique subject before creating any reply draft. Use a harmless attachment from the allowed folder. Keep this record and all mail/screenshot evidence outside Git.

Acceptance checks:

- A new imported draft retains requested text and attachment bytes after Yahoo edit/save/reopen, and remains unsent.
- An imported reply initially has In-Reply-To/References but Yahoo editing may remove them. This is a known unsupported review workflow, not a passing threading test.
- A native Yahoo Reply draft retains the exact parent In-Reply-To/References and requested attachment after edit/save/reopen. Verify by fresh read-only IMAP, not visual conversation grouping.
- Sent contains only the separately authorized seed; no reply is sent. Do not touch drafts or messages outside the unique test conversation.

Stop on ambiguous message identity, unexpected recipients, uncertain save outcome, or failed header verification. Inspect rather than retrying blindly. Leave sending to the user. Browser automation availability depends on the client session; the plugin ZIP cannot grant browser control.
