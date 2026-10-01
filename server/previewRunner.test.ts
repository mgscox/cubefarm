import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewEnv } from './previewRunner.ts';

afterEach(() => vi.unstubAllEnvs());

describe('previewEnv', () => {
  it.each(['npm_config_allow_scripts', 'NPM_CONFIG_ALLOW_SCRIPTS'])('drops inherited %s before preview installs', (key) => {
    vi.stubEnv(key, 'esbuild');
    const env = previewEnv({}, 4479, 'preview-tmp');
    expect(Object.keys(env).some((name) => name.toLowerCase() === 'npm_config_allow_scripts')).toBe(false);
  });

  it('keeps other npm settings and applies the floor environment and reserved port', () => {
    vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org/');
    vi.stubEnv('SWARM_HOME', 'live-office');
    vi.stubEnv('PORT', '4317');
    const env = previewEnv({ OUTPUT: '{tmp}', APP_URL: 'http://localhost:{port}' }, 4479, 'preview-tmp');
    expect(env.npm_config_registry).toBe('https://registry.npmjs.org/');
    expect(env.SWARM_HOME).toBeUndefined();
    expect(env.PORT).toBe('4479');
    expect(env.OUTPUT).toBe('preview-tmp');
    expect(env.APP_URL).toBe('http://localhost:4479');
  });
});
