import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { encode, hostSocket, PTY_PROTOCOL, readMessages, type FromHost } from '../ptyProtocol.ts';

// Test teardown must stop the detached keeper, including its terminal process trees, before deleting its home.
export function stopTestKeeper(home: string): Promise<void> {
  const secret = fs.readFileSync(path.join(home, 'pty.secret'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const sock = net.connect(hostSocket(home));
    const timer = setTimeout(() => sock.destroy(new Error('test keeper did not stop')), 10_000);
    sock.on('connect', () => sock.write(encode({ op: 'hello', secret, version: PTY_PROTOCOL })));
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') reject(err);
    });
    sock.on('close', () => { clearTimeout(timer); resolve(); });
    const running = new Set<string>();
    readMessages<FromHost>(sock, (m) => {
      if (m.op === 'ready') {
        for (const p of m.ptys) if (p.exit === null) running.add(p.id);
        for (const id of running) {
          sock.write(encode({ op: 'attach', id }));
          sock.write(encode({ op: 'kill', id }));
        }
      } else if (m.op === 'exit') running.delete(m.id);
      else return;
      if (!running.size) sock.write(encode({ op: 'shutdown' }));
    });
  });
}
