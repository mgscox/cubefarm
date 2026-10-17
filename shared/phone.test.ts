import { expect, it } from 'vitest';
import { appendPhoneMessage } from './phone.ts';
import type { PhoneMessage } from './types.ts';

const message = (id: number): PhoneMessage => ({ id, from: 'ceo', text: String(id), at: id });
it('restores canonical order when a reply arrives while manager acceptance is being persisted', () => {
  const replyFirst = [message(1), message(3)];
  const sorted = appendPhoneMessage(replyFirst, { ...message(2), from: 'manager' });
  expect(sorted.map((m) => m.id)).toEqual([1, 2, 3]);
  expect(appendPhoneMessage(sorted, message(3))).toEqual(sorted);
  expect(replyFirst.map((m) => m.id)).toEqual([1, 3]);
});
it('retains the newest 200 canonical identities when an older event arrives late', () => {
  const latest = Array.from({ length: 200 }, (_, i) => message(i + 2));
  expect(appendPhoneMessage(latest, message(1))).toEqual(latest);
});
