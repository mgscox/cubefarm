// Private credentials live outside the checkout and are never copied into office state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const outside = (folder) => { const relative = path.relative(root, folder); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); };

function credentialDir(home, create = false) {
  const resolved = path.resolve(home);
  // Check existing ancestors too, so a symlink cannot redirect a private store into the checkout.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (!outside(resolved) || !outside(fs.realpathSync(ancestor))) throw new Error('Credentials must be outside the repository.');
  const dir = path.join(resolved, 'credentials');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !outside(fs.realpathSync(dir)) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe credential directory');
    if (create) fs.chmodSync(dir, 0o700);
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not access credential directory.'); }
  return dir;
}

export function readOfficeCredential(home, filename, validToken) {
  let fd;
  try {
    const file = path.join(path.resolve(home), 'credentials', filename);
    const stat = fs.lstatSync(file);
    credentialDir(home);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || (process.platform !== 'win32' && (stat.mode & 0o077)) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe credential file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!validToken(value.token)) throw new Error('Invalid credential');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read office credential.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Atomic replacement of a private credential. A null token removes the saved override. */
export function writeOfficeCredential(home, filename, token) {
  const dir = credentialDir(home, token !== null);
  const file = path.join(dir, filename);
  if (token === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const temp = path.join(dir, `${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ token }), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
