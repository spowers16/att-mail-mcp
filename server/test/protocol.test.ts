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
async function fixture(t: TestContext, mode: 'full' | 'draft-only' | 'read-only') {
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
    smtpMessages: [] as Buffer[],
    recipients: [] as string[],
    commands: [] as string[],
  };
  const parent = Buffer.from(
    'From: sender@example.com\r\nTo: offline@example.com\r\nSubject: Protocol fixture\r\nMessage-ID: <parent@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal fixture body\r\n',
  );
  const track = (socket: tls.TLSSocket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  const imap = tls.createServer(credentials, socket => {
    track(socket);
    socket.write('* OK loopback fixture ready\r\n');
    let buffer = Buffer.alloc(0);
    let literal: { tag: string; bytes: number } | undefined;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (literal) {
          if (buffer.length < literal.bytes + 2) return;
          state.appends.push(Buffer.from(buffer.subarray(0, literal.bytes)));
          buffer = buffer.subarray(literal.bytes + 2);
          socket.write(`${literal.tag} OK [APPENDUID 7 42] stored\r\n`);
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
        const verb = command.split(' ')[0];
        state.commands.push(verb);
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (command === 'CAPABILITY') {
          socket.write('* CAPABILITY IMAP4rev1 UIDPLUS\r\n');
          ok();
        } else if (/^(LOGIN|NOOP)/.test(command)) ok();
        else if (/^LIST /.test(command)) {
          if (command.endsWith('""')) socket.write('* LIST (\\Noselect) "/" ""\r\n');
          else
            socket.write(
              '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\Drafts \\HasNoChildren) "/" "Draft"\r\n',
            );
          ok();
        } else if (/^(SELECT|EXAMINE) /.test(command)) {
          socket.write(
            '* FLAGS (\\Seen \\Draft)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT 43] next\r\n',
          );
          ok();
        } else if (/^APPEND /.test(command)) {
          const bytes = Number(/\{(\d+)\}$/.exec(command)?.[1]);
          assert.ok(Number.isSafeInteger(bytes));
          literal = { tag, bytes };
          socket.write('+ Ready for literal\r\n');
        } else if (/^UID FETCH /.test(command)) {
          const uid = Number(/^UID FETCH (\d+)/.exec(command)?.[1]);
          const raw = uid === 41 ? parent : state.appends.at(-1);
          if (raw) {
            socket.write(
              `* 1 FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "01-Nov-2026 12:00:00 +0000" RFC822.SIZE ${raw.length} BODY[] {${raw.length}}\r\n`,
            );
            socket.write(raw);
            socket.write(')\r\n');
          }
          ok();
        } else if (command === 'LOGOUT') {
          socket.end(`* BYE closing\r\n${tag} OK logged out\r\n`);
        } else socket.write(`${tag} BAD unexpected fixture command\r\n`);
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
  return { client, state, directory, call };
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
    const { client, state, call } = await fixture(t, 'read-only');
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 6);
    assert.equal(names.includes('create_draft'), false);
    await call('check_connection', {});
    assert.equal(state.smtpConnections, 0);
    assert.equal(state.appends.length, 0);
  },
);
