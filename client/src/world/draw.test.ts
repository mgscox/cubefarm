import { describe, expect, it } from 'vitest';
import { fitStatus, noteFooter } from './draw';

// Roughly the whiteboard's 16-17px Fredoka: 8px a character, 18px an emoji.
const measure = (s: string) => Array.from(s).reduce((n, c) => n + (c.codePointAt(0)! > 0x2000 ? 18 : 8), 0);
const CARD = 224; // a sticky note on the whiteboard

describe('fitStatus', () => {
  it('keeps text that fits, then drops the explanation, then cuts it short', () => {
    expect(fitStatus('⚠️ needs you', 200, measure)).toBe('⚠️ needs you');
    expect(fitStatus('⚠️ needs you · the fix was never pushed', 120, measure)).toBe('⚠️ needs you');
    expect(fitStatus('⚠️ needs you · the fix was never pushed', 80, measure)).toBe('⚠️ ne…');
    expect(fitStatus('⚠️ needs you', 5, measure)).toBe('');
  });
});

describe('noteFooter', () => {
  const notes = ['⚠️ needs you · the fix was never pushed', '⚠️ needs you · the conflict was never resolved'];

  for (const note of notes) {
    for (const name of ['Ada', 'Margaret', 'Bartholomew-Featherstonehaugh']) {
      it(`keeps "${note}" beside ${name} and inside the note, clear of the next one`, () => {
        const foot = noteFooter(CARD, name, note, measure, measure);
        const noteLeft = CARD - 12 - measure(foot.note);
        expect(foot.note).not.toBe('');
        expect(foot.nameRight).toBeLessThanOrEqual(noteLeft - 10); // the name and the status don't touch
        expect(noteLeft).toBeGreaterThanOrEqual(0); // nor cross into the note to the left
        expect(foot.nameRight).toBeLessThanOrEqual(CARD); // the name stays on its own note too
      });
    }
  }

  it('shows the whole status when it fits, and uses the whole width with nobody on it', () => {
    expect(noteFooter(CARD, 'Ada', 'waiting for QA', measure, measure).note).toBe('waiting for QA');
    expect(noteFooter(CARD, null, '⚠️ needs you · the fix was never pushed', measure, measure)).toEqual({ name: '', nameRight: 0, note: '⚠️ needs you' });
  });
});
