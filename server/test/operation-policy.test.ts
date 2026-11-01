import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOperationAllowed, isToolAllowed, parseOperationMode } from '../src/operation-policy';
import { MAIL_TOOLS } from '../src/tool-definitions';

test('operation modes fail closed on invalid values', () => {
  assert.equal(parseOperationMode(), 'full');
  for (const value of ['', 'readonly', 'FULL', 'disabled'])
    assert.throws(() => parseOperationMode(value));
});

for (const mode of ['read-only', 'draft-only'] as const) {
  test(`${mode} blocks sending, destructive mail actions, local saves, and markSeen`, () => {
    for (const name of [
      'send_email',
      'reply_to_email',
      'continue_email_thread',
      'delete_message',
      'move_message',
      'save_attachment',
    ] as const) {
      assert.equal(isToolAllowed(name, mode), false);
      assert.throws(() => assertOperationAllowed(name, {}, mode), /disabled/);
    }
    assert.throws(() => assertOperationAllowed('get_message', { markSeen: true }, mode));
    assert.throws(() => assertOperationAllowed('get_messages', { markSeen: true }, mode));
    assert.doesNotThrow(() => assertOperationAllowed('get_message', { markSeen: false }, mode));
  });
}

test('only draft-only and full expose draft creation', () => {
  for (const name of ['create_draft', 'create_reply_draft'] as const) {
    assert.equal(isToolAllowed(name, 'read-only'), false);
    assert.equal(isToolAllowed(name, 'draft-only'), true);
  }
  for (const tool of MAIL_TOOLS) assert.equal(isToolAllowed(tool.name, 'full'), true);
});
