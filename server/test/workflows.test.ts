import assert from 'node:assert/strict';
import test from 'node:test';
import { simpleParser } from 'mailparser';
import { buildRawMessage } from '../src/message-builder';
import { DraftAppendError, type EmailMessage } from '../src/imap-client';
import { DraftService } from '../src/draft-service';
import { ConversationService } from '../src/conversation-service';
import { MailTestScope, parseTestScope } from '../src/mail-scope';
import { MAIL_TOOLS } from '../src/tool-definitions';
import { isSafeMailboxName } from '../src/message-ref';

const account = 'author@example.com';
const scopeConfig = {
  account,
  seed: { mailbox: 'INBOX', uid: 41, uidValidity: 7, messageId: '<seed@example.com>' },
  mailboxes: ['INBOX', 'Sent', 'Draft', 'Trash'],
};
const ref = { mailbox: 'Draft', uid: 42, uidValidity: 7 };

test('strict test scope validates its own account, mailbox set, seed identity and unknown fields', () => {
  assert.equal(parseTestScope(undefined, account), null);
  assert.deepEqual(parseTestScope(JSON.stringify(scopeConfig), account), scopeConfig);
  for (const value of [
    '',
    '{}',
    JSON.stringify({ ...scopeConfig, account: 'other@example.com' }),
    JSON.stringify({ ...scopeConfig, mailboxes: ['Draft'] }),
    JSON.stringify({ ...scopeConfig, allowSend: true }),
    JSON.stringify({ ...scopeConfig, mailboxes: ['INBOX', 'inbox'] }),
  ])
    assert.throws(() => parseTestScope(value, account), /MAIL_TEST_SCOPE/);
});

test('strict test scope rejects external Bcc, unthreaded drafts, and unrelated references', () => {
  const scope = new MailTestScope(scopeConfig);
  assert.doesNotThrow(() =>
    scope.assertOutgoing({ to: account, inReplyTo: scopeConfig.seed.messageId }),
  );
  assert.throws(() => scope.assertOutgoing({ to: account }));
  assert.throws(() =>
    scope.assertOutgoing({
      to: account,
      bcc: 'outsider@example.com',
      inReplyTo: scopeConfig.seed.messageId,
    }),
  );
  assert.throws(() => scope.assertMailbox('Other'));
});

test('mailbox control characters cannot enter scope configuration or read tool commands', () => {
  for (const mailbox of ['INBOX\r\nNOOP', 'Draft\u0000', 'Sent\u007f']) {
    assert.equal(isSafeMailboxName(mailbox), false);
    assert.throws(() =>
      parseTestScope(
        JSON.stringify({
          ...scopeConfig,
          seed: { ...scopeConfig.seed, mailbox },
          mailboxes: [mailbox],
        }),
        account,
      ),
    );
    const tool = MAIL_TOOLS.find(item => item.name === 'get_conversation')!;
    assert.equal(tool.inputSchema.safeParse({ mailbox, uid: 1, uidValidity: 7 }).success, false);
  }
});

async function draftFixture(options: { scope?: boolean; trash?: boolean; maximum?: number } = {}) {
  const raw = await buildRawMessage({
    from: account,
    replyTo: account,
    to: options.scope ? account : 'recipient@example.com',
    bcc: options.scope ? undefined : 'blind@example.com',
    subject: 'Original',
    text: 'Original body',
    html: '<p>Original body<img src="cid:icon@fixture"></p>',
    messageId: '<draft@example.com>',
    inReplyTo: '<seed@example.com>',
    references: ['<seed@example.com>'],
    attachments: [
      {
        filename: 'résumé.bin',
        content: Buffer.from([0, 255, 1, 2]),
        contentType: 'application/octet-stream',
      },
      {
        filename: 'icon.png',
        content: Buffer.from([3, 4, 5]),
        contentType: 'image/png',
        cid: 'icon@fixture',
        contentDisposition: 'inline',
      },
    ],
  });
  const store = new Map<number, Buffer>([[42, raw]]);
  const state = {
    appendCalls: 0,
    moves: [] as number[],
    next: 43,
    modifySaved: false,
    unknownAppend: false,
    failMove: false,
    changeOriginalAfterSave: false,
    omitAppendUid: false,
  };
  const imap: any = {
    async openBox(mailbox, _readOnly) {
      if (
        !['Draft', 'Trash', 'INBOX'].includes(mailbox) ||
        (mailbox === 'Trash' && options.trash === false)
      )
        throw new Error('Folder unavailable');
      return { uidvalidity: 7 };
    },
    async fetchRawMessage(uid) {
      if (!store.has(uid)) throw new Error('Draft disappeared');
      if (uid > 42 && state.changeOriginalAfterSave)
        store.set(42, Buffer.from(raw.toString().replace('Original body', 'Edited in Yahoo')));
      return store.get(uid);
    },
    async fetchMessages(uids) {
      return uids.map(uid => ({
        uid,
        uidValidity: 7,
        from: account,
        to: account,
        sourceMailbox: uid === 41 ? 'INBOX' : 'Draft',
        messageId: uid === 41 ? '<seed@example.com>' : '<draft@example.com>',
        inReplyTo: uid === 41 ? undefined : '<seed@example.com>',
      }));
    },
    async saveDraftToFolder(value) {
      state.appendCalls++;
      const uid = state.next++;
      store.set(
        uid,
        state.modifySaved
          ? Buffer.from(value.toString().replace('Subject: Changed', 'Subject: Tampered'))
          : value,
      );
      if (state.unknownAppend)
        throw new DraftAppendError('Append response lost', 'append', 'unknown');
      return { uid: state.omitAppendUid ? undefined : uid, uidValidity: 7 };
    },
    async search() {
      return [state.next - 1];
    },
    async moveMessage(uid, target, uidValidity) {
      assert.equal(target, 'Trash');
      assert.equal(uidValidity, 7);
      if (state.failMove) throw new Error('Move response lost');
      state.moves.push(uid);
      store.delete(uid);
      return { destinationUid: 100 + uid };
    },
    async deleteMessage() {
      throw new Error('Permanent delete must never be called');
    },
  };
  const service = new DraftService({
    imap,
    scope: options.scope ? new MailTestScope(scopeConfig) : undefined,
    draftMailboxes: async () => ['Draft'],
    trashMailboxes: async () => ['Trash'],
    account,
    maxMessageBytes: options.maximum ?? 100000,
    maxAttachmentBytes: 100000,
    maxBodyCharacters: 100000,
    readAttachments: async () => [],
    formatMessage: message => message,
  });
  const current = await service.get(ref);
  const mutation = {
    ...ref,
    revision: current.revision as string,
    expectedMessageId: '<draft@example.com>',
  };
  return { service, imap, store, raw, state, mutation };
}

test('draft revision is bound to UID and rejects changes made since review', async () => {
  const { service, store, raw, state, mutation } = await draftFixture();
  store.set(43, raw);
  assert.notEqual((await service.get({ ...ref, uid: 43 })).revision, mutation.revision);
  store.set(42, Buffer.from(raw.toString().replace('Original body', 'Yahoo edit')));
  await assert.rejects(service.update({ ...mutation, text: 'New' }), /changed since review/);
  await assert.rejects(service.discard(mutation), /changed since review/);
  assert.equal(state.appendCalls, 0);
  assert.deepEqual(state.moves, []);
});

test('draft replacement preserves Bcc, Reply-To, inline CID, binary attachments and reply headers', async () => {
  const { service, store, raw, state, mutation } = await draftFixture();
  const result: any = await service.update({ ...mutation, subject: 'Changed' });
  assert.equal(result.updated, true);
  assert.equal(result.sent, false);
  assert.equal(result.replacement.uid, 43);
  assert.deepEqual(state.moves, [42]);
  assert.ok(!store.has(42));
  const original = await simpleParser(raw);
  const updated = await simpleParser(store.get(43)!);
  assert.equal(updated.subject, 'Changed');
  assert.equal(updated.inReplyTo, '<seed@example.com>');
  assert.deepEqual(Array.isArray(updated.references) ? updated.references : [updated.references], [
    '<seed@example.com>',
  ]);
  assert.equal((updated.bcc as any).value[0].address, 'blind@example.com');
  assert.equal(updated.replyTo?.value[0].address, account);
  assert.equal(updated.attachments.length, 2);
  for (let index = 0; index < 2; index++)
    assert.deepEqual(updated.attachments[index].content, original.attachments[index].content);
  assert.equal(updated.attachments.find(file => file.filename === 'icon.png')?.cid, 'icon@fixture');
  assert.match(
    String((await simpleParser(store.get(43)!, { skipImageLinks: true })).html),
    /cid:icon@fixture/,
  );
  assert.equal(result.yahooEditThreadingSupported, false);
  assert.equal((await service.get({ ...ref, uid: 43 })).revision, result.replacement.revision);
});

test('explicit attachment replacement can remove all attachments while changing body', async () => {
  const { service, store, mutation } = await draftFixture();
  const result: any = await service.update({ ...mutation, text: 'Revised body', attachments: [] });
  assert.equal(result.updated, true);
  const parsed = await simpleParser(store.get(43)!);
  assert.equal(parsed.attachments.length, 0);
  assert.match(parsed.text!, /Revised body/);
  assert.doesNotMatch(String(parsed.html), /Original body/);
});

for (const failure of [
  'modifySaved',
  'unknownAppend',
  'failMove',
  'changeOriginalAfterSave',
] as const) {
  test(`draft update ${failure} reports partial/unknown and does not blindly delete or retry`, async () => {
    const { service, state, store, mutation } = await draftFixture();
    state[failure] = true;
    const result: any = await service.update({ ...mutation, subject: 'Changed' });
    assert.equal(result.updated, false);
    assert.equal(result.sent, false);
    assert.equal(state.appendCalls, 1);
    assert.deepEqual(state.moves, []);
    assert.ok(store.has(42));
  });
}

test('missing Trash or an oversized replacement stops before APPEND', async () => {
  for (const options of [{ trash: false }, { maximum: 50 }]) {
    const { service, mutation, state } = await draftFixture(options);
    await assert.rejects(service.update({ ...mutation, text: 'New' }));
    assert.equal(state.appendCalls, 0);
    assert.deepEqual(state.moves, []);
  }
});

test('a missing APPENDUID is recovered only through a unique exact Message-ID readback', async () => {
  const { service, state, mutation } = await draftFixture();
  state.omitAppendUid = true;
  const result: any = await service.update({ ...mutation, subject: 'Changed' });
  assert.equal(result.updated, true);
  assert.equal(result.replacement.uid, 43);
});

test('ambiguous replacement lookup keeps the original and reports the saved replacement', async () => {
  const { service, imap, state, mutation } = await draftFixture();
  state.omitAppendUid = true;
  imap.search = async () => [43, 44];
  const result: any = await service.update({ ...mutation, subject: 'Changed' });
  assert.equal(result.updated, false);
  assert.equal(result.replacementSaved, true);
  assert.deepEqual(state.moves, []);
});

test('signed MIME drafts can be inspected but cannot be rewritten', async () => {
  const { service, store, raw, state } = await draftFixture();
  const signed = Buffer.from(raw.toString().replace('multipart/mixed', 'multipart/signed'));
  assert.notDeepEqual(signed, raw);
  store.set(42, signed);
  const current: any = await service.get(ref);
  assert.equal(current.editable, false);
  await assert.rejects(
    service.update({
      ...ref,
      expectedMessageId: current.messageId,
      revision: current.revision,
      subject: 'Changed',
    }),
    /Signed\/encrypted/,
  );
  assert.equal(state.appendCalls, 0);
  assert.deepEqual(state.moves, []);
});

test('discard moves only the reviewed UID to Trash and refuses non-draft folders', async () => {
  const { service, mutation, state } = await draftFixture();
  await assert.rejects(service.get({ ...ref, mailbox: 'INBOX' }), /not an account Drafts/);
  const result: any = await service.discard(mutation);
  assert.equal(result.discarded, true);
  assert.equal(result.sent, false);
  assert.deepEqual(state.moves, [42]);
});

test('scoped draft management refuses a recipient outside the configured own account before APPEND', async () => {
  const { service, mutation, state } = await draftFixture({ scope: true });
  await assert.rejects(service.update({ ...mutation, bcc: 'outsider@example.com' }), /outside/);
  assert.equal(state.appendCalls, 0);
  assert.deepEqual(state.moves, []);
});

function message(
  uid: number,
  mailbox: string,
  id: string,
  references: string[] = [],
  date = uid,
): EmailMessage {
  return {
    uid,
    sourceMailbox: mailbox,
    uidValidity: 7,
    flags: [],
    date: new Date(date * 1000).toISOString(),
    size: 100,
    subject: 'Same subject',
    from: account,
    to: account,
    messageId: id,
    references,
    text: `Body ${uid}`,
  };
}
function conversationFixture(options: { failure?: boolean; maximum?: number } = {}) {
  const messages = [
    message(1, 'INBOX', '<root@example.com>', [], 1),
    message(2, 'Sent', '<reply@example.com>', ['<root@example.com>'], 2),
    message(3, 'INBOX', '<later@example.com>', ['<root@example.com>', '<reply@example.com>'], 3),
    message(4, 'Sent', '<root@example.com>', [], 1),
    message(5, 'INBOX', '<unrelated@example.com>', [], 4),
  ];
  let selected = 'INBOX';
  const bodies: number[] = [];
  const imap: any = {
    async openBox(mailbox) {
      if (options.failure && mailbox === 'Sent') throw new Error('Sent unavailable');
      selected = mailbox;
      return { uidvalidity: 7 };
    },
    async search() {
      return messages.filter(item => item.sourceMailbox === selected).map(item => item.uid);
    },
    async fetchMessages(uids) {
      return messages
        .filter(item => item.sourceMailbox === selected && uids.includes(item.uid))
        .map(({ text: _text, ...header }) => header);
    },
    async getMessage(uid) {
      bodies.push(uid);
      return messages.find(item => item.sourceMailbox === selected && item.uid === uid);
    },
  };
  return {
    bodies,
    messages,
    service: new ConversationService({
      imap,
      mailboxes: async () => ['INBOX', 'Sent'],
      maxCandidates: options.maximum ?? 100,
      maxHeaderBytes: 100000,
      maxResponseCharacters: 100000,
      formatMessage: item => item,
    }),
  };
}

test('conversation traversal includes descendants, orders them, deduplicates copies, and excludes subject-only matches', async () => {
  const { service, bodies } = conversationFixture();
  const result: any = await service.get({ mailbox: 'INBOX', uid: 1, uidValidity: 7 });
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 3);
  assert.deepEqual(
    result.messages.map((item: any) => item.messageId),
    ['<root@example.com>', '<reply@example.com>', '<later@example.com>'],
  );
  assert.equal(result.messages[0].copies.length, 2);
  assert.ok(!bodies.includes(5));
});

test('conversation reports missing ancestors, unavailable mailboxes and limits without claiming completeness', async () => {
  for (const options of [{ failure: true }, { maximum: 1 }]) {
    const { service } = conversationFixture(options);
    const result: any = await service.get({ mailbox: 'INBOX', uid: 1, uidValidity: 7 });
    assert.equal(result.complete, false);
  }
  const { service, messages } = conversationFixture();
  messages[0].references = ['<missing@example.com>'];
  const result: any = await service.get({
    mailbox: 'INBOX',
    uid: 1,
    uidValidity: 7,
    includeBody: false,
    limit: 1,
  });
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.ok(result.missingMessageIds.includes('<missing@example.com>'));
  assert.equal(result.messages[0].text, undefined);
});

test('conversation seed guards reject stale UIDVALIDITY and a changed Message-ID', async () => {
  const { service } = conversationFixture();
  await assert.rejects(service.get({ mailbox: 'INBOX', uid: 1, uidValidity: 8 }), /UIDVALIDITY/);
  await assert.rejects(
    service.get({
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: 7,
      expectedMessageId: '<wrong@example.com>',
    }),
    /Message-ID/,
  );
});

test('workflow mutation schemas require exact identity/revision and reject send switches', () => {
  for (const name of ['update_draft', 'discard_draft']) {
    const tool = MAIL_TOOLS.find(item => item.name === name)!;
    assert.equal(tool.inputSchema.safeParse(ref).success, false);
    assert.equal(
      tool.inputSchema.safeParse({
        ...ref,
        expectedMessageId: '<draft@example.com>',
        revision: 'a'.repeat(64),
        subject: 'Change',
        send: true,
      }).success,
      false,
    );
  }
});

test('capability report returns safe configuration without opening mail connections', async t => {
  Object.assign(process.env, {
    IMAP_HOST: 'localhost',
    IMAP_PORT: '1',
    IMAP_SECURE: 'true',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1',
    SMTP_SECURE: 'true',
    EMAIL_USER: account,
    EMAIL_ADDRESS: account,
    EMAIL_PASS: 'fake-capability-only',
    EMAIL_KEYCHAIN_SERVICE: '',
    MAIL_OPERATION_MODE: 'full',
  });
  delete process.env.MAIL_TEST_SCOPE;
  const { MailMCPServer } = await import('../src/mail-mcp-server');
  const server = new MailMCPServer({ registerProcessHandlers: false }) as any;
  t.after(() => server.server.close());
  server.connections.ensure = () => {
    throw new Error('Capability reporting must not connect');
  };
  const result = JSON.parse((await server.executeTool('get_capabilities', {})).content[0].text);
  assert.equal(result.availableTools.length, 20);
  assert.equal(result.testScope.enabled, false);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /fake-capability-only|EMAIL_PASS|EMAIL_KEYCHAIN_SERVICE/);
});
