import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { simpleParser } from 'mailparser';

import { DraftAppendError, IMAPClient } from '../src/imap-client';
import { MAIL_TOOLS } from '../src/tool-definitions';

// Entire suite uses fake credentials, local files, and protocol doubles.
const root = await mkdtemp(path.join(tmpdir(), 'mail-drafts-test-'));
const outside = await mkdtemp(path.join(tmpdir(), 'mail-drafts-outside-'));
Object.assign(process.env, {
  MAIL_OPERATION_MODE: 'full',
  EMAIL_KEYCHAIN_SERVICE: '',
  IMAP_HOST: 'localhost',
  IMAP_PORT: '993',
  IMAP_SECURE: 'true',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  EMAIL_USER: 'author@example.com',
  EMAIL_ADDRESS: 'author@example.com',
  EMAIL_PASS: 'fake-test-password',
  MAIL_ALLOWED_ROOTS: root,
  MAIL_MAX_ATTACHMENT_BYTES: '64',
  MAIL_MAX_DRAFT_BYTES: '100000',
  MAIL_DRAFTS_MAILBOX: '',
});
const { EMAIL_CONFIG } = await import('../src/config');
const { MailMCPServer } = await import('../src/mail-mcp-server');
const { MailConnectionManager } = await import('../src/mail-connection-manager');
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function makeServer(t: TestContext) {
  const server = new MailMCPServer({ registerProcessHandlers: false }) as any;
  const state = { ensures: 0, saves: [] as Array<{ raw: Buffer; mailbox: string }> };
  server.connections = {
    async ensure(imap, smtp) {
      assert.equal(imap, true);
      assert.equal(smtp, false, 'Drafts must never request SMTP');
      state.ensures += 1;
    },
    get smtp() {
      throw new Error('Drafts must never access SMTP');
    },
    async getDraftMailboxCandidates() {
      return ['Drafts'];
    },
    imap: {
      async saveDraftToFolder(raw, mailbox) {
        state.saves.push({ raw, mailbox });
        return { uid: 42, uidValidity: 7 };
      },
    },
  };
  t.after(() => server.server.close());
  return { server, state };
}

function decode(result: any): any {
  return JSON.parse(result.content[0].text);
}

test('create_draft validates drafts with no recipients and rejects send controls', () => {
  const tool = MAIL_TOOLS.find(item => item.name === 'create_draft')!;
  assert.deepEqual(tool.inputSchema.parse({ text: 'Review me' }), { text: 'Review me' });
  assert.equal(tool.inputSchema.safeParse({ subject: 'No body' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ text: 'Body', send: true }).success, false);
  assert.equal(tool.inputSchema.safeParse({ text: 'Body', mailbox: 'Sent' }).success, false);
  assert.equal(
    tool.inputSchema.safeParse({
      text: 'Body',
      attachments: Array.from({ length: 21 }, () => '/tmp/file'),
    }).success,
    false,
  );
});

test('create_draft saves MIME with binary attachments, Unicode names, Bcc, and signature without SMTP', async t => {
  const { server, state } = makeServer(t);
  const file = path.join(root, 'résumé.pdf');
  const content = Buffer.from([0, 1, 2, 255, 128, 13, 10]);
  await writeFile(file, content);
  const result = decode(
    await server.executeTool('create_draft', {
      to: 'reviewer@example.com',
      cc: 'copy@example.com',
      bcc: 'private@example.com',
      subject: 'Review draft',
      text: 'Hello',
      signature: { text: 'Regards, Author' },
      attachments: [file],
    }),
  );
  assert.equal(result.draftSaved, true);
  assert.equal(result.sent, false);
  assert.equal(result.uid, 42);
  assert.equal(result.uidValidity, 7);
  assert.equal(state.ensures, 1);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].mailbox, 'Drafts');
  const parsed = await simpleParser(state.saves[0].raw);
  assert.equal(parsed.from?.value[0].address, 'author@example.com');
  assert.equal((parsed.to as any).value[0].address, 'reviewer@example.com');
  assert.equal((parsed.cc as any).value[0].address, 'copy@example.com');
  assert.equal((parsed.bcc as any).value[0].address, 'private@example.com');
  assert.match(parsed.text!, /Hello[\s\S]*Regards, Author/);
  assert.match(String(parsed.html), /Hello/);
  assert.equal(parsed.attachments[0].filename, 'résumé.pdf');
  assert.deepEqual(parsed.attachments[0].content, content);
  assert.equal(parsed.messageId, result.messageId);
  assert.equal(result.messageBytes, state.saves[0].raw.length);
});

test('create_draft supports recipient-free drafts and servers without APPENDUID', async t => {
  const { server, state } = makeServer(t);
  server.connections.imap.saveDraftToFolder = async (raw, mailbox) => {
    state.saves.push({ raw, mailbox });
    return { uidValidity: 9 };
  };
  const result = decode(await server.handleCreateDraft({ text: 'Fill recipients in Yahoo Mail.' }));
  assert.equal(result.draftSaved, true);
  assert.equal(result.sent, false);
  assert.equal(result.uid, undefined);
  const parsed = await simpleParser(state.saves[0].raw);
  assert.equal(parsed.to, undefined);
  assert.equal(parsed.subject, undefined);
});

test('create_draft rejects outside-root, relative, and escaping symlink attachments before connecting', async t => {
  const { server, state } = makeServer(t);
  const outsideFile = path.join(outside, 'private.txt');
  const link = path.join(root, 'escape.txt');
  await writeFile(outsideFile, 'private');
  await symlink(outsideFile, link);
  for (const file of [outsideFile, link, 'relative.txt']) {
    await assert.rejects(
      () =>
        server.handleCreateDraft({
          text: 'Body',
          attachments: [file],
        }),
      /outside MAIL_ALLOWED_ROOTS|must be absolute/,
    );
  }
  assert.equal(state.ensures, 0);
  assert.equal(state.saves.length, 0);
});

test('create_draft enforces per-file and aggregate attachment limits before connecting', async t => {
  const { server, state } = makeServer(t);
  const files = ['large.bin', 'first.bin', 'second.bin'].map(name => path.join(root, name));
  await writeFile(files[0], Buffer.alloc(65));
  await writeFile(files[1], Buffer.alloc(40));
  await writeFile(files[2], Buffer.alloc(40));
  await assert.rejects(
    () =>
      server.handleCreateDraft({
        text: 'Body',
        attachments: [files[0]],
      }),
    /configured limit/,
  );
  await assert.rejects(
    () =>
      server.handleCreateDraft({
        text: 'Body',
        attachments: files.slice(1),
      }),
    /Total attachment size/,
  );
  assert.equal(state.ensures, 0);
  assert.equal(state.saves.length, 0);
});

test('create_draft enforces the complete encoded MIME size before connecting', async t => {
  const { server, state } = makeServer(t);
  await assert.rejects(
    () =>
      server.handleCreateDraft({
        text: 'x'.repeat(80000),
      }),
    /Encoded draft size .* exceeds MAIL_MAX_DRAFT_BYTES/,
  );
  assert.equal(state.ensures, 0);
});

test('create_draft tries another mailbox only after a definite failure', async t => {
  const { server, state } = makeServer(t);
  server.connections.getDraftMailboxCandidates = async () => ['Missing', 'Drafts'];
  server.connections.imap.saveDraftToFolder = async (raw, mailbox) => {
    state.saves.push({ raw, mailbox });
    if (mailbox === 'Missing') throw new DraftAppendError('No mailbox', 'select', 'not-appended');
    return { uid: 10, uidValidity: 2 };
  };
  const result = decode(await server.handleCreateDraft({ text: 'Body' }));
  assert.equal(result.draftSaved, true);
  assert.deepEqual(
    state.saves.map(save => save.mailbox),
    ['Missing', 'Drafts'],
  );
  assert.deepEqual(state.saves[0].raw, state.saves[1].raw);
});

test('create_draft stops on an ambiguous APPEND and redacts diagnostics', async t => {
  const { server, state } = makeServer(t);
  server.connections.getDraftMailboxCandidates = async () => ['Draft', 'Drafts'];
  server.connections.imap.saveDraftToFolder = async (raw, mailbox) => {
    state.saves.push({ raw, mailbox });
    throw new DraftAppendError('lost fake-test-password', 'append', 'unknown');
  };
  const response = await server.handleCreateDraft({ text: 'Body' });
  const result = decode(response);
  assert.equal(response.isError, true);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.sent, false);
  assert.equal(state.saves.length, 1);
  assert.match(result.note, /Inspect Drafts before retrying/);
  assert.doesNotMatch(response.content[0].text, /fake-test-password/);
});

test('create_draft reports definite failure when no candidate can be selected', async t => {
  const { server } = makeServer(t);
  server.connections.imap.saveDraftToFolder = async () => {
    throw new DraftAppendError('Missing', 'select', 'not-appended');
  };
  const response = await server.handleCreateDraft({ text: 'Body' });
  assert.equal(response.isError, true);
  assert.equal(decode(response).outcome, 'not-appended');
  assert.equal(decode(response).sent, false);
});

test('draft mailbox detection prefers special-use folders and supports nested delimiters', async () => {
  const manager = new MailConnectionManager() as any;
  manager.imapClient = {
    async getBoxes() {
      return {
        Unselectable: { attribs: ['\\Drafts', '\\Noselect'] },
        Account: {
          attribs: ['\\Noselect'],
          delimiter: '/',
          children: { Unsent: { attribs: ['\\Drafts'], delimiter: '/' } },
        },
      };
    },
  };
  const candidates = await manager.getDraftMailboxCandidates();
  assert.equal(candidates[0], 'Account/Unsent');
  assert.equal(candidates.includes('Unselectable'), false);
  assert.ok(candidates.includes('Draft'));
});

test('draft mailbox override is used without guessing other folders', async t => {
  const previous = EMAIL_CONFIG.DRAFTS.mailbox;
  EMAIL_CONFIG.DRAFTS.mailbox = 'Custom/Drafts';
  t.after(() => {
    EMAIL_CONFIG.DRAFTS.mailbox = previous;
  });
  const manager = new MailConnectionManager();
  assert.deepEqual(await manager.getDraftMailboxCandidates(), ['Custom/Drafts']);
});

function makeIMAP() {
  const client = new IMAPClient({
    host: 'localhost',
    port: 993,
    username: 'test@example.com',
    password: 'not-used',
  }) as any;
  client.connected = true;
  client.openBox = async (mailbox, readOnly) => {
    assert.equal(mailbox, 'Drafts');
    assert.equal(readOnly, false);
    return { uidvalidity: 7 };
  };
  return client;
}

test('IMAP draft APPEND uses Draft and Seen flags and returns the server UID', async () => {
  const client = makeIMAP();
  client.imap = {
    append(raw, options, callback) {
      assert.equal(raw.toString(), 'raw MIME');
      assert.deepEqual(options, { mailbox: 'Drafts', flags: ['\\Draft', '\\Seen'] });
      callback(null, 42);
    },
  };
  assert.deepEqual(await client.saveDraftToFolder(Buffer.from('raw MIME'), 'Drafts'), {
    uid: 42,
    uidValidity: 7,
  });
});

test('IMAP draft APPEND reports a server rejection as a definite non-save', async () => {
  const client = makeIMAP();
  client.imap = {
    append(_raw, _options, callback) {
      callback(Object.assign(new Error('quota exceeded'), { type: 'no' }));
    },
  };
  await assert.rejects(
    () => client.saveDraftToFolder(Buffer.from('raw'), 'Drafts'),
    error => {
      assert.ok(error instanceof DraftAppendError);
      assert.equal(error.outcome, 'not-appended');
      return true;
    },
  );
});

test('IMAP draft APPEND reports connection loss as unknown without retrying', async () => {
  const client = makeIMAP();
  const imap = new EventEmitter() as any;
  imap.append = () => {
    queueMicrotask(() => imap.emit('end'));
  };
  client.imap = imap;
  await assert.rejects(
    () => client.saveDraftToFolder(Buffer.from('raw'), 'Drafts'),
    error => {
      assert.ok(error instanceof DraftAppendError);
      assert.equal(error.outcome, 'unknown');
      return true;
    },
  );
});

function makeReplyServer(t: TestContext, overrides: Record<string, unknown> = {}) {
  const fixture = makeServer(t);
  const parent = {
    uid: 41,
    uidValidity: 7,
    sourceMailbox: 'INBOX',
    from: 'Sender <sender@example.com>',
    replyTo: 'reply-here@example.com',
    to: 'author@example.com, peer@example.com',
    cc: 'colleague@example.com, REPLY-HERE@example.com',
    subject: 'Re: Project review',
    text: 'Original body',
    html: '<p>Original body</p>',
    date: '2026-11-01T12:00:00Z',
    messageId: '<parent@example.com>',
    references: ['<root@example.com>'],
    ...overrides,
  };
  const opened: Array<{ mailbox: string; readOnly: boolean }> = [];
  const fetched: number[] = [];
  fixture.server.connections.imap.openBox = async (mailbox, readOnly) => {
    opened.push({ mailbox, readOnly });
    return { uidvalidity: 7 };
  };
  fixture.server.connections.imap.getMessage = async uid => {
    fetched.push(uid);
    assert.equal(uid, 41);
    return parent;
  };
  return { ...fixture, parent, opened, fetched };
}

const replyDraftArgs = {
  mailbox: 'INBOX',
  originalUid: 41,
  uidValidity: 7,
  expectedMessageId: '<parent@example.com>',
  text: 'New reply',
};

test('create_reply_draft requires an exact mailbox reference and rejects send or recipient overrides', () => {
  const tool = MAIL_TOOLS.find(item => item.name === 'create_reply_draft')!;
  const parsed = tool.inputSchema.parse(replyDraftArgs) as any;
  assert.equal(parsed.replyToAll, false);
  assert.equal(parsed.includeOriginal, true);
  assert.equal(
    tool.inputSchema.safeParse({ ...replyDraftArgs, uidValidity: undefined }).success,
    false,
  );
  assert.equal(tool.inputSchema.safeParse({ ...replyDraftArgs, text: undefined }).success, false);
  assert.equal(tool.inputSchema.safeParse({ ...replyDraftArgs, send: true }).success, false);
  assert.equal(
    tool.inputSchema.safeParse({ ...replyDraftArgs, to: 'other@example.com' }).success,
    false,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      ...replyDraftArgs,
      attachments: Array.from({ length: 21 }, () => '/tmp/file'),
    }).success,
    false,
  );
});

test('create_reply_draft preserves parent threading, quoted body, signature, and attachment bytes without SMTP', async t => {
  const { server, state, opened, fetched } = makeReplyServer(t);
  const attachment = path.join(root, 'reply.pdf');
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  await writeFile(attachment, bytes);
  const result = decode(
    await server.executeTool('create_reply_draft', {
      ...replyDraftArgs,
      signature: { text: 'Regards, Author' },
      attachments: [attachment],
    }),
  );
  assert.equal(result.draftSaved, true);
  assert.equal(result.sent, false);
  assert.equal(state.saves.length, 1);
  assert.deepEqual(opened, [{ mailbox: 'INBOX', readOnly: true }]);
  assert.deepEqual(fetched, [41]);
  assert.equal(result.inReplyTo, '<parent@example.com>');
  assert.deepEqual(result.references, ['<root@example.com>', '<parent@example.com>']);
  assert.equal(result.replyInfo.originalUid, 41);
  assert.equal(result.replyInfo.sourceMailbox, 'INBOX');
  assert.equal(result.requiresRecipientReview, false);
  assert.equal(result.yahooEditThreadingSupported, false);
  assert.match(result.webmailThreadingWarning, /Yahoo Mail removes imported reply headers/);
  const parsed = await simpleParser(state.saves[0].raw);
  assert.equal(parsed.subject, 'Re: Project review');
  assert.equal(parsed.inReplyTo, '<parent@example.com>');
  assert.deepEqual(parsed.references, ['<root@example.com>', '<parent@example.com>']);
  assert.equal((parsed.to as any).value[0].address, 'reply-here@example.com');
  assert.equal(parsed.cc, undefined);
  assert.equal(parsed.bcc, undefined);
  assert.match(parsed.text!, /New reply[\s\S]*Regards, Author[\s\S]*Original body/);
  assert.equal(parsed.attachments[0].filename, 'reply.pdf');
  assert.deepEqual(parsed.attachments[0].content, bytes);
  assert.notEqual(parsed.messageId, '<parent@example.com>');
});

test('create_reply_draft supports reply-all while excluding this account and duplicate recipients', async t => {
  const { server, state } = makeReplyServer(t);
  await server.handleCreateReplyDraft({
    ...replyDraftArgs,
    replyToAll: true,
    includeOriginal: false,
  });
  const parsed = await simpleParser(state.saves[0].raw);
  assert.deepEqual(
    (parsed.cc as any).value.map(item => item.address),
    ['peer@example.com', 'colleague@example.com'],
  );
  assert.doesNotMatch(parsed.text!, /Original body/);
});

test('create_reply_draft refuses stale UIDVALIDITY before fetching a message', async t => {
  const { server, state, fetched } = makeReplyServer(t);
  await assert.rejects(
    () =>
      server.handleCreateReplyDraft({
        ...replyDraftArgs,
        uidValidity: 8,
      }),
    /UIDVALIDITY changed/,
  );
  assert.equal(fetched.length, 0);
  assert.equal(state.saves.length, 0);
});

test('create_reply_draft refuses a mismatched expected Message-ID without saving', async t => {
  const { server, state } = makeReplyServer(t);
  await assert.rejects(
    () =>
      server.handleCreateReplyDraft({
        ...replyDraftArgs,
        expectedMessageId: '<different@example.com>',
      }),
    /does not match expectedMessageId/,
  );
  assert.equal(state.saves.length, 0);
});

test('create_reply_draft refuses parents without Message-ID instead of making a subject-only draft', async t => {
  const { server, state } = makeReplyServer(t, { messageId: undefined });
  await assert.rejects(
    () =>
      server.handleCreateReplyDraft({
        ...replyDraftArgs,
        expectedMessageId: undefined,
      }),
    /no Message-ID/,
  );
  assert.equal(state.saves.length, 0);
});

test('create_reply_draft follows a single parent In-Reply-To when References is absent', async t => {
  const { server, state } = makeReplyServer(t, {
    references: undefined,
    inReplyTo: '<ancestor@example.com>',
  });
  await server.handleCreateReplyDraft(replyDraftArgs);
  const parsed = await simpleParser(state.saves[0].raw);
  assert.deepEqual(parsed.references, ['<ancestor@example.com>', '<parent@example.com>']);
});

test('create_reply_draft preserves the explicit sender for self-only replies', async t => {
  const { server, state } = makeReplyServer(t, {
    from: 'author@example.com',
    replyTo: undefined,
    to: 'author@example.com',
    cc: undefined,
  });
  const result = decode(await server.handleCreateReplyDraft(replyDraftArgs));
  assert.equal(result.draftSaved, true);
  assert.equal(result.requiresRecipientReview, false);
  assert.deepEqual(result.replyInfo.recipients.to, ['author@example.com']);
  const parsed = await simpleParser(state.saves[0].raw);
  assert.equal((parsed.to as any).value[0].address, 'author@example.com');
  assert.equal(parsed.inReplyTo, '<parent@example.com>');
});

test('create_reply_draft rejects outside-root attachments before reading any mailbox', async t => {
  const { server, state, fetched } = makeReplyServer(t);
  const file = path.join(outside, 'unrelated.txt');
  await writeFile(file, 'Do not attach');
  await assert.rejects(
    () =>
      server.handleCreateReplyDraft({
        ...replyDraftArgs,
        attachments: [file],
      }),
    /outside MAIL_ALLOWED_ROOTS/,
  );
  assert.equal(state.ensures, 0);
  assert.equal(fetched.length, 0);
  assert.equal(state.saves.length, 0);
});

test('create_reply_draft enforces full MIME size before APPEND', async t => {
  const { server, state } = makeReplyServer(t);
  await assert.rejects(
    () =>
      server.handleCreateReplyDraft({
        ...replyDraftArgs,
        text: 'x'.repeat(80000),
        includeOriginal: false,
      }),
    /Encoded draft size .* exceeds MAIL_MAX_DRAFT_BYTES/,
  );
  assert.equal(state.saves.length, 0);
});

test('create_reply_draft retains its parent reference and stops after an ambiguous save', async t => {
  const { server, state } = makeReplyServer(t);
  server.connections.getDraftMailboxCandidates = async () => ['Draft', 'Drafts'];
  server.connections.imap.saveDraftToFolder = async (raw, mailbox) => {
    state.saves.push({ raw, mailbox });
    throw new DraftAppendError('connection lost', 'append', 'unknown');
  };
  const response = await server.handleCreateReplyDraft(replyDraftArgs);
  const result = decode(response);
  assert.equal(response.isError, true);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.sent, false);
  assert.equal(result.replyInfo.originalUid, 41);
  assert.equal(state.saves.length, 1);
});

test('ordinary reply_to_email still sends with the same parent headers after shared composition', async t => {
  const { server } = makeReplyServer(t);
  const sent: any[] = [];
  server.connections.ensure = async (imap, smtp) => {
    assert.equal(imap, true);
    assert.equal(smtp, true);
  };
  Object.defineProperty(server.connections, 'smtp', {
    configurable: true,
    value: {
      async sendMail(options) {
        sent.push(options);
        return { messageId: '<sent@example.com>', accepted: ['reply-here@example.com'] };
      },
    },
  });
  server.saveSentMessage = async () => ({ saved: true, mailbox: 'Sent' });
  await server.handleReplyToEmail(replyDraftArgs);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].inReplyTo, '<parent@example.com>');
  assert.deepEqual(sent[0].references, ['<root@example.com>', '<parent@example.com>']);
  assert.deepEqual(sent[0].to, ['reply-here@example.com']);
  assert.equal(sent[0].attachments, undefined);
});
