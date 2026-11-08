// Reported Claude Code MCP permission screens, including a wrapped persistent-approval choice.
export const CONSOLE_PERMISSION = `playwright — Get console messages Tool: (MCP)
  level: "error"
Do you want to proceed?
❯ 1. Yes
Esc to cancel · Tab to amend`;

// Poirot's 53-column viewport clipped the Bash command heading above the diagnostic.
export const BASH_EXPANSION_PERMISSION = ` │ grep -E "^✖" $S/fulltest.log | head
 Check both runs

 Contains simple_expansion

 Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for:
     grep -E "^✖" $S/fulltest.log | head
  3. No

 Esc to cancel · Tab to amend · ctrl+e to explain`;

export const NAVIGATE_PERMISSION = `playwright — Navigate to a URL Tool: (MCP)
url: "http://localhost:5468/"

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for playwright — Navigate to a URL commands in
     /a/long/workspace/path…
  3. No

Esc to cancel · Tab to amend`;
