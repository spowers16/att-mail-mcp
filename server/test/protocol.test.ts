import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { simpleParser } from 'mailparser';

// These are loopback TLS services, not mocked client internals. No provider
// endpoint, Keychain item, or real address is used by this suite.
async function fixture(t: TestContext, mode: 'full' | 'draft-only' | 'read-only', scoped = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mail-protocol-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  const credentials = { key: await readFile(keyFile), cert: await readFile(certFile) };
  const sockets = new Set<tls.TLSSocket>();
  const state = {
    appends: [] as Buffer[],
    smtpConnections: 0,
    imapConnections: 0,
    fetches: [] as Array<{ mailbox: string; uid: number; headers: boolean }>,
    moves: [] as Array<{ mailbox: string; uid: number; destination: string }>,
    smtpMessages: [] as Buffer[],
    recipients: [] as string[],
    commands: [] as string[],
  };
  const parent = Buffer.from(
    `From: ${scoped ? 'offline@example.com' : 'sender@example.com'}\r\nTo: offline@example.com\r\nSubject: Protocol fixture\r\nMessage-ID: <parent@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal fixture body\r\n`,
  );
  const unrelated = Buffer.from(
    'From: unrelated@example.com\r\nTo: offline@example.com\r\nSubject: Protocol fixture\r\nMessage-ID: <unrelated@example.com>\r\n\r\nUnrelated private body\r\n',
  );
  const folders = new Map<string, Map<number, Buffer>>([
    [
      'INBOX',
      new Map([
        [41, parent],
        [99, unrelated],
      ]),
    ],
    ['Sent', new Map()],
    ['Draft', new Map()],
    ['Trash', new Map()],
  ]);
  let nextUid = 42;
  const headers = (raw: Buffer): Record<string, string> =>
    Object.fromEntries(
      raw
        .toString()
        .split('\r\n\r\n')[0]
        .replace(/\r\n[ \t]+/g, ' ')
        .split('\r\n')
        .map(line => {
          const index = line.indexOf(':');
          return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }),
    );
  function matches(raw: Buffer, uid: number, criteria: string): boolean {
    const tokens = criteria.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) || [];
    let index = 0;
    const token = () => {
      const value = tokens[index++] || '';
      return value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
    };
    const h = headers(raw);
    function expression(): boolean {
      const key = token().toUpperCase();
      if (key === '(') {
        const values: boolean[] = [];
        while (tokens[index] !== ')' && index < tokens.length) values.push(expression());
        token();
        return values.every(Boolean);
      }
      if (key === 'OR') {
        const left = expression();
        const right = expression();
        return left || right;
      }
      if (key === 'NOT') return !expression();
      if (key === 'ALL' || key === 'SEEN') return true;
      if (key === 'UNSEEN' || key === 'DELETED') return false;
      if (key === 'CHARSET') {
        token();
        return true;
      }
      if (key === 'UID')
        return token()
          .split(',')
          .some(value => value === String(uid));
      if (key === 'HEADER') {
        const name = token().toLowerCase();
        const value = token();
        return (h[name] || '').includes(value);
      }
      if (['FROM', 'TO', 'SUBJECT', 'BODY'].includes(key)) {
        const value = token();
        return (key === 'BODY' ? raw.toString() : h[key.toLowerCase()] || '').includes(value);
      }
      throw new Error(`Unsupported fixture search criterion: ${key}`);
    }
    const values: boolean[] = [];
    while (index < tokens.length) values.push(expression());
    return values.every(Boolean);
  }
  const track = (socket: tls.TLSSocket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  const imap = tls.createServer(credentials, socket => {
    track(socket);
    state.imapConnections++;
    socket.write('* OK loopback fixture ready\r\n');
    let selected = 'INBOX';
    let buffer = Buffer.alloc(0);
    let literal: { tag: string; bytes: number; mailbox: string } | undefined;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (literal) {
          if (buffer.length < literal.bytes + 2) return;
          const raw = Buffer.from(buffer.subarray(0, literal.bytes));
          state.appends.push(raw);
          const uid = nextUid++;
          folders.get(literal.mailbox)!.set(uid, raw);
          buffer = buffer.subarray(literal.bytes + 2);
          socket.write(`${literal.tag} OK [APPENDUID 7 ${uid}] stored\r\n`);
          literal = undefined;
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 2);
        const match = /^(\S+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, command] = match;
        state.commands.push(command.split(' ')[0]);
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (command === 'CAPABILITY') {
          socket.write('* CAPABILITY IMAP4rev1 UIDPLUS MOVE\r\n');
          ok();
        } else if (/^(LOGIN|NOOP)/.test(command)) ok();
        else if (/^LIST /.test(command)) {
          if (command.endsWith('""')) socket.write('* LIST (\\Noselect) "/" ""\r\n');
          else
            for (const name of folders.keys())
              socket.write(
                `* LIST (${name === 'Draft' ? '\\Drafts ' : name === 'Trash' ? '\\Trash ' : name === 'Sent' ? '\\Sent ' : ''}\\HasNoChildren) "/" "${name}"\r\n`,
              );
          ok();
        } else if (/^(SELECT|EXAMINE) /.test(command)) {
          selected = command.replace(/^(SELECT|EXAMINE) /, '').replace(/^"|"$/g, '');
          if (!folders.has(selected)) {
            socket.write(`${tag} NO no such mailbox\r\n`);
            continue;
          }
          socket.write(
            `* FLAGS (\\Seen \\Draft)\r\n* ${folders.get(selected)!.size} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT ${nextUid}] next\r\n`,
          );
          ok();
        } else if (/^APPEND /.test(command)) {
          const bytes = Number(/\{(\d+)\}$/.exec(command)?.[1]);
          assert.ok(Number.isSafeInteger(bytes));
          const mailbox = /^APPEND "([^"]+)"/.exec(command)?.[1] || selected;
          literal = { tag, bytes, mailbox };
          socket.write('+ Ready for literal\r\n');
        } else if (/^UID SEARCH /.test(command)) {
          const result = [...folders.get(selected)!.entries()]
            .filter(([uid, raw]) => matches(raw, uid, command.slice('UID SEARCH '.length)))
            .map(([uid]) => uid);
          socket.write('* SEARCH' + (result.length ? ' ' + result.join(' ') : '') + '\r\n');
          ok();
        } else if (/^UID FETCH /.test(command)) {
          const wanted = /^UID FETCH ([^ ]+)/.exec(command)![1].split(',').map(Number);
          const fields = /HEADER\.FIELDS \(([^)]+)\)/.exec(command)?.[1];
          for (const uid of wanted) {
            const raw = folders.get(selected)!.get(uid);
            if (!raw) continue;
            state.fetches.push({ mailbox: selected, uid, headers: Boolean(fields) });
            const h = headers(raw);
            const payload = fields
              ? Buffer.from(
                  fields
                    .split(' ')
                    .filter(name => h[name.toLowerCase()] !== undefined)
                    .map(name => `${name}: ${h[name.toLowerCase()]}`)
                    .join('\r\n') + '\r\n\r\n',
                )
              : raw;
            socket.write(
              `* 1 FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "01-Nov-2026 12:00:00 +0000" RFC822.SIZE ${raw.length} BODY[${fields ? 'HEADER.FIELDS (' + fields + ')' : ''}] {${payload.length}}\r\n`,
            );
            socket.write(payload);
            socket.write(')\r\n');
          }
          ok();
        } else if (/^UID MOVE /.test(command)) {
          const match = /^UID MOVE (\d+) "([^"]+)"/.exec(command)!;
          const uid = Number(match[1]);
          const destination = match[2];
          const raw = folders.get(selected)!.get(uid);
          if (!raw || !folders.has(destination)) {
            socket.write(`${tag} NO missing source or target\r\n`);
            continue;
          }
          const targetUid = nextUid++;
          folders.get(destination)!.set(targetUid, raw);
          folders.get(selected)!.delete(uid);
          state.moves.push({ mailbox: selected, uid, destination });
          socket.write(`${tag} OK [COPYUID 7 ${uid} ${targetUid}] moved\r\n`);
        } else if (command === 'LOGOUT') socket.end(`* BYE closing\r\n${tag} OK logged out\r\n`);
        else socket.write(`${tag} BAD unexpected fixture command\r\n`);
      }
    });
  });
  const smtp = tls.createServer(credentials, socket => {
    track(socket);
    state.smtpConnections++;
    socket.write('220 localhost fixture\r\n');
    let buffer = '';
    let data = false;
    let lines: string[] = [];
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            state.smtpMessages.push(Buffer.from(lines.join('\r\n') + '\r\n'));
            data = false;
            lines = [];
            socket.write('250 accepted fixture\r\n');
          } else lines.push(line.startsWith('..') ? line.slice(1) : line);
        } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) socket.write('235 authenticated\r\n');
        else if (/^MAIL FROM:/.test(line)) socket.write('250 sender ok\r\n');
        else if (/^RCPT TO:/.test(line)) {
          state.recipients.push(line);
          socket.write('250 recipient ok\r\n');
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 send data\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await Promise.all([
    new Promise<void>(resolve => imap.listen(0, '127.0.0.1', resolve)),
    new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve)),
  ]);
  const port = (server: tls.Server) => (server.address() as { port: number }).port;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(EMAIL_|IMAP_|SMTP_|MAIL_)/.test(name)),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...env,
      NODE_EXTRA_CA_CERTS: certFile,
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      IMAP_HOST: 'localhost',
      IMAP_PORT: String(port(imap)),
      IMAP_SECURE: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port(smtp)),
      SMTP_SECURE: 'true',
      EMAIL_USER: 'offline@example.com',
      EMAIL_ADDRESS: 'offline@example.com',
      EMAIL_PASS: 'fake-protocol-only',
      EMAIL_KEYCHAIN_SERVICE: '',
      MAIL_ALLOWED_ROOTS: directory,
      MAIL_OPERATION_MODE: mode,
      ...(scoped
        ? {
            MAIL_TEST_SCOPE: JSON.stringify({
              account: 'offline@example.com',
              seed: {
                mailbox: 'INBOX',
                uid: 41,
                uidValidity: 7,
                messageId: '<parent@example.com>',
              },
              mailboxes: ['INBOX', 'Sent', 'Draft', 'Trash'],
            }),
          }
        : {}),
      MAIL_APPEND_SENT_COPY: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'loopback-integration', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>(resolve => imap.close(() => resolve())),
      new Promise<void>(resolve => smtp.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 15000,
    });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  }
  return { client, state, directory, call, folders };
}

test(
  'compiled draft-only MCP saves and reads attachment replies over TLS without opening SMTP',
  { timeout: 30000 },
  async t => {
    const { client, state, directory, call } = await fixture(t, 'draft-only');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(tools.includes('send_email'), false);
    assert.ok(tools.includes('create_reply_draft'));
    const file = path.join(directory, 'résumé.bin');
    const bytes = Buffer.from([0, 255, 17, 10, 13]);
    await writeFile(file, bytes);
    const saved = await call('create_reply_draft', {
      mailbox: 'INBOX',
      originalUid: 41,
      uidValidity: 7,
      expectedMessageId: '<parent@example.com>',
      text: 'Fixture reply',
      attachments: [file],
    });
    assert.equal(saved.sent, false);
    assert.equal(saved.uid, 42);
    assert.equal(saved.yahooEditThreadingSupported, false);
    const parsed = await simpleParser(state.appends[0]);
    assert.equal(parsed.inReplyTo, '<parent@example.com>');
    assert.deepEqual(parsed.attachments[0].content, bytes);
    const read = await call('get_message', {
      mailbox: 'Draft',
      uid: 42,
      uidValidity: 7,
      markSeen: false,
    });
    assert.equal(read.inReplyTo, '<parent@example.com>');
    assert.equal(read.attachments[0].filename, 'résumé.bin');
    const denied = await client.callTool({
      name: 'get_message',
      arguments: { mailbox: 'Draft', uid: 42, markSeen: true },
    });
    assert.equal(denied.isError, true);
    await call('check_connection', {});
    const blocked = await client.callTool({
      name: 'send_email',
      arguments: { to: 'recipient@example.com', subject: 'blocked', text: 'blocked' },
    });
    assert.equal(blocked.isError, true);
    assert.equal(state.smtpConnections, 0);
    assert.equal(state.appends.length, 1);
  },
);

test(
  'compiled full MCP delivers MIME and Bcc envelope only to a loopback SMTP fixture',
  { timeout: 30000 },
  async t => {
    const { state, directory, call } = await fixture(t, 'full');
    const file = path.join(directory, 'attachment.bin');
    const bytes = Buffer.from([3, 2, 1, 0, 255]);
    await writeFile(file, bytes);
    const sent = await call('send_email', {
      to: 'recipient@example.com',
      bcc: 'blind@example.com',
      subject: 'Loopback only',
      text: 'Fixture send',
      attachments: [file],
    });
    assert.equal(sent.accepted.length, 2);
    assert.equal(state.smtpMessages.length, 1);
    assert.equal(state.appends.length, 0);
    const parsed = await simpleParser(state.smtpMessages[0]);
    assert.equal(parsed.bcc, undefined);
    assert.deepEqual(parsed.attachments[0].content, bytes);
    assert.ok(state.recipients.some(line => line.includes('blind@example.com')));
  },
);

test(
  'compiled read-only MCP hides mutation tools and connection checks leave SMTP unopened',
  { timeout: 30000 },
  async t => {
    const { client, state, call, folders } = await fixture(t, 'read-only');
    folders
      .get('Draft')!
      .set(
        42,
        Buffer.from(
          'From: offline@example.com\r\nTo: offline@example.com\r\nMessage-ID: <readonly@example.com>\r\n\r\nDraft body',
        ),
      );
    const viewed = await call('get_draft', { mailbox: 'Draft', uid: 42, uidValidity: 7 });
    assert.equal(viewed.editable, false);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 10);
    assert.equal(names.includes('create_draft'), false);
    await call('check_connection', {});
    assert.equal(state.smtpConnections, 0);
    assert.equal(state.appends.length, 0);
  },
);

test(
  'compiled draft lifecycle verifies replacement and moves reviewed versions to Trash over TLS',
  { timeout: 30000 },
  async t => {
    const { state, directory, call, client, folders } = await fixture(t, 'draft-only');
    const capabilities = await call('get_capabilities', {});
    assert.equal(capabilities.serverVersion, '2.0.3-att.2');
    assert.equal(state.imapConnections, 0);
    assert.equal(state.smtpConnections, 0);
    const file = path.join(directory, 'draft.bin');
    const bytes = Buffer.from([0, 255, 7, 8]);
    await writeFile(file, bytes);
    const saved = await call('create_draft', {
      to: 'recipient@example.com',
      bcc: 'blind@example.com',
      subject: 'Lifecycle',
      text: 'Initial draft',
      attachments: [file],
    });
    const listed = await call('list_drafts', {});
    assert.equal(listed.messages.length, 1);
    const reviewed = await call('get_draft', { mailbox: 'Draft', uid: saved.uid, uidValidity: 7 });
    const changed = await call('update_draft', {
      mailbox: 'Draft',
      uid: saved.uid,
      uidValidity: 7,
      expectedMessageId: reviewed.messageId,
      revision: reviewed.revision,
      subject: 'Revised lifecycle',
    });
    assert.equal(changed.updated, true);
    assert.equal(changed.originalMoved, true);
    assert.notEqual(changed.replacement.uid, saved.uid);
    assert.equal(folders.get('Draft')!.has(saved.uid), false);
    assert.equal(state.moves.length, 1);
    assert.equal(state.moves[0].destination, 'Trash');
    const parsed = await simpleParser(folders.get('Draft')!.get(changed.replacement.uid)!);
    assert.deepEqual(parsed.attachments[0].content, bytes);
    assert.equal((parsed.bcc as any).value[0].address, 'blind@example.com');
    const stale = await client.callTool({
      name: 'update_draft',
      arguments: {
        mailbox: 'Draft',
        uid: saved.uid,
        uidValidity: 7,
        expectedMessageId: reviewed.messageId,
        revision: reviewed.revision,
        text: 'Stale retry',
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(state.appends.length, 2);
    const fresh = await call('get_draft', {
      mailbox: 'Draft',
      uid: changed.replacement.uid,
      uidValidity: 7,
    });
    const discarded = await call('discard_draft', {
      mailbox: 'Draft',
      uid: fresh.uid,
      uidValidity: 7,
      expectedMessageId: fresh.messageId,
      revision: fresh.revision,
    });
    assert.equal(discarded.discarded, true);
    assert.equal(folders.get('Draft')!.size, 0);
    assert.equal(folders.get('Trash')!.size, 2);
    assert.equal(state.smtpConnections, 0);
  },
);

test(
  'compiled strict scope blocks unrelated bodies, recipients, unthreaded drafts and every SMTP tool',
  { timeout: 30000 },
  async t => {
    const { client, call, state, folders } = await fixture(t, 'full', true);
    const caps = await call('get_capabilities', {});
    assert.equal(caps.effectiveOperationMode, 'draft-only');
    assert.equal(caps.testScope.enabled, true);
    assert.equal(state.imapConnections, 0);
    assert.equal(state.smtpConnections, 0);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of [
      'send_email',
      'reply_to_email',
      'continue_email_thread',
      'create_draft',
      'delete_message',
      'move_message',
    ])
      assert.equal(names.includes(name), false);
    const unrelated = await client.callTool({
      name: 'get_messages',
      arguments: { mailbox: 'INBOX', uids: [41, 99], uidValidity: 7 },
    });
    assert.equal(unrelated.isError, true);
    assert.equal(state.fetches.filter(fetch => !fetch.headers).length, 0);
    const searched = await call('search_messages', { includeBody: true });
    assert.equal(searched.messages.length, 1);
    assert.equal(searched.messages[0].uid, 41);
    const draft = await call('create_reply_draft', {
      mailbox: 'INBOX',
      originalUid: 41,
      uidValidity: 7,
      expectedMessageId: '<parent@example.com>',
      text: 'Scoped reply',
    });
    const conversation = await call('get_conversation', {
      mailbox: 'INBOX',
      uid: 41,
      uidValidity: 7,
    });
    assert.equal(conversation.complete, true);
    assert.equal(conversation.messages.length, 2);
    const reviewed = await call('get_draft', { mailbox: 'Draft', uid: draft.uid, uidValidity: 7 });
    const denied = await client.callTool({
      name: 'update_draft',
      arguments: {
        mailbox: 'Draft',
        uid: draft.uid,
        uidValidity: 7,
        expectedMessageId: reviewed.messageId,
        revision: reviewed.revision,
        bcc: 'outsider@example.com',
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(state.appends.length, 1);
    const outsideFolder = await client.callTool({
      name: 'get_conversation',
      arguments: { mailbox: 'INBOX', uid: 41, uidValidity: 7, mailboxes: ['Other'] },
    });
    assert.equal(outsideFolder.isError, true);
    const noScopeSwitch = await client.callTool({
      name: 'get_message',
      arguments: { mailbox: 'INBOX', uid: 99, uidValidity: 7, testScope: false },
    });
    assert.equal(noScopeSwitch.isError, true);
    const noSend = await client.callTool({
      name: 'send_email',
      arguments: { to: 'offline@example.com', subject: 'Forbidden', text: 'Do not send' },
    });
    assert.equal(noSend.isError, true);
    await call('check_connection', {});
    assert.equal(state.smtpConnections, 0);
    assert.ok(!state.fetches.some(fetch => fetch.uid === 99 && !fetch.headers));
    folders
      .get('INBOX')!
      .set(
        41,
        Buffer.from(
          'From: offline@example.com\r\nTo: offline@example.com\r\nMessage-ID: <different@example.com>\r\n\r\nChanged seed',
        ),
      );
    const wrongAnchor = await client.callTool({ name: 'list_drafts', arguments: {} });
    assert.equal(wrongAnchor.isError, true);
    assert.equal(state.appends.length, 1);
  },
);
