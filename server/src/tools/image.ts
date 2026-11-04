import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from './permissions.js';
import { fail, str, type ToolDef } from './types.js';
import { MAX_IMAGE_BYTES, isImagePath, saveImage } from '../attachments.js';

/** A7: look at an image file in the approved folders (vision models only; the tool is hidden otherwise). */
export const read_image: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'read_image',
      description: 'Look at an image file (PNG, JPEG, WebP or GIF) in the approved folders, e.g. a screenshot or mockup. The image is shown to you right after this call.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  async run(args) {
    const p = resolvePath(str(args.path, 'path'), { read: true });
    if (!isImagePath(p)) return fail(`"${path.basename(p)}" is not a PNG, JPEG, WebP or GIF file. Use read_file for text.`);
    const st = fs.statSync(p);
    if (st.size > MAX_IMAGE_BYTES) return fail(`Image is too large (${Math.round(st.size / 1024 / 1024)} MB; limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
    let id: string;
    try {
      id = saveImage(fs.readFileSync(p));
    } catch (e) {
      return fail(`Could not load ${p}: ${(e as Error).message}`);
    }
    return { ok: true, content: `Loaded ${p} (${Math.round(st.size / 1024)} KB). It is attached to the next message.`, images: [id] };
  },
};
