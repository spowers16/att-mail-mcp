import nodemailer, { type SendMailOptions } from 'nodemailer';

import { type EmailOptions } from './smtp-client';

export function createMailOptions(options: EmailOptions, defaultFrom?: string): SendMailOptions {
  return {
    from: options.from || defaultFrom,
    replyTo: options.replyTo,
    to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
    cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : undefined,
    bcc: options.bcc
      ? Array.isArray(options.bcc)
        ? options.bcc.join(', ')
        : options.bcc
      : undefined,
    subject: options.subject,
    text: options.text,
    html: options.html,
    messageId: options.messageId,
    inReplyTo: options.inReplyTo,
    references: options.references,
    attachments: options.attachments,
  };
}

/** Compose MIME in memory. This transport never opens an SMTP connection. */
export async function buildRawMessage(
  options: EmailOptions,
  defaultFrom?: string,
  messageId?: string,
): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  } as any);
  try {
    // Stream transport preserves Bcc so recipients remain editable in drafts.
    const result = (await transport.sendMail({
      ...createMailOptions(options, defaultFrom),
      messageId: messageId || options.messageId,
    })) as any;
    if (!Buffer.isBuffer(result.message)) {
      throw new Error('Nodemailer did not return a buffered raw message');
    }
    return result.message;
  } finally {
    transport.close();
  }
}
