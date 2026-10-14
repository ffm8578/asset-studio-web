import { AssetType, BundleEnv, loadAssetBundle } from '@arkntools/unity-js';
import type { AssetFile, AssetFileLoadOptions, AssetObject } from '@arkntools/unity-js';
import { FsaError, FsaErrorCode, FsaPromises } from '@tsuk1ko/fsa-promises';
import { expose } from 'comlink';
import { md5 as calcMd5 } from 'js-md5';
import { ExportGroupMethod } from '@/types/export';
import type { RepoBatchDataHandler, RepoDataHandler } from '@/types/repository';
import { PromisePool } from '@/utils/promisePool';
import { clearCache, createLoader } from './loaders';
import type { AssetExportItem, PreviewInfo } from './loaders';
import { AudioClipLoader } from './loaders/audioClip';
import type { FsbConvertSettings } from './loaders/audioClip';
import { RenameProcessor } from './utils/rename';

export interface AssetInfo {
  key: string;
  fileId: string;
  fileName: string;
  name: string;
  container: string;
  type: string;
  pathId: bigint;
  size: number;
  preview: PreviewInfo;
  canExport: boolean;
  search: string[];
}

export interface FileLoadingError {
  name: string;
  error: string;
}

export type FileLoadingOnProgress = (param: { name: string; progress: number; totalAssetNum: number }) => any;

export type ExportAssetsOnProgress = (param: { progress: number; name: string }) => any;

type ObjectPathGetter = (obj: AssetObject, fileName: string) => string;

const THREAD_NUM = Math.max(navigator.hardwareConcurrency, 1);

// All supported Unity environments to try in order
const ALL_ENVS = [BundleEnv.NONE, BundleEnv.ARKNIGHTS, BundleEnv.ARKNIGHTS_ENDFIELD];

// Known valid UnityFS flags — clear anything outside this mask before parsing
const UNITY_KNOWN_FLAGS_MASK = 0x1ff;
const UNITY_FS_SIG = [0x55, 0x6e, 0x69, 0x74, 0x79, 0x46, 0x53, 0x00]; // "UnityFS\0"

/**
 * Strip unknown/game-specific flags from a UnityFS header so the parser
 * doesn't bail out on bundles with custom flags (e.g. 0x200).
 */
function patchUnityBundleFlags(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 60) return buffer;
  if (!UNITY_FS_SIG.every((b, i) => bytes[i] === b)) return buffer;
  // Walk past: format-version (4) + two null-terminated version strings
  let off = 8 + 4;
  while (off < bytes.length && bytes[off] !== 0) off++;
  off++;
  while (off < bytes.length && bytes[off] !== 0) off++;
  off++;
  // Skip: bundle size (8) + compressed info size (4) + uncompressed info size (4)
  off += 8 + 4 + 4;
  const view = new DataView(buffer);
  const flags = view.getUint32(off, false); // big-endian
  const cleanFlags = flags & UNITY_KNOWN_FLAGS_MASK;
  if (cleanFlags === flags) return buffer; // nothing to patch
  console.log(`[AssetManager] Patching UnityFS flags 0x${flags.toString(16)} → 0x${cleanFlags.toString(16)}`);
  const patched = buffer.slice(0);
  new DataView(patched).setUint32(off, cleanFlags, false);
  return patched;
}

export class AssetManager {
  private bundleMap = new Map<string, AssetFile>();

  static setFsbConvertSettings(settings: FsbConvertSettings) {
    AudioClipLoader.convertSettings = settings;
  }

  clear() {
    this.bundleMap.clear();
    clearCache();
  }

  async loadFiles(files: File[], options: AssetFileLoadOptions, onProgress: FileLoadingOnProgress) {
    const errors: Array<FileLoadingError> = [];
    const infos: AssetInfo[] = [];
    let successNum = 0;

    // Try preferred env first, then fall back to all others automatically
    const envsToTry = [options.env, ...ALL_ENVS.filter(e => e !== options.env)];

    for (const [i, file] of files.entries()) {
      onProgress({
        name: file.name,
        progress: (i / files.length) * 100,
        totalAssetNum: infos.length,
      });

      let fileLoaded = false;
      const envErrors: string[] = [];

      for (const env of envsToTry) {
        try {
          const result = await this.loadFile(file, { ...options, env });
          if (result.length) {
            console.log(`[AssetManager] ${result.length} assets from ${file.name} (env=${env ?? 'none'})`);
            successNum++;
            infos.push(...result);
            fileLoaded = true;
            break;
          }
          envErrors.push(`env=${env ?? 'none'}: 0 assets`);
        } catch (error) {
          const msg = String(error);
          envErrors.push(`env=${env ?? 'none'}: ${msg}`);
          console.warn(`[AssetManager] ${file.name} env=${env ?? 'none'} failed:`, error);
        }
      }

      if (!fileLoaded) {
        const reason = envErrors.join(' | ');
        errors.push({ name: file.name, error: reason || 'No assets found in any environment' });
        console.error(`[AssetManager] All envs failed for ${file.name}:`, reason);
      }
    }
    return { errors, infos, successNum };
  }

  async getPreviewData(fileId: string, pathId: bigint, payload?: any, dataHandler?: RepoDataHandler) {
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return null;
    return await createLoader(obj).getPreviewData(payload, dataHandler);
  }

  async exportAsset(handle: FileSystemDirectoryHandle, fileId: string, pathId: bigint, dataHandler?: RepoDataHandler) {
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return;
    const loader = createLoader(obj);
    if (!loader.canExport()) return;
    const items = await loader.export(dataHandler);
    if (!items?.length) return;

    let success = 0;
    const { errorStat, errorHandler } = this.createWriteFileErrorHandler();
    const fs = new FsaPromises({ root: handle, cacheDirHandle: true });
    const pool = new PromisePool(
      THREAD_NUM,
      async ({ name, blob }: AssetExportItem) => {
        await fs.writeFile(name, blob, { flag: 'wx', ensureDir: true });
        success++;
      },
      errorHandler,
    );
    pool.addTasks(new RenameProcessor().process(items));
    await pool.wait();

    return { success, ...errorStat };
  }

  async exportAssets(
    handle: FileSystemDirectoryHandle,
    params: Array<{ fileId: string; pathId: bigint; fileName: string; hasDataHandler: boolean }>,
    { groupMethod }: { groupMethod: ExportGroupMethod },
    onProgress: ExportAssetsOnProgress,
    dataHandler: RepoBatchDataHandler,
  ) {
    let totalNum = params.length;
    let finishedNum = 0;

    const minusTotalNum = () => {
      totalNum--;
    };

    let success = 0;
    const { errorStat, errorHandler } = this.createWriteFileErrorHandler();
    const fs = new FsaPromises({ root: handle, cacheDirHandle: true });
    const pool = new PromisePool(
      THREAD_NUM,
      async ({ name, blob }: AssetExportItem) => {
        onProgress({ progress: ++finishedNum / totalNum, name });
        await fs.writeFile(name, blob, { flag: 'wx', ensureDir: true });
        success++;
      },
      errorHandler,
    );

    const renameProcessor = new RenameProcessor();
    const objPathGetter = this.createObjPathGetter(groupMethod);

    await Promise.all(
      params.map(async ({ fileId, pathId, fileName, hasDataHandler }, i) => {
        const obj = this.getAssetObj(fileId, pathId);
        if (!obj) return minusTotalNum();
        const loader = createLoader(obj);
        if (!loader.canExport()) return minusTotalNum();
        const items = await loader.export(hasDataHandler ? data => dataHandler(data, i) : undefined);
        if (!items?.length) return minusTotalNum();
        if (items.length > 1) totalNum += items.length - 1;
        pool.addTasks(renameProcessor.process(items, objPathGetter(obj, fileName)));
      }),
    );

    await pool.wait();

    return { success, ...errorStat };
  }

  private getAssetObj(fileId: string, pathId: bigint) {
    return this.bundleMap.get(fileId)?.objectMap.get(pathId);
  }

  private async loadFile(file: File, options?: AssetFileLoadOptions) {
    const rawBuffer = await file.arrayBuffer();
    // Patch any unknown header flags so the parser doesn't reject the bundle
    const buffer = patchUnityBundleFlags(rawBuffer);
    const md5 = calcMd5(rawBuffer); // always use original bytes for cache key

    const fileInfo = { fileId: md5, fileName: file.name };
    const cacheKey = `${md5}_${options?.env ?? ''}`;
    let bundle = this.bundleMap.get(cacheKey);
    if (!bundle) {
      try {
        bundle = await loadAssetBundle(buffer, options);
      } catch (err) {
        const msg = String(err);
        // If the library's LZ4 output buffer is too small, pre-decompress ourselves
        if (msg.includes('too small') || msg.includes('decompressed') || msg.includes('decompress')) {
          console.warn('[AssetManager] Trying bundle flatten fallback due to:', msg);
          const flat = flattenUnityBundle(buffer);
          if (flat) {
            bundle = await loadAssetBundle(flat, options);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      this.bundleMap.set(cacheKey, bundle);
    }
    // Also store under plain md5 so getAssetObj() lookups work
    this.bundleMap.set(md5, bundle);

    return Promise.all(
      bundle.objects
        .filter(obj => obj.type !== AssetType.AssetBundle)
        .map(async (obj): Promise<AssetInfo> => {
          const { name, type, pathId, size } = obj;
          const container = bundle.getContainer(pathId);
          const loader = createLoader(obj);
          return {
            ...fileInfo,
            key: `${fileInfo.fileId}_${pathId}`,
            name,
            container,
            type: AssetType[type] || '',
            pathId,
            size,
            preview: loader.getPreviewInfo(),
            canExport: loader.canExport(),
            search: [name, container, fileInfo.fileName],
          };
        }),
    );
  }

  private createObjPathGetter(groupMethod: ExportGroupMethod): ObjectPathGetter {
    switch (groupMethod) {
      case ExportGroupMethod.NONE:
        return () => '';
      case ExportGroupMethod.CONTAINER_PATH:
        return obj => obj.container;
      case ExportGroupMethod.TYPE_NAME:
        return obj => AssetType[obj.type] || '';
      case ExportGroupMethod.SOURCE_FILE_NAME:
        return (_, fileName) => fileName;
      default:
        return () => '';
    }
  }

  private createWriteFileErrorHandler() {
    const errorHandler = (e: unknown, item: AssetExportItem) => {
      if (e instanceof FsaError && e.code === FsaErrorCode.EEXIST) {
        ret.errorStat.skip++;
        console.warn(`[AssetManager] file ${item.name} already exists, skip`);
        return;
      }
      ret.errorStat.error++;
      console.error(`[AssetManager] failed to export ${item.name}`);
      console.error(e);
    };
    const ret = {
      errorStat: {
        skip: 0,
        error: 0,
      },
      errorHandler,
    };
    return ret;
  }
}

expose({ AssetManager });

// ─── Unity bundle pre-decompressor ───────────────────────────────────────────
// Used when the library's internal LZ4 decompressor can't handle oversized blocks.

function readU32BE(b: Uint8Array, o: number): number {
  return (((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0);
}
function readU16BE(b: Uint8Array, o: number): number {
  return ((b[o] << 8) | b[o+1]) >>> 0;
}
function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff; b[o+1] = (v >>> 16) & 0xff;
  b[o+2] = (v >>> 8) & 0xff; b[o+3] = v & 0xff;
}

/** LZ4 block decompressor with no hardcoded output size cap. */
function lz4Decompress(src: Uint8Array, expected: number): Uint8Array {
  const dst = new Uint8Array(expected + 65536); // extra room for edge cases
  let s = 0, d = 0;
  while (s < src.length) {
    const tok = src[s++];
    let ll = tok >> 4;
    if (ll === 15) { let x: number; do { x = src[s++]; ll += x; } while (x === 255 && s < src.length); }
    const litEnd = Math.min(s + ll, src.length);
    dst.set(src.subarray(s, litEnd), d); d += litEnd - s; s += ll;
    if (s >= src.length) break;
    if (s + 2 > src.length) break;
    const off = src[s] | (src[s+1] << 8); s += 2;
    if (!off) break;
    let ml = (tok & 0xf) + 4;
    if ((tok & 0xf) === 15) { let x: number; do { x = src[s++]; ml += x; } while (x === 255 && s < src.length); }
    let mp = d - off;
    for (let i = 0; i < ml && d < dst.length; i++) dst[d++] = dst[mp++];
  }
  return dst.subarray(0, d);
}

/**
 * Pre-decompress a UnityFS bundle with LZ4/LZ4HC block compression into a
 * flat (uncompressed, compression=0) bundle that the library can always load.
 * Returns null if the bundle is not in a supported format for this path.
 */
function flattenUnityBundle(buffer: ArrayBuffer): ArrayBuffer | null {
  try {
    const bytes = new Uint8Array(buffer);
    const view  = new DataView(buffer);
    if (!UNITY_FS_SIG.every((b, i) => bytes[i] === b)) return null;

    // Parse header
    let hOff = 8 + 4;
    while (bytes[hOff]) hOff++; hOff++; // min version string
    while (bytes[hOff]) hOff++; hOff++; // unity version string
    // bundleSize (8 BE), compInfoSize (4 BE), uncInfoSize (4 BE), flags (4 BE)
    const compInfoSize = view.getUint32(hOff + 8,  false);
    const uncInfoSize  = view.getUint32(hOff + 12, false);
    const flags        = view.getUint32(hOff + 16, false);
    const headerEnd    = hOff + 20;

    const cmpType       = flags & 0x3f;
    const blocksAtEnd   = !!(flags & 0x80);

    if (cmpType !== 2 && cmpType !== 3) return null; // only handle LZ4/LZ4HC

    // Locate and decompress block info
    const biStart = blocksAtEnd
      ? bytes.length - compInfoSize
      : headerEnd;
    const compBI  = bytes.subarray(biStart, biStart + compInfoSize);
    const blockInfo = lz4Decompress(compBI, uncInfoSize);

    // Parse block descriptors (skip 16-byte hash)
    let biOff = 16;
    const numBlocks = readU32BE(blockInfo, biOff); biOff += 4;
    const blocks: Array<{ unc: number; cmp: number; cmpType: number }> = [];
    for (let i = 0; i < numBlocks; i++) {
      const unc = readU32BE(blockInfo, biOff); biOff += 4;
      const cmp = readU32BE(blockInfo, biOff); biOff += 4;
      const bfl = readU16BE(blockInfo, biOff); biOff += 2;
      blocks.push({ unc, cmp, cmpType: bfl & 0x3f });
    }
    // Keep the rest of blockInfo (node list) intact
    const nodeSection = blockInfo.subarray(biOff);

    // Locate data blocks (aligned to 16 bytes from start of file)
    const rawDataStart = blocksAtEnd ? headerEnd : headerEnd + compInfoSize;
    const dataStart    = (rawDataStart + 15) & ~15;

    // Decompress each data block
    const decompChunks: Uint8Array[] = [];
    let dOff = dataStart;
    for (const blk of blocks) {
      const src = bytes.subarray(dOff, dOff + blk.cmp);
      const chunk = (blk.cmpType === 2 || blk.cmpType === 3)
        ? lz4Decompress(src, blk.unc)
        : src; // already uncompressed
      decompChunks.push(chunk);
      dOff += blk.cmp;
    }

    // Build flat block info (compression = 0 for every block)
    const flatBlockInfoBodySize = 4 + numBlocks * 10 + nodeSection.length;
    const flatBI = new Uint8Array(16 + flatBlockInfoBodySize);
    let fbiOff = 16; // leave hash as zeros
    writeU32BE(flatBI, fbiOff, numBlocks); fbiOff += 4;
    for (const [i, chunk] of decompChunks.entries()) {
      writeU32BE(flatBI, fbiOff, chunk.length); fbiOff += 4; // unc = actual size
      writeU32BE(flatBI, fbiOff, chunk.length); fbiOff += 4; // cmp = same (uncompressed)
      flatBI[fbiOff]   = 0; flatBI[fbiOff+1] = 0; fbiOff += 2; // flags = 0 (no compression)
    }
    flatBI.set(nodeSection, fbiOff);

    // Calculate total data size
    const totalData = decompChunks.reduce((n, c) => n + c.length, 0);

    // Build new header: copy original up to flags, patch flags to compression=0
    const newHeaderBytes = bytes.slice(0, headerEnd);
    const newHeaderView  = new DataView(newHeaderBytes.buffer);
    // patch: compInfoSize = flatBI.length, uncInfoSize = flatBI.length, flags = (flags & ~0x3f) | 0
    newHeaderView.setUint32(hOff + 8,  flatBI.length,           false);
    newHeaderView.setUint32(hOff + 12, flatBI.length,           false);
    newHeaderView.setUint32(hOff + 16, flags & UNITY_KNOWN_FLAGS_MASK & ~0x3f, false);

    // Assemble final buffer: header + block info (no alignment needed for uncompressed) + data
    const totalSize  = headerEnd + flatBI.length + totalData;
    const out        = new Uint8Array(totalSize);
    let outOff = 0;
    out.set(newHeaderBytes, outOff); outOff += headerEnd;
    out.set(flatBI,         outOff); outOff += flatBI.length;
    for (const chunk of decompChunks) { out.set(chunk, outOff); outOff += chunk.length; }

    console.log(`[AssetManager] Flattened bundle: ${buffer.byteLength} → ${out.buffer.byteLength} bytes`);
    return out.buffer;
  } catch (e) {
    console.warn('[AssetManager] flattenUnityBundle failed:', e);
    return null;
  }
}
