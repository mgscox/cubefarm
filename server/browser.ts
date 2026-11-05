import { createRequire } from 'node:module';
import path from 'node:path';

// The agents' browser tools are Playwright's own MCP server (`playwright mcp`), from an exact-pinned stable
// `playwright`: every @playwright/mcp release since 0.0.30 wraps that same server but pins a Playwright alpha.

// Resolve on the machine running the session: a box uses its own cubefarm install.
export function playwrightMcpCli(from = import.meta.url): string {
  const pkg = createRequire(from).resolve('playwright/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

/** Start the pinned MCP with Node directly, including on Windows (no npm shim or shell). */
export function playwrightMcpCommand(outputDir?: string, node = process.execPath, cli = playwrightMcpCli()) {
  // Prevent pages taking the real mouse with pointer lock in headless Chrome on Windows.
  const args = [cli, 'mcp', '--headless', '--isolated', '--init-script', path.join(import.meta.dirname, 'browser-init.js')];
  if (outputDir) args.push('--output-dir', outputDir);
  return { command: node, args };
}
