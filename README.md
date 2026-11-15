# AT&T Mail MCP

[![Offline checks](https://github.com/spowers16/att-mail-mcp/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/spowers16/att-mail-mcp/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local [MCP](https://modelcontextprotocol.io) server that lets Claude and other AI assistants search, read, draft and (only if you allow it) send email from an AT&T Mail account. A server-enforced operation mode decides what the assistant is allowed to change.

It runs on your own computer and connects directly to AT&T's IMAP and SMTP servers over TLS. There's no hosted service in between, and your secure mail key stays in the macOS Keychain.

The repository also includes an optional Claude plugin with skills for drafting mail and for saving reply drafts in Yahoo Mail.

## What you can ask

| Goal                  | Example                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Catch up              | "Summarize my unread email from this week."                                                 |
| Find something        | "Find the messages from my landlord about the lease renewal."                               |
| Follow a thread       | "Show me the whole conversation for that message, including what I sent."                   |
| Find loose ends       | "Which emails from last week haven't I replied to?"                                         |
| Draft without sending | "Draft a reply to Dana and attach the quote PDF from my attachments folder. Don't send it." |
| Revise a draft        | "Change the subject of that draft to Kitchen quote and remove the old attachment."          |
| Send (full mode only) | "Send the draft text above to dana@example.com."                                            |

## Safety model

Set `MAIL_OPERATION_MODE` to choose what the assistant can do. The server hides blocked tools and also rejects them if they're called anyway.

| Mode         | Allows                                                                                                | Tools |
| ------------ | ----------------------------------------------------------------------------------------------------- | ----- |
| `read-only`  | Searching and reading. Messages stay unread, and no SMTP connection is made.                          | 10    |
| `draft-only` | Everything in `read-only`, plus creating, editing and discarding drafts. Still no SMTP.               | 14    |
| `full`       | Everything, including sending, replying, moving, permanently deleting and saving attachments to disk. | 20    |

> [!IMPORTANT]
> If `MAIL_OPERATION_MODE` isn't set, the server runs in `full` mode for compatibility with earlier versions. Set it explicitly. `draft-only` is a good place to start.

Other safeguards:

- **Credentials:** on macOS the secure mail key is read from the Keychain at startup and is never written to config files or passed as a command-line argument. On other systems the server falls back to the `EMAIL_PASS` environment variable.
- **Files:** attachments can only be read from or saved to folders listed in `MAIL_ALLOWED_ROOTS`. Local file access is off when it's unset.
- **Transport:** TLS certificates are verified by default, and IMAP requires implicit TLS (port 993).
- **Drafts:** edits must supply the draft's current revision, so a stale edit fails instead of overwriting newer changes. A replaced draft only moves to Trash after the new copy has been read back and verified. Draft tools never delete permanently.
- **Limits:** message, attachment, body and response sizes are capped and configurable.
- **Testing:** `MAIL_TEST_SCOPE` restricts a separate server process to one of your own test conversations and turns SMTP off. See [docs/MAIL-WORKFLOWS.md](docs/MAIL-WORKFLOWS.md#strict-test-scope).

The server enforces the mode. Asking you to confirm a send, move or delete before it happens is up to your MCP client, so pick a mode that only allows what you're comfortable with. Treat email content as untrusted: a message can contain instructions aimed at the assistant.

## Tools

| Group                  | Tools                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read (all modes)       | `get_capabilities`, `check_connection`, `list_mailboxes`, `search_messages`, `find_unreplied_messages`, `get_message`, `get_messages`, `get_conversation`, `list_drafts`, `get_draft` |
| Drafts (`draft-only`+) | `create_draft`, `create_reply_draft`, `update_draft`, `discard_draft`                                                                                                                 |
| Changes (`full` only)  | `send_email`, `reply_to_email`, `continue_email_thread`, `move_message`, `delete_message` (permanent), `save_attachment`                                                              |

Parameters for each tool are in the [server reference](server/README.md#tools-at-a-glance) and [docs/MAIL-WORKFLOWS.md](docs/MAIL-WORKFLOWS.md).

## Supported accounts and platforms

- **Accounts:** built and tested with a bellsouth.net address. AT&T's other legacy addresses (att.net, sbcglobal.net, pacbell.net and so on) use the same `imap.mail.att.net` and `smtp.mail.att.net` servers, so they should work, but they haven't been tested. Please [open an issue](https://github.com/spowers16/att-mail-mcp/issues) with your results.
- **Sign-in:** AT&T secure mail key only. OAuth isn't supported.
- **Platforms:** macOS is the main target (Keychain). Linux works with `EMAIL_PASS`, and CI runs on both. Windows isn't tested.

## Quick start

### Requirements

- Git, and [nvm](https://github.com/nvm-sh/nvm) or another way to install the exact Node.js version in [`.nvmrc`](.nvmrc)
- OpenSSL and Python 3 (the test suite runs during release preparation)
- An AT&T Mail address and a secure mail key

### 1. Create a secure mail key

AT&T doesn't accept your regular password from third-party apps. In your AT&T account profile, choose **Settings**, select **Add secure mail key**, give it a nickname, and copy the 16-character key. AT&T's [Create a secure mail key](https://www.att.com/support/article/email-support/KM1240308/) article has the details.

### 2. Store it in the macOS Keychain

```sh
security add-generic-password -s att-mail-mcp -a you@bellsouth.net -w
```

Leaving `-w` at the end makes `security` prompt for the key, so it doesn't end up in your shell history. You can choose any service name in place of `att-mail-mcp`; you'll use it again in step 5.

### 3. Get the source

```sh
git clone https://github.com/spowers16/att-mail-mcp.git
cd att-mail-mcp
nvm install
npm --prefix server ci --ignore-scripts
```

### 4. Install a verified release

```sh
npm run release:prepare
npm run release:activate -- <release name printed by prepare>
```

`release:prepare` exports the current commit to a temporary folder, runs the secret scan and the full test suite there, and installs the result under `~/.local/share/codex-att-mail-mcp/releases/`. `release:activate` checks the release again and points `~/.local/share/codex-att-mail-mcp/current` at it. Your MCP client runs `current/dist/index.js`, so later work in your checkout can't change the code it's running. `npm run release:rollback` switches back to the previous release. See [docs/RELEASING.md](docs/RELEASING.md).

### 5. Add the server to your MCP client

This works as-is in Claude Desktop's `claude_desktop_config.json` and in a Claude Code `.mcp.json`. Other clients take the same command, arguments and environment variables in their own format.

```json
{
  "mcpServers": {
    "att_mail": {
      "command": "/absolute/path/to/node",
      "args": [
        "/Users/you/.local/share/codex-att-mail-mcp/current/dist/index.js"
      ],
      "env": {
        "IMAP_HOST": "imap.mail.att.net",
        "IMAP_PORT": "993",
        "IMAP_SECURE": "true",
        "SMTP_HOST": "smtp.mail.att.net",
        "SMTP_PORT": "465",
        "SMTP_SECURE": "true",
        "EMAIL_USER": "you@bellsouth.net",
        "EMAIL_ADDRESS": "you@bellsouth.net",
        "EMAIL_KEYCHAIN_SERVICE": "att-mail-mcp",
        "EMAIL_KEYCHAIN_ACCOUNT": "you@bellsouth.net",
        "MAIL_OPERATION_MODE": "draft-only",
        "MAIL_APPEND_SENT_COPY": "false",
        "MAIL_ALLOWED_ROOTS": "/Users/you/MailAttachments",
        "MAIL_MAX_ATTACHMENT_BYTES": "15728640"
      }
    }
  }
}
```

- `command`: the Node.js you built with. `nvm which` prints its path.
- `MAIL_APPEND_SENT_COPY`: `false` because AT&T already saves sent mail to your Sent folder.
- `MAIL_ALLOWED_ROOTS`: an existing folder for attachments you want to send or save. Leave it out to turn off file access.

Restart your client, then ask: _"Check my AT&T mail connection."_

### 6. (Optional) Install the Claude plugin

[`cowork-plugin/`](cowork-plugin/) adds three skills for the Claude desktop app:

- `/draft-mail` saves a new draft, with attachments, for you to review and send yourself in Yahoo Mail.
- `/reply-draft` creates a reply draft through Yahoo Mail's own Reply button using browser control, so threading survives later edits (see [known limitations](#known-limitations)).
- `/test-mail` checks the connection and the available tools without sending or creating anything.

The plugin is built locally because its configuration contains your paths. Create `local/host.json`, which Git ignores:

```json
{
  "NODE_COMMAND": "/absolute/path/to/node",
  "SERVER_ENTRY": "/Users/you/.local/share/codex-att-mail-mcp/current/dist/index.js",
  "EMAIL_ADDRESS": "you@bellsouth.net",
  "KEYCHAIN_SERVICE": "att-mail-mcp",
  "ATTACHMENT_ROOT": "/Users/you/MailAttachments"
}
```

Then build the ZIP and install it as a custom plugin, following [cowork-plugin/README.md](cowork-plugin/README.md#install-or-update-in-desktop-cowork):

```sh
npm run plugin:package -- local/host.json artifacts/att-mail-plugin.zip
```

> [!NOTE]
> The plugin's [configuration template](cowork-plugin/.mcp.template.json) sets `MAIL_OPERATION_MODE` to `full`. Change it before packaging if you want a stricter mode.

## Configuration

These variables are specific to this edition. The full list, including size limits, is in the [server reference](server/README.md#environment-variables).

| Variable                                            | Purpose                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MAIL_OPERATION_MODE`                               | `read-only`, `draft-only` or `full`. Defaults to `full`.                                                       |
| `EMAIL_KEYCHAIN_SERVICE` / `EMAIL_KEYCHAIN_ACCOUNT` | The macOS Keychain item holding your secure mail key. When the service is unset, `EMAIL_PASS` is used instead. |
| `MAIL_ALLOWED_ROOTS`                                | Folders the server may read attachments from or save them to. File access is off when unset.                   |
| `MAIL_DRAFTS_MAILBOX` / `MAIL_TRASH_MAILBOX`        | Override automatic discovery of the Drafts and Trash folders.                                                  |
| `MAIL_MAX_DRAFT_BYTES`                              | Maximum size of a complete encoded draft. Defaults to 25,000,000 bytes.                                        |
| `MAIL_TEST_SCOPE`                                   | Strict test scope configuration. See [docs/MAIL-WORKFLOWS.md](docs/MAIL-WORKFLOWS.md#strict-test-scope).       |

## Known limitations

- **Yahoo removes reply headers from IMAP-created drafts when you edit them.** `create_reply_draft` writes correct `In-Reply-To` and `References` headers, but editing and saving that draft in Yahoo Mail strips them. For a reply you'll edit before sending, use the plugin's `/reply-draft` workflow.
- `reply_to_email` and `continue_email_thread` can't add new attachments yet.
- Updating a draft isn't a single transaction. If it's interrupted, you can end up with two drafts; the tool reports this so you can check before retrying.
- IMAP needs an implicit TLS endpoint (port 993). STARTTLS for IMAP isn't supported.

## Documentation

- [docs/MAIL-WORKFLOWS.md](docs/MAIL-WORKFLOWS.md): capability reports, conversations, draft revisions and strict test scope
- [docs/RELEASING.md](docs/RELEASING.md): preparing, activating and rolling back releases, and packaging the plugin
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): optional live testing against a real mailbox
- [server/README.md](server/README.md): server reference inherited from upstream
- [CHANGELOG.md](CHANGELOG.md)

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the pull request process. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Credits and license

Based on [yunfeizhu/mcp-mail-server](https://github.com/yunfeizhu/mcp-mail-server); see [UPSTREAM.md](UPSTREAM.md) for provenance. Released under the [MIT License](LICENSE).

This is an independent project. It isn't affiliated with or endorsed by AT&T or Yahoo.
