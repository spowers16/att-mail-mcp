import { spawnSync } from 'node:child_process';
import path from 'path';
import { parseOperationMode } from './operation-policy';
import { parseTestScope } from './mail-scope';

function getRequiredEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(
      `Missing required environment variable: ${name}. Please set this variable in your MCP server configuration.`,
    );
  }
  return value;
}

function getRequiredBooleanEnvVar(name: string): boolean {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Please set this variable to 'true' or 'false' in your MCP server configuration.`,
    );
  }
  if (value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') {
    throw new Error(
      `Invalid boolean value for environment variable ${name}: ${value}. Must be 'true' or 'false'.`,
    );
  }
  return value.toLowerCase() === 'true';
}

function getRequiredPortEnvVar(name: string): number {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Please set this variable to a valid port in your MCP server configuration.`,
    );
  }
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 1 || num > 65_535) {
    throw new Error(
      `Invalid port value for environment variable ${name}: ${value}. Must be an integer between 1 and 65535.`,
    );
  }
  return num;
}

function getOptionalBooleanEnvVar(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  if (value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') {
    throw new Error(
      `Invalid boolean value for environment variable ${name}: ${value}. Must be 'true' or 'false'.`,
    );
  }
  return value.toLowerCase() === 'true';
}

function getOptionalPositiveIntegerEnvVar(
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0 || num > maximum) {
    throw new Error(
      `Invalid number value for environment variable ${name}: ${value}. Must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return num;
}

function getAllowedRoots(): string[] {
  return (process.env.MAIL_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map(root => root.trim())
    .filter(Boolean);
}

function getOptionalEnvVar(name: string, defaultValue: string): string {
  const value = process.env[name]?.trim();
  return value || defaultValue;
}

function getMailPassword(): string {
  const keychainService = process.env.EMAIL_KEYCHAIN_SERVICE?.trim();
  if (!keychainService) return getRequiredEnvVar('EMAIL_PASS');

  if (process.platform !== 'darwin') {
    throw new Error('EMAIL_KEYCHAIN_SERVICE is supported only on macOS');
  }

  const keychainAccount = getRequiredEnvVar('EMAIL_KEYCHAIN_ACCOUNT').trim();
  const result = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-w', '-s', keychainService, '-a', keychainAccount],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4096,
    },
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to read the mail credential from macOS Keychain service ${keychainService} for account ${keychainAccount}`,
    );
  }

  const password = result.stdout.replace(/\r?\n$/, '');
  if (!password) {
    throw new Error('The macOS Keychain mail credential is empty');
  }
  return password;
}

const imapSecure = getRequiredBooleanEnvVar('IMAP_SECURE');
if (!imapSecure) {
  throw new Error(
    'IMAP_SECURE=false is not supported because the current IMAP client cannot guarantee STARTTLS before authentication. Use an implicit TLS IMAP endpoint, normally port 993.',
  );
}
const smtpSecure = getRequiredBooleanEnvVar('SMTP_SECURE');
const operationMode = parseOperationMode(process.env.MAIL_OPERATION_MODE);
const testScope = parseTestScope(
  process.env.MAIL_TEST_SCOPE,
  getOptionalEnvVar('EMAIL_ADDRESS', getRequiredEnvVar('EMAIL_USER')),
);
const mailPassword = getMailPassword();

export const EMAIL_CONFIG = {
  operationMode,
  testScope,
  // IMAP配置（接收邮件）
  IMAP: {
    host: getRequiredEnvVar('IMAP_HOST'),
    port: getRequiredPortEnvVar('IMAP_PORT'),
    username: getRequiredEnvVar('EMAIL_USER'),
    password: mailPassword,
    tls: imapSecure,
    tlsRejectUnauthorized: getOptionalBooleanEnvVar('IMAP_TLS_REJECT_UNAUTHORIZED', true),
    maxMessageBytes: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_MESSAGE_BYTES',
      25 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
  },

  // SMTP配置（发送邮件）
  SMTP: {
    host: getRequiredEnvVar('SMTP_HOST'),
    port: getRequiredPortEnvVar('SMTP_PORT'),
    username: getRequiredEnvVar('EMAIL_USER'),
    password: mailPassword,
    secure: smtpSecure,
    requireTLS: !smtpSecure,
    tlsRejectUnauthorized: getOptionalBooleanEnvVar('SMTP_TLS_REJECT_UNAUTHORIZED', true),
    fromAddress: getOptionalEnvVar('EMAIL_ADDRESS', getRequiredEnvVar('EMAIL_USER')),
  },

  ACCOUNT: {
    emailAddress: getOptionalEnvVar('EMAIL_ADDRESS', getRequiredEnvVar('EMAIL_USER')),
  },

  SENT: {
    appendCopy: getOptionalBooleanEnvVar('MAIL_APPEND_SENT_COPY', true),
  },

  DRAFTS: {
    mailbox: process.env.MAIL_DRAFTS_MAILBOX?.trim() || undefined,
    trashMailbox: process.env.MAIL_TRASH_MAILBOX?.trim() || undefined,
    maxMessageBytes: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_DRAFT_BYTES',
      25_000_000,
      1024 * 1024 * 1024,
    ),
  },

  FILES: {
    allowedRoots: getAllowedRoots(),
    maxAttachmentBytes: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_ATTACHMENT_BYTES',
      25 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxBase64Bytes: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_BASE64_BYTES',
      1024 * 1024,
      100 * 1024 * 1024,
    ),
    maxBodyCharacters: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_BODY_CHARACTERS',
      200_000,
      10_000_000,
    ),
    maxResponseCharacters: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_RESPONSE_CHARACTERS',
      2_000_000,
      100_000_000,
    ),
    maxSearchCandidates: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_SEARCH_CANDIDATES',
      5_000,
      100_000,
    ),
    maxSearchHeaderBytes: getOptionalPositiveIntegerEnvVar(
      'MAIL_MAX_SEARCH_HEADER_BYTES',
      16 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
  },
};
