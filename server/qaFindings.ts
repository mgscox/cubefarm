// Carry ordinary QA findings forward by ID and render only their changes and current disposition.
import { createHash } from 'node:crypto';

interface FindingDetails {
  title: string;
  details: string;
}

export interface QaFollowUp extends FindingDetails {
  commentId: string;
}

export function parseQaFollowUps(raw: unknown): QaFollowUp[] {
  if (!Array.isArray(raw)) return [];
  const byComment = new Map<string, QaFollowUp>();
  for (const item of raw) {
    if (typeof item?.commentId !== 'string' || !/^[1-9]\d{0,19}$/.test(item.commentId) ||
      typeof item.title !== 'string' || !item.title.trim() || typeof item.details !== 'string' || !item.details.trim()) continue;
    byComment.set(item.commentId, { commentId: item.commentId, title: item.title.trim().slice(0, 180), details: item.details.trim().slice(0, 4000) });
  }
  return [...byComment.values()];
}

interface FindingUpdate {
  id: string;
  status: 'open' | 'resolved';
  evidence: string;
}

export interface QaFinding extends FindingDetails {
  id: string;
  status: FindingUpdate['status'];
  evidence?: string;
}

export type PublishedQaFindings = Record<string, QaFinding['status']>;

export interface QaFindingReport {
  findings: FindingDetails[];
  findingUpdates: FindingUpdate[];
}

export function parseQaFindings(raw: { findings?: unknown; findingUpdates?: unknown }): QaFindingReport | null {
  const { findings = [], findingUpdates = [] } = raw;
  if (!Array.isArray(findings) || !Array.isArray(findingUpdates)) return null;
  if (findings.some((f) => typeof f?.title !== 'string' || !f.title.trim() || typeof f.details !== 'string' || !f.details.trim())) return null;
  if (findingUpdates.some((u) => typeof u?.id !== 'string' || (u.status !== 'open' && u.status !== 'resolved') || typeof u.evidence !== 'string')) return null;
  return { findings, findingUpdates };
}

const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

export function reviewFindings(previous: QaFinding[], reported: FindingDetails[], updates: FindingUpdate[], published: PublishedQaFindings = {}) {
  const findings = previous.map((finding): QaFinding => {
    const matching = updates.filter((update) => update.id === finding.id);
    const open = matching.find((update) => update.status === 'open');
    const update = open ?? (matching.length === 1 ? matching[0] : undefined);
    const evidence = update?.evidence.trim();
    if (!update || (update.status === 'resolved' && !evidence)) return { ...finding };
    return { ...finding, status: update.status, evidence: evidence || (finding.status === update.status ? finding.evidence : undefined) };
  });
  const byTitle = new Map(findings.map((finding) => [titleKey(finding.title), finding]));
  for (const item of reported) {
    const key = titleKey(item.title);
    const known = byTitle.get(key);
    if (known) {
      if (known.status === 'resolved') known.evidence = undefined;
      known.status = 'open';
      if (item.details.trim() !== known.details) known.evidence = item.details.trim();
      continue;
    }
    // A comment can outlive its QA run when a newer revision arrives while it is posting.
    const id = `QA-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
    const finding = { title: item.title.trim(), details: item.details.trim(), id, status: 'open' as const };
    byTitle.set(key, finding);
    findings.push(finding);
  }
  const comment = findings.flatMap((finding, i) => {
    const posted = published[finding.id];
    if (finding.status === 'open' && !posted) return [formatQaFinding(finding)];
    if (finding.status === 'resolved' && posted === 'resolved') return [];
    const status = finding.status === 'resolved' ? 'resolved' : posted === 'resolved' ? 'reopened' : 'still open';
    const note = finding.status === 'resolved' || finding.evidence !== previous[i]?.evidence ? finding.evidence : undefined;
    return [`- **${finding.id}** ${status}${posted ? '' : ` (${finding.title})`}${note ? `. ${note}` : ''}`];
  });
  return { findings, comment, published: { ...published, ...Object.fromEntries(findings.map((finding) => [finding.id, finding.status])) } };
}

export function formatQaFinding(finding: QaFinding) {
  return `- **${finding.id}** ${finding.title}. ${finding.details}${finding.evidence ? ` Latest evidence: ${finding.evidence}` : ''}`;
}
