// A local stdio transport for BoxLink; losing this connection leaves the remote terminal keeper running.
import { Box } from '@upstash/box';
import { UPSTASH_ROOT as ROOT } from './upstash.ts';

async function main() {
  process.stdin.pause();
  const box = await Box.get(process.argv[2], { apiKey: process.env.UPSTASH_BOX_API_KEY, enableTelemetry: false });
  const session = await box.exec.session({
    argv: ['node', `${ROOT}/node_modules/cubefarm/dist-server/boxStdio.js`, '--stdio', '--office', process.argv[3]],
    env: [`SWARM_BOX_HOME=${ROOT}/home`, `PATH=${ROOT}/node_modules/.bin:${ROOT}/gh/bin:/usr/local/bin:/usr/bin:/bin`],
    onStdout: (b) => process.stdout.write(b),
    onStderr: () => undefined,
  });
  process.stdin.on('data', (b: Buffer) => session.write(b));
  process.stdin.on('end', () => session.endStdin());
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { session.close(); process.exit(0); });
  process.stdin.resume();
  process.exitCode = await session.wait();
  session.close();
}
void main().catch(() => { process.stderr.write('Upstash transport failed.\n'); process.exitCode = 1; });
