import os from 'node:os';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const scratch = process.env.CUBEFARM_JOB_SCRATCH;
const tempRoot = scratch || os.tmpdir();

// Kept apart from vite.config.ts, whose root is client/, so tests in server/, shared/ and scripts/ are found too.
export default defineConfig({
  test: {
    root: '.',
    include: ['{client,server,shared,scripts}/**/*.test.{ts,tsx}'],
    // e2e/ is Playwright's (npm run test:e2e): it needs a browser and a running demo office.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'node',
    // Anything a test imports must never see the live office's state (~/.cubefarm), its config (~/.config/cubefarm) or its ports.
    env: {
      ...(scratch ? { TMPDIR: scratch, TEMP: scratch, TMP: scratch } : {}),
      SWARM_HOME: path.join(tempRoot, `cubefarm-vitest-${process.pid}`),
      XDG_CONFIG_HOME: path.join(tempRoot, `cubefarm-vitest-config-${process.pid}`),
      SWARM_PORT: '0',
    },
  },
});
