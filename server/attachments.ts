import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.ts';
import { HttpError } from './httpError.ts';

// Clipboard images belong to the office, outside project history. Boxes receive verified copies over SSH.
export const IMAGE_LIMIT = 8 * 1024 * 1024;
export const IMAGE_ROUTE = '/api/attachments/images';
const IMAGE_NAME = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const REFERENCES = /https?:\/\/[^\s<>"'()[\]]+\/api\/attachments\/images\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))\b/g;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;

export interface ImageAttachment { name: string; data: string }

function extension(data: Buffer): keyof typeof MIME {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new HttpError(415, 'Paste a PNG, JPEG, GIF or WebP image.');
}

export class ImageStore {
  constructor(private dir = path.join(HOME_DIR, 'attachments', 'images')) {}

  save(data: Buffer): string {
    if (!data.length || data.length > IMAGE_LIMIT) throw new HttpError(413, 'Images must be between 1 byte and 8 MB.');
    const name = `${crypto.createHash('sha256').update(data).digest('hex')}.${extension(data)}`;
    fs.mkdirSync(this.dir, { recursive: true });
    // Identical content always has the same name; a failed write must never leave a readable partial image.
    const temp = path.join(this.dir, `${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, data, { mode: 0o600 });
      fs.renameSync(temp, this.file(name));
    } finally {
      fs.rmSync(temp, { force: true, maxRetries: 3 });
    }
    return name;
  }

  file(name: string): string {
    if (!IMAGE_NAME.test(name)) throw new HttpError(404, 'Image not found.');
    return path.join(this.dir, name);
  }

  read(name: string): Buffer {
    try { return fs.readFileSync(this.file(name)); }
    catch { throw new HttpError(404, `Attached image ${name} is unavailable in this office.`); }
  }

  mime(name: string): string {
    this.file(name);
    return MIME[name.split('.').at(-1) as keyof typeof MIME];
  }

  collect(text: string): ImageAttachment[] {
    return [...new Set([...text.matchAll(REFERENCES)].map((m) => m[1]))]
      .map((name) => ({ name, data: this.read(name).toString('base64') }));
  }

  receive(images: ImageAttachment[]): void {
    for (const image of images) {
      this.file(image.name);
      const data = Buffer.from(image.data, 'base64');
      const name = `${crypto.createHash('sha256').update(data).digest('hex')}.${extension(data)}`;
      if (name !== image.name) throw new Error('Attached image content does not match its name.');
      this.save(data);
    }
  }

  prompt(text: string): string {
    const names = [...new Set([...text.matchAll(REFERENCES)].map((m) => m[1]))];
    if (!names.length) return text;
    const files = names.map((name) => { this.read(name); return JSON.stringify(this.file(name)); });
    return `${text}\n\nAttached images are saved on this machine. Read these files to see them:\n${files.join('\n')}`;
  }
}

export const images = new ImageStore();
