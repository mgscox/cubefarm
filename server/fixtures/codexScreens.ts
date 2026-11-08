// Screens captured by Linus from Codex v0.166.0 at 100x30 through @xterm/headless (#243), as AgentTerminal.screen()
// reads them: blank rows are a single space, and the highlighted rows keep their padding.

const ROWS = 30;
const pad = (row: string) => row.padEnd(100);

/** Codex's "Hooks need review" startup question with option `selected` highlighted (Down moves it). */
export function codexHookReview(selected: 1 | 2 | 3): string {
  const option = (n: number, text: string) => (n === selected ? pad(`› ${n}. ${text}`) : `  ${n}. ${text}`);
  const rows = [
    ' ',
    '  Hooks need review',
    '  2 hooks are new or changed.',
    '  Hooks can run outside the sandbox after you trust them.',
    ' ',
    ' ',
    option(1, 'Review hooks'),
    option(2, 'Trust all and continue'),
    option(3, "Continue without trusting (hooks won't run)"),
    ' ',
    pad('  enter confirm · esc skip'),
  ];
  return [...rows, ...Array<string>(ROWS - rows.length).fill(' ')].join('\n');
}

/** Codex at its prompt once the question is answered. */
export const CODEX_IDLE = [
  ' ',
  '  >_ OpenAI Codex (v0.166.0)',
  '     ~/desk',
  ...Array<string>(23).fill(' '),
  '› Ask Codex to do anything',
  ' ',
  '  GPT-6.1-Sol default · ~/desk',
  '  ? for shortcuts                                                          ⚠ 1 warning · f2 to view',
].join('\n');
