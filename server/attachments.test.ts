import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_LIMIT, IMAGE_ROUTE, ImageStore } from './attachments.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const homes: string[] = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-images-'));
  homes.push(dir);
  return new ImageStore(dir);
};
afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('clipboard images', () => {
  it('persists deduplicated images across restarts, independent of repository worktrees', () => {
    const office = store();
    const name = office.save(png);
    expect(office.save(png)).toBe(name);
    expect(fs.readdirSync(homes[0])).toEqual([name]);
    expect(new ImageStore(homes[0]).read(name)).toEqual(png);
    expect(office.mime(name)).toBe('image/png');
  });

  it('copies only referenced images to a different machine and gives it its own paths', () => {
    const office = store();
    const box = store();
    const name = office.save(png);
    const url = `http://localhost:1234${IMAGE_ROUTE}/${name}`;
    const prompt = `Compare [this image](${url}) with ${url}.`;
    const payload = office.collect(prompt);
    expect(payload).toHaveLength(1);
    expect(() => box.prompt(prompt)).toThrow('unavailable');
    box.receive(JSON.parse(JSON.stringify(payload)));
    const prepared = box.prompt(prompt);
    expect(prepared).toContain(url);
    expect(prepared).toContain(JSON.stringify(box.file(name)));
    expect(prepared).not.toContain(office.file(name));
    expect(box.read(name)).toEqual(png);
    expect(box.prompt('ordinary text https://example.com/photo.png')).toBe('ordinary text https://example.com/photo.png');
  });

  it('rejects oversized, unsupported and corrupt transferred images, and traversal', () => {
    const office = store();
    const box = store();
    expect(() => office.save(Buffer.alloc(0))).toThrow('8 MB');
    expect(() => office.save(Buffer.alloc(IMAGE_LIMIT + 1))).toThrow('8 MB');
    expect(() => office.save(Buffer.from('<svg onload="alert(1)"/>'))).toThrow('PNG');
    const name = office.save(png);
    const corrupt = Buffer.concat([png, Buffer.from('changed')]).toString('base64');
    expect(() => box.receive([{ name, data: corrupt }])).toThrow('does not match');
    expect(() => box.file('../state.json')).toThrow('not found');
    expect(() => box.receive([{ name: '../state.json', data: png.toString('base64') }])).toThrow('not found');
    expect(fs.readdirSync(homes[1])).toEqual([]);
  });
});
