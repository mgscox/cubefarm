import { expect, it } from 'vitest';
import { projectEnv } from './projectEnv.ts';

it('removes every spelling of the inherited script policy without changing other settings or the source', () => {
  const inherited = {
    npm_config_allow_scripts: 'esbuild',
    CUBEFARM_UPSTASH_BOX_API_KEY: 'fixture',
    cubefarm_upstash_openrouter_api_key: 'fixture',
    NPM_CONFIG_ALLOW_SCRIPTS: 'acorn',
    Npm_Config_Allow_Scripts: 'inferno',
    npm_config_registry: 'https://registry.npmjs.org/',
    NPM_CONFIG_CACHE: 'npm-cache',
    npm_config_proxy: 'http://localhost:8080',
    npm_config_allow_scripts_extra: 'keep',
    PATH: 'bin',
    UNSET: undefined,
  };
  expect(projectEnv(inherited)).toEqual({
    npm_config_registry: inherited.npm_config_registry,
    NPM_CONFIG_CACHE: 'npm-cache',
    npm_config_proxy: 'http://localhost:8080',
    npm_config_allow_scripts_extra: 'keep',
    PATH: 'bin',
    UNSET: undefined,
  });
  expect(inherited.npm_config_allow_scripts).toBe('esbuild');
  expect(inherited.NPM_CONFIG_ALLOW_SCRIPTS).toBe('acorn');
});

it('keeps office gateway credentials out of agent and preview environments', () => {
  expect(projectEnv({ CUBEFARM_TELEGRAM_TOKEN: 'private', cubefarm_telegram_token: 'private',
    CUBEFARM_MCP_TOKEN: 'private', cubefarm_mcp_token: 'private', PATH: 'bin' })).toEqual({ PATH: 'bin' });
});
