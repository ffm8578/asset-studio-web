// ─── Magic detection ──────────────────────────────────────────────────────────

const isZip  = (b: Uint8Array) => b[0]===0x50 && b[1]===0x4b && b[2]===0x03 && b[3]===0x04;
const isGzip = (b: Uint8Array) => b[0]===0x1f && b[1]===0x8b;
const isLz4  = (b: Uint8Array) => b[0]===0x04 && b[1]===0x22 && b[2]===0x4d && b[3]===0x18;
const isXz   = (b: Uint8Array) => b[0]===0xfd && b[1]===0x37 && b[2]===0x7a && b[3]===0x58 && b[4]===0x5a && b[5]===0x00;
// LZMA alone format: first byte = props (usually 0x5d), then 4-byte dict, 8-byte size
const isLzma = (b: Uint8Array) => b[0] === 0x5d && b.length > 13;

// ─── GZIP (native) ───────────────────────────────────────────────────────────

async function decompressGzip(buffer: ArrayBuffer, name: string): Promise<File> {
  const ds = new DecompressionStream('gzip');
  const out = await new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer();
  return new File([out], name.endsWith('.gz') ? name.slice(0, -3) : name);
}

// ─── ZIP (native DecompressionStream for deflate-raw) ────────────────────────

async function extractZip(buffer: ArrayBuffer): Promise<File[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const files: File[] = [];
  let pos = 0;
  while (pos + 30 < buffer.byteLength) {
    if (view.getUint32(pos, true) !== 0x04034b50) break;
    const flags       = view.getUint16(pos + 6,  true);
    const compression = view.getUint16(pos + 8,  true);
    const compSize    = view.getUint32(pos + 18, true);
    const nameLen     = view.getUint16(pos + 26, true);
    const extraLen    = view.getUint16(pos + 28, true);
    const filename    = new TextDecoder().decode(bytes.slice(pos + 30, pos + 30 + nameLen));
    const dataPos     = pos + 30 + nameLen + extraLen;
    const compData    = buffer.slice(dataPos, dataPos + compSize);
    if (!filename.endsWith('/')) {
      try {
        let data: ArrayBuffer;
        if (compression === 0) {
          data = compData;
        } else if (compression === 8) {
          data = await new Response(new Blob([compData]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        } else {
          console.warn(`[compress] ZIP: unsupported method ${compression} for ${filename}`);
          pos = dataPos + compSize;
          if (flags & 0x08) pos += view.getUint32(pos, true) === 0x08074b50 ? 16 : 12;
          continue;
        }
        files.push(new File([data], filename.split('/').pop() || filename));
      } catch (e) {
        console.warn(`[compress] ZIP: failed to extract ${filename}`, e);
      }
    }
    pos = dataPos + compSize;
    if (flags & 0x08) pos += view.getUint32(pos, true) === 0x08074b50 ? 16 : 12;
  }
  return files;
}

// ─── LZ4 Frame (pure JS) ─────────────────────────────────────────────────────

function lz4BlockDecompress(src: Uint8Array, maxSize: number): Uint8Array {
  const dst = new Uint8Array(maxSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const tok = src[s++];
    // literals
    let litLen = tok >> 4;
    if (litLen === 15) { let x: number; do { x = src[s++]; litLen += x; } while (x === 255); }
    dst.set(src.subarray(s, s + litLen), d); s += litLen; d += litLen;
    if (s >= src.length) break;
    // match
    const offset = src[s++] | (src[s++] << 8);
    if (!offset) throw new Error('LZ4: zero offset');
    let matchLen = (tok & 0xf) + 4;
    if (matchLen === 19) { let x: number; do { x = src[s++]; matchLen += x; } while (x === 255); }
    let mp = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[mp++];
  }
  return dst.subarray(0, d);
}

function decompressLz4(buffer: ArrayBuffer, name: string): File {
  const view  = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 4; // skip magic
  const flg = bytes[pos++];
  pos++;       // BD byte
  const hasContentSize    = (flg >> 3) & 1;
  const hasBlockChecksum  = (flg >> 4) & 1;
  const hasContentChecksum = (flg >> 2) & 1;
  if (hasContentSize) pos += 8;
  pos++; // HC
  const chunks: Uint8Array[] = [];
  while (pos + 4 <= buffer.byteLength) {
    const bsRaw = view.getUint32(pos, true); pos += 4;
    if (!bsRaw) break;
    const uncompressed = (bsRaw & 0x80000000) !== 0;
    const bsLen = bsRaw & 0x7fffffff;
    const data = bytes.slice(pos, pos + bsLen); pos += bsLen;
    if (hasBlockChecksum) pos += 4;
    chunks.push(uncompressed ? data : lz4BlockDecompress(data, 1 << 23));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  const outName = name.endsWith('.lz4') ? name.slice(0, -4) : name;
  return new File([out.buffer], outName);
}

// ─── LZMA / XZ (via lzma-js npm package) ─────────────────────────────────────

async function decompressLzma(buffer: ArrayBuffer, name: string): Promise<File> {
  const { decompress } = await import('lzma-js');
  const input = Array.from(new Uint8Array(buffer));
  const out: number[] = await new Promise((res, rej) =>
    decompress(input, (result: number[] | string, err: any) =>
      err ? rej(new Error(String(err))) : res(result as number[]),
    ),
  );
  const outName = name.replace(/\.(lzma|xz)$/, '');
  return new File([new Uint8Array(out)], outName);
}

// ─── Main expand function ─────────────────────────────────────────────────────

async function expandFile(file: File, depth = 0): Promise<File[]> {
  if (depth > 3) return [file];
  const buffer = await file.arrayBuffer();
  const header = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));

  try {
    if (isZip(header)) {
      const extracted = await extractZip(buffer);
      if (!extracted.length) return [file];
      return (await Promise.all(extracted.map(f => expandFile(f, depth + 1)))).flat();
    }
    if (isGzip(header)) {
      return expandFile(await decompressGzip(buffer, file.name), depth + 1);
    }
    if (isLz4(header)) {
      return expandFile(decompressLz4(buffer, file.name), depth + 1);
    }
    if (isLzma(header) || isXz(header)) {
      return expandFile(await decompressLzma(buffer, file.name), depth + 1);
    }
  } catch (e) {
    console.warn(`[compress] Failed to decompress ${file.name}:`, e);
  }

  return [file];
}

/**
 * Recursively expand ZIP, GZIP, LZ4, LZMA, and XZ files into their contents.
 * Non-archive files pass through unchanged.
 */
export async function expandCompressedFiles(files: File[]): Promise<File[]> {
  return (await Promise.all(files.map(f => expandFile(f)))).flat();
}
