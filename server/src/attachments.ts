// A7: image attachments. Pasted/dropped images and images read by read_image are stored content-addressed under
// <DATA_DIR>/attachments/<sha256>.<ext>; messages refer to them by id. Vision-capable models get the image; others
// get a short placeholder. Only the most recent images are sent (older ones become "[image: …]" text).
// Pattern from DeepSeek Harness attachment-local (content-addressed store) + compaction-image-offload, reimplemented.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const ATTACH_DIR = () => path.join(DATA_DIR, 'attachments');
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** How many of the latest image-bearing messages still carry their images; older ones become text placeholders. */
export const KEEP_IMAGES = 3;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const EXT_OF: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const ID_RE = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

export function isAttachmentId(id: string): boolean {
  return ID_RE.test(id);
}

export function isImagePath(p: string): boolean {
  return !!MIME[path.extname(p).slice(1).toLowerCase()];
}

/** Sniff the real type from the first bytes (the browser's mime type or a file extension can lie). */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

/** Store an image and return its id. Throws on anything that isn't a PNG/JPEG/WebP/GIF or is too big. */
export function saveImage(buf: Buffer): string {
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const mime = sniffMime(buf);
  if (!mime) throw new Error('Not a PNG, JPEG, WebP or GIF image.');
  const id = `${createHash('sha256').update(buf).digest('hex')}.${EXT_OF[mime]}`;
  fs.mkdirSync(ATTACH_DIR(), { recursive: true });
  const p = path.join(ATTACH_DIR(), id);
  if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
  return id;
}

export function attachmentPath(id: string): string | null {
  if (!isAttachmentId(id)) return null;
  const p = path.join(ATTACH_DIR(), id);
  return fs.existsSync(p) ? p : null;
}

export function attachmentDataUrl(id: string): string | null {
  const p = attachmentPath(id);
  if (!p) return null;
  return `data:${MIME[path.extname(p).slice(1)]};base64,${fs.readFileSync(p).toString('base64')}`;
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * Wire content for a user message: an array with image parts when `send` is true and the images exist, otherwise
 * the text with a placeholder per image (never silently drops the fact that an image was there).
 */
export function userWireContent(text: string, images: string[] | undefined, send: boolean, vision: boolean): string | Part[] {
  if (!images?.length) return text;
  if (!send || !vision) {
    const why = vision ? 'not re-sent to save context' : "the current model can't view images";
    return `${text}\n\n${images.map((id) => `[image: ${attachmentPath(id) ?? id} — ${why}]`).join('\n')}`;
  }
  const parts: Part[] = [{ type: 'text', text }];
  for (const id of images) {
    const url = attachmentDataUrl(id);
    parts.push(url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: `[image ${id} is missing]` });
  }
  return parts;
}

/** Indices of user messages whose images are still sent (the last KEEP_IMAGES that have any). */
export function imageKeepSet(messages: Array<{ role: string; images?: string[] }>): Set<number> {
  const keep = new Set<number>();
  for (let i = messages.length - 1; i >= 0 && keep.size < KEEP_IMAGES; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.images?.length) keep.add(i);
  }
  return keep;
}
