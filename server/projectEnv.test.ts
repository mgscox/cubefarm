import { expect, it } from 'vitest';
import { projectEnv } from './projectEnv.ts';

it('removes every spelling of the inherited script policy without changing other settings or the source', () => {
  const inherited = {
    npm_config_allow_scripts: 'esbuild',
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
