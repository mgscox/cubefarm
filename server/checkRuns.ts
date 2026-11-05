// GitHub Actions run IDs carried by failed checks, including several jobs from the same run.
import type { PullInfo } from '../shared/types.ts';

export function failedRunIds(checks: PullInfo['failedChecks']): number[] {
  const ids = new Set<number>();
  for (const check of checks) {
    if (!check.url) continue;
    try {
      const url = new URL(check.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const match = /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/jobs?\/\d+)?\/?$/.exec(url.pathname);
      const id = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    } catch { /* External checks need not link to a GitHub Actions run. */ }
  }
  return [...ids];
}
