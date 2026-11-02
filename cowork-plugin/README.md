# AT&T Mail Cowork Plugin

Version **1.5.0** adds capability reporting, header-based conversation retrieval, strict test scope, and revision-checked draft management. New-message drafts, attachments, and the Yahoo native reply workflow remain available. This personal plugin connects desktop Cowork to the existing local AT&T/Bellsouth mail MCP server. It contains no password or Secure Mail Key; the server reads the existing macOS Keychain entry at runtime.

## Compose and review

- **New emails with attachments:** `send_email` accepts an `attachments` array of absolute local file paths.
- **Drafts for Yahoo Mail:** `create_draft` saves an unsent message, including attachments, into the account's Drafts folder. You can open it in Yahoo Mail, edit it, and click Send yourself. Recipients and subject are optional; provide `text` and/or `html`.
- **Reply drafts to review/edit in Yahoo:** use `/reply-draft`. This workflow opens the exact original in Yahoo Mail, uses its native **Reply**, adds the requested text and files, saves without sending, and verifies the saved reply headers. It requires browser control of your signed-in Yahoo Mail. If browser control is unavailable, the skill stops and provides manual steps.
- **IMAP reply drafts (limited):** `create_reply_draft` writes correct `In-Reply-To` and `References` headers and attachments initially, with mailbox/UID/UIDVALIDITY and optional Message-ID guards. **Live testing found that Yahoo removes those imported reply headers when saving an edit.** This tool does not provide reliable threading through the Yahoo review/edit workflow, and its result warns about that limitation. A matching Re: subject or visually grouped conversation is not proof of reply headers.
- **Replies sent immediately:** `reply_to_email` and `continue_email_thread` retain conversation threading. These two tools do not accept new attachments in this server build.

For a draft, ask: "Save a draft for me to review in Yahoo Mail, with this attachment. Do not send it." Use `/draft-mail` for a new message and `/reply-draft` for a reply in Yahoo. `/test-mail` checks the connection and available capabilities without sending or creating anything.

Draft creation, update and discard use IMAP only and do not connect to SMTP. A successful result reports `draftSaved: true`, `sent: false`, and a mailbox reference. Each creation call creates a new draft; a completed update returns a replacement reference. The IMAP reply tool reads the original without marking it read or modifying it. Opening an email through the native Yahoo workflow can mark it read. If the parent has no Message-ID, threaded draft creation fails rather than guessing by subject. Self-only replies keep the account as their explicit recipient; a draft with no inferable recipient reports `requiresRecipientReview: true`. If the result says the save outcome is unknown, inspect Yahoo Mail's Drafts folder before retrying.

## Local attachments

This plugin's `.mcp.json` now sets:

```text
MAIL_ALLOWED_ROOTS=<your approved host attachment folder>
MAIL_MAX_ATTACHMENT_BYTES=15728640
MAIL_MAX_DRAFT_BYTES=25000000
```

Put files in that folder before asking the mail MCP to attach them. The raw attachment limit is **15 MiB in total**; a draft's complete encoded message must fit within **25,000,000 bytes**. At most 20 files may be attached per message. The server checks canonical paths and refuses files outside the configured folder.

The allowlist applies to attachment saving as well as reading. Cowork workspace paths may differ from the host paths understood by the local mail process; pass the absolute Mac path above. Do not change the allowlist or authentication settings just to work around a file error.

## Conversation and draft management

`get_capabilities` reports the running release/commit, effective mode, attachment boundaries, supported tools, cached protocol support and limitations without connecting to mail. `get_conversation` retrieves a chronological header-linked timeline across selectable folders, deduplicates copies, and explicitly reports missing ancestors, folder failures and resource limits.

`list_drafts` finds unsent drafts; `get_draft` reads one and supplies a revision. `update_draft` rejects stale revisions, preserves omitted fields/files, verifies a replacement, and moves the original to Trash. `discard_draft` moves a reviewed draft to Trash. Neither sends mail. An interrupted replacement can leave both drafts, so inspect the result before retrying. Signed/encrypted updates use the native editor. Yahoo's imported reply-header limitation still applies.

Strict test scope is an operator-configured own-account conversation boundary. It disables all SMTP and unthreaded draft creation, enforces seed identity and folder restrictions, and limits draft operations to verified related messages. It protects this MCP process; browser automation and other connectors are outside that boundary. Normal production configuration has no test scope unless explicitly configured.

## Exposed tools

- `get_capabilities`
- `get_conversation`
- `list_drafts`
- `get_draft`
- `update_draft`
- `discard_draft`
- `check_connection`
- `list_mailboxes`
- `search_messages`
- `find_unreplied_messages`
- `get_message`
- `get_messages`
- `create_draft`
- `create_reply_draft`
- `send_email`
- `reply_to_email`
- `continue_email_thread`
- `delete_message`
- `move_message`
- `save_attachment`

The plugin launches the shared local server directly; tools are advertised by that server, rather than declared by this README. Skills describe how to use tools and do not replace a missing MCP connection. `MAIL_APPEND_SENT_COPY=false` preserves the existing provider-managed Sent behavior.

Sending, replying, thread continuation, deletion, moving, and attachment saving retain their existing confirmation requirements. Saving a requested draft does not authorize sending it.

## Install or update in desktop Cowork

1. Open Claude Desktop and select Cowork.
2. Open **Customize**, then **Plugins**.
3. Use the custom-plugin upload/update option and choose `att-mail-cowork-plugin-v1.5.0.zip`.
4. Keep or enable the plugin named **att-mail-readonly**. The legacy identifier is retained so the new archive can replace the previous plugin. Its description now includes drafts and attachments.
5. If the UI requires removal before re-import, remove this plugin through Claude Desktop, then import the new ZIP. Do not delete managed plugin folders manually.
6. Start a new desktop Cowork session so the updated MCP configuration and skills load.
7. Invoke `/test-mail` and check for both `create_draft` and `create_reply_draft`, or ask for a recipient-free attachment draft.

The canonical source is the repository’s `cowork-plugin/` directory. Personal `.mcp.json` settings are generated locally from `.mcp.template.json` and are excluded from Git. The ZIP contains the manifest, `.mcp.json`, README, and skills; it references the existing server under `the configured local release directory` and does not bundle another server or any credential.

This setup requires a Cowork session running on this Mac with local MCP support. A web-only/cloud-only session cannot execute the Mac command or read its Keychain. This archive does not create a separate public internet endpoint.

## Development and CI

Changes to this plugin and its server go through pull requests in the [public source repository](https://github.com/spowers16/att-mail-mcp#pull-requests-and-ci). Linux and macOS CI validate the plugin manifest, skills, package rendering, server, and release tooling using fake credentials and temporary files. CI does not use this personal installation or test against Yahoo Mail. Personal `.mcp.json` files and generated plugin ZIPs stay local; importing a new ZIP remains a separate manual step after a verified release.
