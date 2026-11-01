import * as z from 'zod/v4';
import type { EmailMessage, IMAPClient } from './imap-client';
import type { MessageRef } from './message-ref';
import { isSafeMailboxName } from './message-ref';
import { extractEmailsFromAddressField } from './mail-utils';

export const HEADER_FIELDS =
  'HEADER.FIELDS (FROM REPLY-TO TO CC BCC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)';
export const mailboxKey = (name: string) => (name.toUpperCase() === 'INBOX' ? 'INBOX' : name);
export const messageIds = (
  message: Pick<EmailMessage, 'messageId' | 'inReplyTo' | 'references'>,
): string[] => [
  ...new Set(
    [message.messageId, message.inReplyTo, ...(message.references || [])].flatMap(
      value => value?.match(/<[^<>\s]+>/g) || [],
    ),
  ),
];
export function headerCriteria(ids: string[]): any[] {
  const leaves = ids.flatMap(id => [
    ['HEADER', 'MESSAGE-ID', id],
    ['HEADER', 'IN-REPLY-TO', id],
    ['HEADER', 'REFERENCES', id],
  ]);
  if (!leaves.length) throw new Error('At least one Message-ID is required');
  return [leaves.slice(1).reduce<any[]>((left, right) => ['OR', left, right], leaves[0])];
}

const positive = z.number().int().safe().min(1);
const scopeSchema = z
  .object({
    account: z.email().max(320),
    seed: z
      .object({
        mailbox: z.string().min(1).max(1024),
        uid: positive,
        uidValidity: positive,
        messageId: z
          .string()
          .regex(/^<[^<>\s]+>$/)
          .max(998),
      })
      .strict(),
    mailboxes: z.array(z.string().min(1).max(1024)).min(1).max(20),
  })
  .strict();
export type TestScopeConfig = z.infer<typeof scopeSchema>;
export function parseTestScope(value: string | undefined, account: string): TestScopeConfig | null {
  if (value === undefined) return null;
  try {
    if (value.length > 16384) throw new Error();
    const parsed = scopeSchema.parse(JSON.parse(value));
    if (
      !isSafeMailboxName(parsed.seed.mailbox) ||
      parsed.mailboxes.some(name => !isSafeMailboxName(name))
    )
      throw new Error();
    if (
      parsed.account.toLowerCase() !== account.toLowerCase() ||
      !parsed.mailboxes.some(name => mailboxKey(name) === mailboxKey(parsed.seed.mailbox)) ||
      new Set(parsed.mailboxes.map(mailboxKey)).size !== parsed.mailboxes.length
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error(
      'MAIL_TEST_SCOPE must contain a valid own-account seed reference and explicit unique mailboxes',
    );
  }
}

export class MailTestScope {
  constructor(readonly config: TestScopeConfig) {}
  criteria() {
    return headerCriteria([this.config.seed.messageId]);
  }
  assertMailbox(mailbox: string): void {
    if (!this.config.mailboxes.some(name => mailboxKey(name) === mailboxKey(mailbox)))
      throw new Error('Mailbox is outside MAIL_TEST_SCOPE');
  }
  accepts(message: EmailMessage): boolean {
    const from = extractEmailsFromAddressField(message.from || '');
    const addresses = [message.from, message.replyTo, message.to, message.cc, message.bcc].flatMap(
      value => extractEmailsFromAddressField(value || ''),
    );
    return (
      messageIds(message).includes(this.config.seed.messageId) &&
      from.length === 1 &&
      addresses.length > 0 &&
      addresses.every(address => address.toLowerCase() === this.config.account.toLowerCase())
    );
  }
  async assertAnchor(imap: IMAPClient): Promise<void> {
    const seed = this.config.seed;
    const box = await imap.openBox(seed.mailbox, true);
    if (box.uidvalidity !== seed.uidValidity) throw new Error('Test seed UIDVALIDITY changed');
    const [message] = await imap.fetchMessages([seed.uid], {
      bodies: [HEADER_FIELDS],
      markSeen: false,
      byteBudget: { used: 0, limit: 262144 },
    });
    if (!message || message.messageId !== seed.messageId || !this.accepts(message))
      throw new Error('Test seed identity or own-account recipients do not match MAIL_TEST_SCOPE');
  }
  async assertRef(imap: IMAPClient, ref: MessageRef): Promise<void> {
    this.assertMailbox(ref.mailbox);
    if (!ref.uidValidity) throw new Error('UIDVALIDITY is required in MAIL_TEST_SCOPE');
    await this.assertAnchor(imap);
    const box = await imap.openBox(ref.mailbox, true);
    if (box.uidvalidity !== ref.uidValidity) throw new Error('Scoped message UIDVALIDITY changed');
    const [message] = await imap.fetchMessages([ref.uid], {
      bodies: [HEADER_FIELDS],
      markSeen: false,
      byteBudget: { used: 0, limit: 262144 },
    });
    if (!message || !this.accepts(message))
      throw new Error('Message is outside the own-account test conversation');
  }
  assertOutgoing(options: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    inReplyTo?: string;
    references?: string | string[];
  }): void {
    const addresses = [options.to, options.cc, options.bcc].flatMap(value =>
      extractEmailsFromAddressField(Array.isArray(value) ? value.join(', ') : value || ''),
    );
    const ids = [
      options.inReplyTo,
      ...(Array.isArray(options.references) ? options.references : [options.references]),
    ].flatMap(value => value?.match(/<[^<>\s]+>/g) || []);
    if (
      !ids.includes(this.config.seed.messageId) ||
      addresses.some(address => address.toLowerCase() !== this.config.account.toLowerCase())
    )
      throw new Error('Draft is outside the own-account test conversation');
  }
}
