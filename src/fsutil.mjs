import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** File contents as a Buffer, or null if the file does not exist. */
export async function readBytes(path) {
  try {
    return await readFile(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Parsed JSON, or null if the file does not exist. Malformed JSON throws. */
export async function readJson(path) {
  const bytes = await readBytes(path);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

/**
 * Writes `content` to `path` only when it differs from what is there, via a
 * temporary file in the same directory and a rename, so a reader (or a crash)
 * never sees a half-written file. Returns true when the file changed.
 */
export async function writeIfChanged(path, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const current = await readBytes(path);
  if (current !== null && current.equals(next)) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, next);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return true;
}

/** Pretty JSON with a trailing newline: stable bytes, readable git diffs. */
export function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
