// The demo's PRD and Issue Plan draft, so planning can be exercised before research produces real PRDs. It spans the
// demo's two floors: independent and dependent work, a Tracking Parent, an exact reuse and a partial overlap.
import type { IssueInfo, PrdForPlanning } from '../shared/types.ts';

export const DEMO_TODO = 'demo-co/pixel-todo';
export const DEMO_WEATHER = 'demo-co/weather-api';

export const demoPrd = (ideaId: string): PrdForPlanning => ({
  ideaId,
  revision: 1,
  requirements: [
    { id: 'R1', text: 'Todos can carry a due date.' },
    { id: 'R2', text: 'The weather API returns the forecast for one city on a given day.' },
    { id: 'R3', text: "Todos due within the forecast window show that day's weather." },
    { id: 'R4', text: "Forecast lookups stay fast and within the upstream provider's quota." },
    { id: 'R5', text: "People who don't want weather can hide it." },
  ],
});

/** The lead's draft; it names the demo issues it overlaps by their seeded titles, so it survives renumbering. */
export function demoPlanDraft(openIssues: (repo: string) => IssueInfo[]) {
  const forecast = openIssues(DEMO_WEATHER).find((i) => i.title === 'Add /forecast endpoint');
  return {
    entries: [
      {
        key: 'due-dates', repo: DEMO_TODO, requirement: 'R1',
        title: 'Todos should support due dates', // already on the tracker: becomes a reference to it
        brief: 'Add an optional due date to todos.', acceptance: ['A todo can be given a due date'],
      },
      {
        key: 'forecast-day', repo: DEMO_WEATHER, requirement: 'R2', ...(forecast && { overlaps: forecast.number }),
        title: 'Forecast a single day on /forecast',
        brief: 'Let callers ask `/forecast` for one day instead of five. Scope: the query parameter, validation and tests. Out of scope: caching.',
        acceptance: [
          'Return a 5-day forecast for a city.', // what the existing issue already asks for
          '`GET /forecast?city=Paris&date=YYYY-MM-DD` returns only that day, covered by a route test',
          'A date outside the next 5 days answers 400 with a message naming the valid window',
        ],
      },
      {
        key: 'forecast-cache', repo: DEMO_WEATHER, requirement: 'R4',
        title: 'Cache forecast lookups for 10 minutes',
        brief: 'Keep repeated forecast lookups off the upstream provider. Scope: an in-memory cache keyed by city and day.',
        acceptance: [
          'A second lookup for the same city and day within 10 minutes makes no upstream call (test with a fake provider)',
          'Cached answers carry an `Age` header',
          'The cache holds at most 500 entries and evicts the oldest first',
        ],
      },
      {
        key: 'weather-badge', repo: DEMO_TODO, requirement: 'R3', parent: 'weather-parent',
        title: 'Show a weather badge on todos due soon',
        brief: 'Todos due in the next 5 days show a small icon and high/low for their due day, from the weather API.',
        acceptance: [
          'A todo due within 5 days shows the icon and high/low for that day',
          'Todos without a due date, or due later, show no badge and make no request',
          'If the API fails, the todo renders normally with no badge and no error dialog',
        ],
      },
      {
        key: 'hide-weather', repo: DEMO_TODO, requirement: 'R5', parent: 'weather-parent',
        title: 'Let people hide weather badges',
        brief: 'A settings toggle that hides weather badges and stops forecast requests.',
        acceptance: ['The toggle persists across reloads in localStorage', 'With badges hidden the app makes no forecast requests'],
      },
    ],
    parents: [{ key: 'weather-parent', repo: DEMO_TODO, title: 'Weather on todos due soon', summary: 'The todo-side work for R3 and R5.' }],
    dependencies: [
      { issue: 'weather-badge', blockedBy: 'forecast-day' },
      { issue: 'weather-badge', blockedBy: 'due-dates' },
      { issue: 'hide-weather', blockedBy: 'weather-badge' },
    ],
  };
}
