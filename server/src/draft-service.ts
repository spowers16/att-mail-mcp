import { createHash, randomUUID } from 'node:crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import { DraftAppendError, type EmailMessage, type IMAPClient } from './imap-client';
import type { EmailOptions } from './smtp-client';
import type { MessageRef } from './message-ref';
import { buildRawMessage } from './message-builder';
import {
  applyDefaultHtmlStyle,
  appendSignature,
  ensureHtmlAlternative,
  extractEmailsFromAddressField,
} from './mail-utils';
import { mailboxKey, type MailTestScope } from './mail-scope';
import type { CreateDraftArgs } from './mail-types';

export interface DraftRef extends MessageRef {
  uidValidity: number;
}
export interface DraftMutationRef extends DraftRef {
  expectedMessageId: string;
  revision: string;
}
export interface UpdateDraftArgs extends DraftMutationRef, Omit<CreateDraftArgs, 'attachments'> {
  attachments?: string[];
}
interface Dependencies {
  imap: IMAPClient;
  draftMailboxes: () => Promise<string[]>;
  trashMailboxes: () => Promise<string[]>;
  scope?: MailTestScope;
  account: string;
  maxMessageBytes: number;
  maxBodyCharacters: number;
  maxAttachmentBytes: number;
  readAttachments: (paths?: string[]) => Promise<EmailOptions['attachments']>;
  formatMessage: (message: EmailMessage) => EmailMessage;
  canUpdate?: boolean;
}
const address = (value: unknown) => extractEmailsFromAddressField(value).join(', ');
const signature = (ref: DraftRef, raw: Buffer) =>
  createHash('sha256')
    .update(JSON.stringify([mailboxKey(ref.mailbox), ref.uidValidity, ref.uid]))
    .update(raw)
    .digest('hex');

export class DraftService {
  constructor(private readonly dependencies: Dependencies) {}
  private async read(ref: DraftRef) {
    const { imap, scope } = this.dependencies;
    if (
      !(await this.dependencies.draftMailboxes()).some(
        name => mailboxKey(name) === mailboxKey(ref.mailbox),
      )
    )
      throw new Error('The selected mailbox is not an account Drafts folder');
    if (scope) await scope.assertRef(imap, ref);
    const box = await imap.openBox(ref.mailbox, true);
    if (box.uidvalidity !== ref.uidValidity)
      throw new Error('Draft UIDVALIDITY changed; refresh the draft');
    const raw = await imap.fetchRawMessage(ref.uid);
    const parsed = await simpleParser(raw, { skipImageLinks: true });
    const message: EmailMessage = {
      uid: ref.uid,
      sourceMailbox: ref.mailbox,
      uidValidity: ref.uidValidity,
      flags: [],
      date: parsed.date?.toISOString() || '',
      size: raw.length,
      subject: parsed.subject || '',
      from: address(parsed.from),
      to: address(parsed.to),
      cc: address(parsed.cc) || undefined,
      bcc: address(parsed.bcc) || undefined,
      replyTo: address(parsed.replyTo) || undefined,
      text: parsed.text,
      html: typeof parsed.html === 'string' ? parsed.html : undefined,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : undefined,
      attachments: parsed.attachments.map((file, index) => ({
        index,
        filename: file.filename || `attachment_${index + 1}`,
        size: file.content.length,
        contentType: file.contentType,
        contentId: file.contentId,
        contentDisposition: file.contentDisposition,
      })),
    };
    if (scope && !scope.accepts(message)) throw new Error('Draft is outside MAIL_TEST_SCOPE');
    return { raw, parsed, message, revision: signature(ref, raw) };
  }
  async get(ref: DraftRef): Promise<Record<string, unknown>> {
    const value = await this.read(ref);
    return {
      ...this.dependencies.formatMessage(value.message),
      revision: value.revision,
      editable:
        this.dependencies.canUpdate !== false &&
        Boolean(value.parsed.messageId) &&
        this.owned(value.parsed) &&
        !this.protectedMime(value.parsed),
      yahooEditThreadingSupported: value.parsed.inReplyTo ? false : undefined,
      note: 'Unsent draft. Use this revision and Message-ID for updates/discard. Yahoo can assign a new UID when saving an edit.',
    };
  }
  private owned(parsed: ParsedMail): boolean {
    const from = extractEmailsFromAddressField(parsed.from);
    return from.length === 1 && from[0].toLowerCase() === this.dependencies.account.toLowerCase();
  }
  private protectedMime(parsed: ParsedMail): boolean {
    const type = parsed.headers.get('content-type') as { value?: string } | undefined;
    return /multipart\/(signed|encrypted)|application\/(x-)?pkcs7-mime/i.test(type?.value || '');
  }
  private assertRevision(ref: DraftMutationRef, value: Awaited<ReturnType<DraftService['read']>>) {
    if (
      !value.parsed.messageId ||
      value.parsed.messageId !== ref.expectedMessageId ||
      value.revision !== ref.revision
    )
      throw new Error('Draft changed since review; get_draft again before changing it');
    if (!this.owned(value.parsed)) throw new Error('Draft sender does not match this account');
  }
  private async trashMailbox(source: string): Promise<string> {
    for (const name of await this.dependencies.trashMailboxes()) {
      if (mailboxKey(name) === mailboxKey(source)) continue;
      if (
        this.dependencies.scope &&
        !this.dependencies.scope.config.mailboxes.some(
          allowed => mailboxKey(allowed) === mailboxKey(name),
        )
      )
        continue;
      try {
        await this.dependencies.imap.openBox(name, true);
        return name;
      } catch {
        /* Discovery checks are read-only. */
      }
    }
    throw new Error(
      'No selectable allowed Trash folder; configure MAIL_TRASH_MAILBOX. No draft was changed',
    );
  }
  private async moveToTrash(ref: DraftMutationRef, trash: string) {
    this.assertRevision(ref, await this.read(ref));
    // The same immutable UID is moved only after a second revision check.
    await this.dependencies.imap.openBox(ref.mailbox, true);
    const moved = await this.dependencies.imap.moveMessage(ref.uid, trash, ref.uidValidity);
    return { mailbox: trash, uid: moved.destinationUid };
  }
  async discard(ref: DraftMutationRef): Promise<Record<string, unknown>> {
    this.assertRevision(ref, await this.read(ref));
    const trash = await this.trashMailbox(ref.mailbox);
    try {
      return {
        discarded: true,
        sent: false,
        original: ref,
        trash: await this.moveToTrash(ref, trash),
        note: 'Draft moved to Trash. It was not sent or permanently deleted.',
      };
    } catch (error) {
      return {
        discarded: false,
        sent: false,
        outcome: 'unknown-or-not-moved',
        original: ref,
        trashMailbox: trash,
        error: error instanceof Error ? error.message : 'Move failed',
        note: 'Inspect Drafts and Trash before retrying; no permanent delete or send was requested.',
      };
    }
  }
  private semantic(parsed: ParsedMail): string {
    return JSON.stringify({
      from: address(parsed.from),
      replyTo: address(parsed.replyTo),
      to: address(parsed.to),
      cc: address(parsed.cc),
      bcc: address(parsed.bcc),
      subject: parsed.subject || '',
      text: parsed.text?.replace(/\r\n/g, '\n'),
      html: parsed.html || false,
      id: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      attachments: parsed.attachments.map(file => ({
        name: file.filename,
        type: file.contentType,
        cid: file.contentId,
        disposition: file.contentDisposition,
        hash: createHash('sha256').update(file.content).digest('hex'),
      })),
    });
  }
  async update(args: UpdateDraftArgs): Promise<Record<string, unknown>> {
    const original = await this.read(args);
    this.assertRevision(args, original);
    if (this.protectedMime(original.parsed))
      throw new Error('Signed/encrypted MIME drafts require their native mail editor');
    const trash = await this.trashMailbox(args.mailbox);
    const changingBody = args.text !== undefined || args.html !== undefined;
    const signed = ensureHtmlAlternative(
      appendSignature(
        changingBody ? args.text : original.message.text,
        changingBody ? args.html : original.message.html,
        args.signature,
      ),
    );
    const options: EmailOptions = {
      from: this.dependencies.account,
      replyTo: original.message.replyTo,
      to: args.to ?? original.message.to,
      cc: args.cc ?? original.message.cc,
      bcc: args.bcc ?? original.message.bcc,
      subject: args.subject ?? original.message.subject,
      text: signed.text,
      html: changingBody ? applyDefaultHtmlStyle(signed.html) : signed.html,
      messageId: `<${randomUUID()}@${this.dependencies.account.split('@').at(-1)}>`,
      inReplyTo: original.message.inReplyTo,
      references: original.message.references,
      attachments:
        args.attachments !== undefined
          ? await this.dependencies.readAttachments(args.attachments)
          : original.parsed.attachments.map((file, index) => ({
              filename: file.filename || `attachment_${index + 1}`,
              content: file.content,
              contentType: file.contentType,
              cid: file.cid,
              contentDisposition: file.contentDisposition === 'inline' ? 'inline' : 'attachment',
            })),
    };
    if (!options.text && !options.html) throw new Error('Draft must contain a text or HTML body');
    if (
      (options.attachments?.length || 0) > 20 ||
      (options.attachments || []).reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) >
        this.dependencies.maxAttachmentBytes
    )
      throw new Error('Preserved draft attachments exceed the configured file/byte limit');
    for (const body of [options.text, options.html])
      if (body && body.length > this.dependencies.maxBodyCharacters)
        throw new Error('Draft body exceeds the configured character limit');
    this.dependencies.scope?.assertOutgoing(options);
    const raw = await buildRawMessage(options);
    if (raw.length > this.dependencies.maxMessageBytes)
      throw new Error('Replacement exceeds MAIL_MAX_DRAFT_BYTES');
    this.assertRevision(args, await this.read(args));
    let saved;
    try {
      saved = await this.dependencies.imap.saveDraftToFolder(raw, args.mailbox);
    } catch (error) {
      const knownNotSaved = error instanceof DraftAppendError && error.outcome === 'not-appended';
      return {
        updated: false,
        sent: false,
        replacementSaved: knownNotSaved ? false : 'unknown',
        originalMoved: false,
        replacementMessageId: options.messageId,
        error: error instanceof Error ? error.message : 'Append failed',
        note: 'Original draft was not moved. Inspect Drafts for the replacement Message-ID before retrying.',
      };
    }
    const replacement: Record<string, unknown> = {
      mailbox: args.mailbox,
      uid: saved.uid,
      uidValidity: saved.uidValidity,
      messageId: options.messageId,
    };
    try {
      if (saved.uidValidity !== args.uidValidity)
        throw new Error('Draft mailbox UIDVALIDITY changed during save');
      if (!saved.uid) {
        const box = await this.dependencies.imap.openBox(args.mailbox, true);
        if (box.uidvalidity !== args.uidValidity)
          throw new Error('Draft mailbox UIDVALIDITY changed');
        const uids = await this.dependencies.imap.search([
          ['HEADER', 'MESSAGE-ID', options.messageId!],
        ]);
        if (uids.length !== 1) throw new Error('Cannot uniquely identify the saved replacement');
        saved.uid = uids[0];
        replacement.uid = saved.uid;
      }
      const fresh = await this.read({
        mailbox: args.mailbox,
        uid: saved.uid,
        uidValidity: saved.uidValidity,
      });
      if (
        this.semantic(fresh.parsed) !==
        this.semantic(await simpleParser(raw, { skipImageLinks: true }))
      )
        throw new Error('Replacement readback did not preserve MIME content');
      replacement.revision = fresh.revision;
      const destination = await this.moveToTrash(args, trash);
      return {
        updated: true,
        sent: false,
        replacementSaved: true,
        originalMoved: true,
        replacement,
        originalTrash: destination,
        yahooEditThreadingSupported: options.inReplyTo ? false : undefined,
        warning: options.inReplyTo
          ? 'Yahoo editing may remove imported reply headers. Native Yahoo Reply remains the supported editable threading workflow.'
          : undefined,
        note: 'Replacement verified; original moved to Trash. Use the returned new UID and revision for further edits.',
      };
    } catch (error) {
      return {
        updated: false,
        sent: false,
        replacementSaved: true,
        originalMoved: 'unknown-or-not-moved',
        replacement,
        error: error instanceof Error ? error.message : 'Verification or cleanup failed',
        note: 'A replacement exists. Inspect Drafts and Trash before any retry; both versions may remain. No send or permanent delete was requested.',
      };
    }
  }
}
