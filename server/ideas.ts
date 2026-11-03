// Intake decisions only; downstream Idea workflows own their records and transitions.
import type { IdeaView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';

function text(value: unknown, name: string, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${name} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return trimmed;
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, `${name} must be a list of at most 50 entries`);
  return [...new Set(value.map((v) => text(v, name, 2048, true)))];
}

/** A floor hint is optional context, never a publication target or a dispatch instruction. */
export function queuedIdea(input: unknown, configuredFloors: string[], id: string, at: number, knownIdeas: string[] = []): IdeaView {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'An Idea description is required');
  const body = input as Record<string, unknown>;
  const description = text(body.description, 'Description', 2000, true);
  const constraints = text(body.constraints, 'Constraints', 10000);
  const links = strings(body.links, 'Links');
  for (const link of links) {
    let url: URL;
    try { url = new URL(link); } catch { throw new HttpError(400, 'Links must be full http or https URLs'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Links must be full http or https URLs');
  }
  const floorHints = strings(body.floorHints, 'Floor hints');
  if (floorHints.some((hint) => !configuredFloors.includes(hint))) throw new HttpError(400, 'Floor hints must refer to configured floors');
  const linkedFrom = text(body.linkedFrom, 'Linked Idea', 100);
  if (linkedFrom && !knownIdeas.includes(linkedFrom)) throw new HttpError(400, 'The linked Idea is not in this office');
  return { id, description, constraints, links, floorHints, status: 'queued', createdAt: at, ...(linkedFrom ? { linkedFrom } : {}) };
}
