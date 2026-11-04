import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playwrightMcpCli, playwrightMcpCommand } from './browser.ts';

describe('Playwright MCP command', () => {
  it('resolves the CLI beside the installed package, rather than through PATH or the agent worktree', () => {
    const cli = playwrightMcpCli();
    expect(cli).toBe(path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')), 'cli.js'));
    expect(fs.statSync(cli).isFile()).toBe(true);
  });

  it("resolves from a box's own install", () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm browser box '));
    try {
      const pkg = path.join(box, 'node_modules', '@playwright', 'mcp');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/mcp', exports: { './package.json': './package.json' } }));
      fs.writeFileSync(path.join(pkg, 'cli.js'), '');
      expect(fs.realpathSync(playwrightMcpCli(path.join(box, 'dist-server', 'boxOps.js')))).toBe(fs.realpathSync(path.join(pkg, 'cli.js')));
    } finally {
      fs.rmSync(box, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it.each([
    ['win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Cube Farm\\node_modules\\@playwright\\mcp\\cli.js', 'C:\\QA session\\browser'],
    ['posix', '/opt/node bin/node', '/opt/Cube Farm/node_modules/@playwright/mcp/cli.js', '/tmp/QA session/browser'],
  ])('starts Node directly on %s and preserves paths as arguments', (_platform, node, cli, outputDir) => {
    expect(playwrightMcpCommand(outputDir, node, cli)).toEqual({
      command: node,
      args: [cli, '--headless', '--isolated', '--init-script', path.join(import.meta.dirname, 'browser-init.js'), '--output-dir', outputDir],
    });
  });

  it('keeps the SDK browser isolated without adding a CLI session output folder', () => {
    const command = playwrightMcpCommand();
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe(playwrightMcpCli());
    expect(command.args).toContain('--isolated');
    expect(command.args).not.toContain('--output-dir');
  });
});
