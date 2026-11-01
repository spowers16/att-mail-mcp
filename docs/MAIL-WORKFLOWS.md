# Mail workflows in v1.5

## Capability report

`get_capabilities` requires no arguments and opens no mail connection. It reports the server and installed project version/commit, Node version, configured/effective mode, enabled/disabled tools, allowed attachment folders and limits, configured Drafts/Trash overrides, cached protocol support, test scope, and provider limitations. Unknown protocol support remains null until an explicit connection has been made. It never dumps the environment, password, or Keychain service/account identifiers. Authentication configuration is loaded separately at MCP startup.

The reported tools are server-advertised capabilities. Codex/Cowork can further hide tools or require approval through client settings, which the server cannot inspect through MCP. Refresh the client session after updating the server, and check the client's tool allowlist if a reported tool is unavailable. A server release version also does not establish which plugin skill version a client has installed.

## Strict test scope

Set `MAIL_TEST_SCOPE` to JSON in a separate test MCP process's environment. It is trusted operator configuration, not a tool argument. An example (replace every identity value with one separately authorized own-account test message):

```json
{
  "account": "tester@example.com",
  "seed": {
    "mailbox": "INBOX",
    "uid": 41,
    "uidValidity": 7,
    "messageId": "<self-test@example.com>"
  },
  "mailboxes": ["INBOX", "Sent", "Draft", "Trash"]
}
```

The account must equal `EMAIL_ADDRESS` (or `EMAIL_USER` when no address override exists). The seed must have the exact UID/UIDVALIDITY/Message-ID, with its sender and all recipients belonging to that same account. The seed is verified through header-only reads before scoped mail operations. Related messages must link to the seed using actual reply headers and use only that account's addresses. Subject equality is insufficient. Required UIDVALIDITY checks and header preflights prevent body reads outside the scope; batch reads preflight every UID before fetching any body. Search criteria are constrained to the scope and results are checked again.

Scoped processes force effective `draft-only` mode (or retain `read-only` if configured), disable every SMTP tool and unthreaded `create_draft`, restrict folders, and reject outside recipients or unrelated draft references. They do not create a test seed. Scope values cannot be changed by an MCP call. Missing/invalid configuration fails closed at startup; missing/changed seed identity stops scoped operations. Include the actual Drafts/Trash folders for draft lifecycle tests; missing allowed Trash causes updates to stop before APPEND.

Keep this JSON and personal MCP settings outside Git. Do not add scope to the normal production profile unintentionally. This is an MCP-process boundary: it does not constrain filesystem tools, browser automation, another mail connector, or a separate unrestricted MCP process. Skills must not use these as a workaround. Native Yahoo browser editing is therefore excluded from scoped test workflows; test it only through a separately authorized provider acceptance flow.

## Conversations

`get_conversation` requires a seed mailbox/UID/UIDVALIDITY. Pass `expectedMessageId` when available. It traverses exact Message-ID, In-Reply-To and References links across all selectable account folders by default, or up to twenty explicit `mailboxes`. It does not group messages by subject. Duplicate copies retain their distinct mailbox references but share one timeline entry.

The result includes chronological messages, copies, searched folders, missing referenced IDs, mailbox/body errors, and `complete`/`completeWithinSearchedMailboxes`/`truncated`. A missing/deleted ancestor, missing reply headers, unavailable folder, or a resource limit is reported rather than silently treated as a complete conversation. Limits include configured candidate/header/body budgets, 500 discovered IDs, 200 search commands, and a requested message limit of up to 200. More than twenty folders requires an explicit selection. `includeBody=false` returns headers only; full reads do not mark seen. Yahoo UI conversation grouping can differ from this header graph.

## Existing drafts

1. `list_drafts` searches selectable Drafts folders for header summaries, optionally narrowed by subject/date and limit. Standard search budgets apply; `hasMore` describes matches beyond the requested limit.
2. `get_draft` requires mailbox/UID/UIDVALIDITY and returns body, attachment metadata, Message-ID and a revision bound to the raw MIME and that exact reference. It does not mark seen.
3. `update_draft` requires those values as `expectedMessageId` and `revision`, plus at least one changed field. Omitted fields/files are preserved; an explicit attachment array replaces the entire set (empty removes all). A supplied text/HTML body replaces the prior body alternatives. Attachment count/raw-byte/encoded-message limits and file boundaries apply. Reply-To, Bcc, reply headers and attachment contents/inline CIDs are retained for compatible MIME. Signed/encrypted MIME is refused.
4. The server checks the old revision before APPEND, creates a new Message-ID, saves only in the same Drafts folder, reads back and verifies the replacement, then checks the old revision again and moves the old UID to Trash. The result supplies a **new** UID/revision. It never connects to SMTP. No old draft is removed before replacement verification.
5. `discard_draft` requires the reviewed identity/revision and moves only that UID to a selectable Trash folder. It never invokes permanent deletion. Set `MAIL_TRASH_MAILBOX` if special-use/name discovery cannot select the correct existing folder.

IMAP replacement is not a single transaction. Lost APPEND or MOVE confirmations, a concurrent Yahoo edit, or failed readback can leave two drafts or an uncertain original location. Such results are errors with explicit partial state and replacement identifiers. Inspect Drafts/Trash before retrying; do not blindly create another replacement. Never substitute permanent deletion to finish cleanup. The methods require IMAP MOVE or safe UIDPLUS fallback for movement.

Yahoo editing can strip the reply headers of imported/replaced IMAP drafts. The native Yahoo Reply skill remains the supported workflow for a reply the user will edit in Yahoo. Draft management does not add a send-existing-draft operation and never authorizes sending.
