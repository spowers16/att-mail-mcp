import type { EmailMessage, IMAPClient } from './imap-client';
import type { MessageRef } from './message-ref';
import {
  HEADER_FIELDS,
  headerCriteria,
  mailboxKey,
  messageIds,
  type MailTestScope,
} from './mail-scope';

export interface ConversationArgs extends MessageRef {
  uidValidity: number;
  expectedMessageId?: string;
  mailboxes?: string[];
  includeBody?: boolean;
  limit?: number;
}
interface Dependencies {
  imap: IMAPClient;
  scope?: MailTestScope;
  mailboxes: () => Promise<string[]>;
  maxCandidates: number;
  maxHeaderBytes: number;
  formatMessage: (message: EmailMessage, budget: { used: number; limit: number }) => EmailMessage;
  maxResponseCharacters: number;
}
const key = (message: EmailMessage) =>
  `${mailboxKey(message.sourceMailbox)}\0${message.uidValidity}\0${message.uid}`;

export class ConversationService {
  constructor(private readonly dependencies: Dependencies) {}
  async get(args: ConversationArgs): Promise<Record<string, unknown>> {
    const { imap, scope } = this.dependencies;
    if (scope) await scope.assertRef(imap, args);
    const seedBox = await imap.openBox(args.mailbox, true);
    if (seedBox.uidvalidity !== args.uidValidity)
      throw new Error('Conversation seed UIDVALIDITY changed');
    const headerBudget = { used: 0, limit: this.dependencies.maxHeaderBytes };
    const [seed] = await imap.fetchMessages([args.uid], {
      bodies: [HEADER_FIELDS],
      markSeen: false,
      byteBudget: headerBudget,
    });
    if (!seed?.messageId || !messageIds(seed).includes(seed.messageId))
      throw new Error('Conversation seed requires a valid Message-ID');
    if (args.expectedMessageId && args.expectedMessageId !== seed.messageId)
      throw new Error('Conversation seed Message-ID changed');
    const mailboxes = [
      ...new Map(
        (args.mailboxes || scope?.config.mailboxes || (await this.dependencies.mailboxes())).map(
          name => [mailboxKey(name), name],
        ),
      ).values(),
    ];
    if (!mailboxes.some(name => mailboxKey(name) === mailboxKey(args.mailbox)))
      mailboxes.unshift(args.mailbox);
    if (mailboxes.length > 20 || mailboxes.length === 0)
      throw new Error('Choose up to 20 explicit conversation mailboxes');
    for (const mailbox of mailboxes) scope?.assertMailbox(mailbox);
    const messages = new Map([[key(seed), seed]]);
    const ids = new Set(messageIds(seed));
    const queried = new Set<string>();
    const validities = new Map([[mailboxKey(args.mailbox), args.uidValidity]]);
    const failures = new Map<string, string>();
    let inspected = 1;
    let queries = 0;
    let limited = false;
    outer: while (true) {
      let progressed = false;
      for (const mailbox of mailboxes) {
        if (failures.has(mailbox)) continue;
        const pending = [...ids].filter(id => !queried.has(`${mailboxKey(mailbox)}\0${id}`));
        for (let offset = 0; offset < pending.length; offset += 8) {
          if (++queries > 200 || ids.size > 500) {
            limited = true;
            break outer;
          }
          progressed = true;
          const batch = pending.slice(offset, offset + 8);
          for (const id of batch) queried.add(`${mailboxKey(mailbox)}\0${id}`);
          try {
            const box = await imap.openBox(mailbox, true);
            const previous = validities.get(mailboxKey(mailbox));
            if (previous !== undefined && previous !== box.uidvalidity)
              throw new Error('UIDVALIDITY changed during conversation retrieval');
            validities.set(mailboxKey(mailbox), box.uidvalidity);
            const uids = await imap.search([
              ...headerCriteria(batch),
              ...(scope?.criteria() || []),
            ]);
            const fresh = uids.filter(
              uid => !messages.has(`${mailboxKey(mailbox)}\0${box.uidvalidity}\0${uid}`),
            );
            inspected += fresh.length;
            if (inspected > this.dependencies.maxCandidates) {
              limited = true;
              break outer;
            }
            for (let index = 0; index < fresh.length; index += 50) {
              const requested = fresh.slice(index, index + 50);
              const headers = await imap.fetchMessages(requested, {
                bodies: [HEADER_FIELDS],
                markSeen: false,
                byteBudget: headerBudget,
              });
              if (headers.length !== requested.length)
                failures.set(mailbox, 'Messages disappeared during conversation search');
              for (const message of headers) {
                if (
                  !messageIds(message).some(id => ids.has(id)) ||
                  (scope && !scope.accepts(message))
                )
                  continue;
                messages.set(key(message), message);
                for (const id of messageIds(message)) ids.add(id);
              }
            }
          } catch (error) {
            if (headerBudget.used >= headerBudget.limit) {
              limited = true;
              break outer;
            }
            failures.set(mailbox, error instanceof Error ? error.message : 'Mailbox search failed');
          }
        }
      }
      if (!progressed) break;
    }
    const groups = new Map<string, EmailMessage[]>();
    for (const message of messages.values()) {
      const id = message.messageId || key(message);
      groups.set(id, [...(groups.get(id) || []), message]);
    }
    const ordered = [...groups.values()].sort(
      (left, right) =>
        (Date.parse(left[0].date) || 0) - (Date.parse(right[0].date) || 0) ||
        key(left[0]).localeCompare(key(right[0])),
    );
    const selected = ordered.slice(0, args.limit ?? 100);
    const responseBudget = { used: 0, limit: this.dependencies.maxResponseCharacters };
    const timeline: Record<string, unknown>[] = [];
    let bodiesComplete = true;
    for (const copies of selected) {
      const header = copies[0];
      let message = { ...header };
      delete message.text;
      delete message.html;
      if (args.includeBody !== false) {
        try {
          if (scope)
            await scope.assertRef(imap, {
              mailbox: header.sourceMailbox,
              uid: header.uid,
              uidValidity: header.uidValidity,
            });
          const box = await imap.openBox(header.sourceMailbox, true);
          if (box.uidvalidity !== header.uidValidity)
            throw new Error('UIDVALIDITY changed before conversation body fetch');
          const full = await imap.getMessage(header.uid);
          if (full.messageId !== header.messageId || (scope && !scope.accepts(full)))
            throw new Error('Conversation message identity changed');
          message = this.dependencies.formatMessage(full, responseBudget);
          if (
            (message as EmailMessage & { textTruncated?: boolean; htmlTruncated?: boolean })
              .textTruncated ||
            (message as EmailMessage & { htmlTruncated?: boolean }).htmlTruncated
          )
            bodiesComplete = false;
        } catch (error) {
          bodiesComplete = false;
          timeline.push({
            ...message,
            bodyError: error instanceof Error ? error.message : 'Body unavailable',
            copies: copies.map(copy => ({
              mailbox: copy.sourceMailbox,
              uid: copy.uid,
              uidValidity: copy.uidValidity,
            })),
          });
          continue;
        }
      }
      timeline.push({
        ...message,
        copies: copies.map(copy => ({
          mailbox: copy.sourceMailbox,
          uid: copy.uid,
          uidValidity: copy.uidValidity,
        })),
      });
    }
    const foundIds = new Set([...messages.values()].map(message => message.messageId));
    const missingMessageIds = [...ids].filter(id => !foundIds.has(id));
    return {
      seed: {
        mailbox: args.mailbox,
        uid: args.uid,
        uidValidity: args.uidValidity,
        messageId: seed.messageId,
      },
      complete:
        !limited &&
        ordered.length === selected.length &&
        failures.size === 0 &&
        missingMessageIds.length === 0 &&
        bodiesComplete,
      completeWithinSearchedMailboxes:
        !limited && ordered.length === selected.length && failures.size === 0 && bodiesComplete,
      mailboxesSearched: mailboxes,
      mailboxErrors: Object.fromEntries(failures),
      missingMessageIds,
      truncated: limited || ordered.length > selected.length,
      totalDiscovered: ordered.length,
      returnedCount: timeline.length,
      messages: timeline,
      note: 'Conversation membership uses Message-ID, In-Reply-To and References, never subject matching. Completeness applies only to the searched mailboxes and available headers.',
    };
  }
}
