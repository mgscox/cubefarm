import { createRequire } from 'node:module';
import path from 'node:path';

// Resolve on the machine running the session: a box uses its own cubefarm install.
export function playwrightMcpCli(from = import.meta.url): string {
  const pkg = createRequire(from).resolve('@playwright/mcp/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

/** Start the pinned MCP with Node directly, including on Windows (no npm shim or shell). */
export function playwrightMcpCommand(outputDir?: string, node = process.execPath, cli = playwrightMcpCli()) {
  // Prevent pages taking the real mouse with pointer lock in headless Chrome on Windows.
  const args = [cli, '--headless', '--isolated', '--init-script', path.join(import.meta.dirname, 'browser-init.js')];
  if (outputDir) args.push('--output-dir', outputDir);
  return { command: node, args };
}
