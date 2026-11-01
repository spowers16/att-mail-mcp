import type { MailToolName } from './tool-definitions';

export type OperationMode = 'read-only' | 'draft-only' | 'full';

export function parseOperationMode(value = 'full'): OperationMode {
  if (value === 'read-only' || value === 'draft-only' || value === 'full') return value;
  throw new Error('MAIL_OPERATION_MODE must be read-only, draft-only, or full');
}

export function isToolAllowed(name: MailToolName, mode: OperationMode): boolean {
  if (mode === 'full') return true;
  if (
    [
      'send_email',
      'reply_to_email',
      'continue_email_thread',
      'move_message',
      'delete_message',
      'save_attachment',
    ].includes(name)
  )
    return false;
  return (
    mode === 'draft-only' ||
    !['create_draft', 'create_reply_draft', 'update_draft', 'discard_draft'].includes(name)
  );
}

export function assertOperationAllowed(
  name: MailToolName,
  args: Record<string, unknown>,
  mode: OperationMode,
): void {
  if (!isToolAllowed(name, mode) || (mode !== 'full' && args.markSeen === true)) {
    throw new Error(`Operation ${name} is disabled by MAIL_OPERATION_MODE=${mode}`);
  }
}
