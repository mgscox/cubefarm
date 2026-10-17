// Canonical IDs preserve phone order when durable manager acceptance and a CEO reply finish concurrently.
import type { PhoneMessage } from './types.ts';

export function appendPhoneMessage(messages: PhoneMessage[], message: PhoneMessage): PhoneMessage[] {
  return [...messages.filter((m) => m.id !== message.id), message].sort((a, b) => a.id - b.id).slice(-200);
}
