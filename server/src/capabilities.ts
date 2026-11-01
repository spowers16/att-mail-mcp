import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMAIL_CONFIG } from './config';
import { SERVER_VERSION } from './version';
import { MAIL_TOOLS } from './tool-definitions';
import { isToolAllowed, type OperationMode } from './operation-policy';

export function capabilityReport(
  mode: OperationMode,
  toolAllowed: (name: (typeof MAIL_TOOLS)[number]['name']) => boolean,
  protocols: Record<string, unknown>,
): Record<string, unknown> {
  let release: Record<string, unknown> | null = null;
  try {
    const file = new URL('../release.json', import.meta.url);
    if (statSync(file).size > 8 * 1024 * 1024) throw new Error();
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (/^[a-f0-9]{40}$/.test(value.commit) && typeof value.version === 'string')
      release = {
        commit: value.commit,
        version: value.version,
        createdAt: value.createdAt,
        builtWithNode: value.node,
      };
  } catch {
    /* Development builds have no installed release manifest. */
  }
  return {
    serverVersion: SERVER_VERSION,
    runtimeEntry: fileURLToPath(import.meta.url),
    configurationIssues: EMAIL_CONFIG.FILES.allowedRoots.length
      ? []
      : ['Local attachment access is disabled because MAIL_ALLOWED_ROOTS is empty.'],
    nodeVersion: process.versions.node,
    release,
    configuredOperationMode: EMAIL_CONFIG.operationMode,
    effectiveOperationMode: mode,
    availableTools: MAIL_TOOLS.filter(tool => toolAllowed(tool.name)).map(tool => tool.name),
    disabledTools: MAIL_TOOLS.filter(tool => !toolAllowed(tool.name)).map(tool => ({
      name: tool.name,
      reason: !isToolAllowed(tool.name, mode) ? 'operation mode' : 'strict test scope',
    })),
    testScope: EMAIL_CONFIG.testScope
      ? {
          enabled: true,
          account: EMAIL_CONFIG.testScope.account,
          seed: EMAIL_CONFIG.testScope.seed,
          mailboxes: EMAIL_CONFIG.testScope.mailboxes,
          smtpAllowed: false,
          unthreadedDraftsAllowed: false,
        }
      : { enabled: false },
    attachments: {
      allowedRoots: EMAIL_CONFIG.FILES.allowedRoots,
      maxFiles: 20,
      maxTotalRawBytes: EMAIL_CONFIG.FILES.maxAttachmentBytes,
      savingAllowed: toolAllowed('save_attachment'),
    },
    drafts: {
      configuredMailbox: EMAIL_CONFIG.DRAFTS.mailbox || null,
      configuredTrashMailbox: EMAIL_CONFIG.DRAFTS.trashMailbox || null,
      maxEncodedBytes: EMAIL_CONFIG.DRAFTS.maxMessageBytes,
      updatesRequireRevision: true,
      discardUsesTrash: true,
      sendsExistingDrafts: false,
    },
    limits: {
      maxBodyCharacters: EMAIL_CONFIG.FILES.maxBodyCharacters,
      maxResponseCharacters: EMAIL_CONFIG.FILES.maxResponseCharacters,
      maxSearchCandidates: EMAIL_CONFIG.FILES.maxSearchCandidates,
      maxSearchHeaderBytes: EMAIL_CONFIG.FILES.maxSearchHeaderBytes,
      maxConversationMailboxes: 20,
      maxConversationMessages: 200,
      maxConversationQueries: 200,
    },
    tls: {
      imapVerification: EMAIL_CONFIG.IMAP.tlsRejectUnauthorized,
      smtpVerification: EMAIL_CONFIG.SMTP.tlsRejectUnauthorized,
    },
    protocols,
    limitations: [
      'Strict test scope protects only this MCP process. Browser automation and other connectors are outside its enforcement boundary.',
      'Yahoo editing can remove reply headers from IMAP-imported drafts; use native Yahoo Reply for editable threaded replies.',
      'Draft replacement uses append then a verified move to Trash; an interrupted operation can leave both drafts and must not be retried blindly.',
      'Conversation reconstruction cannot recover deleted messages or missing reply headers and reports incomplete results.',
    ],
    note: 'This report does not connect to IMAP or SMTP, retrieve a credential, or expose Keychain identifiers. The server loaded its authentication configuration at startup.',
  };
}
