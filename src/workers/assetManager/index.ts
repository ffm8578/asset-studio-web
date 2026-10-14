import { AssetType, loadAssetBundle } from '@arkntools/unity-js';

// Known valid UnityFS header flags. Any bit outside this mask is non-standard
// and may cause the parser to fail (e.g. 0x200 used by some games as a custom flag).
const UNITY_KNOWN_FLAGS_MASK = 0x1FF;
const UNITY_FS_SIG = [0x55, 0x6e, 0x69, 0x74, 0x79, 0x46, 0x53, 0x00]; // "UnityFS\0"

/**
 * If the buffer is a UnityFS bundle with unknown flags set, clear those flags
 * so the parser doesn't bail out. Returns the original buffer if no patch needed.
 */
function patchUnityBundleFlags(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 60) return buffer;
  // Check signature
  if (!UNITY_FS_SIG.every((b, i) => bytes[i] === b)) return buffer;
  // Scan past format-version (4 bytes) and two null-terminated version strings
  let off = 8 + 4;
  while (off < bytes.length && bytes[off] !== 0) off++; off++; // min version
  while (off < bytes.length && bytes[off] !== 0) off++; off++; // unity version
  off += 8 + 4 + 4; // bundle size + compressed size + uncompressed size
  // Flags are the next 4 bytes (big-endian)
  const view = new DataView(buffer);
  const flags = view.getUint32(off, false);
  const cleanFlags = flags & UNITY_KNOWN_FLAGS_MASK;
  if (cleanFlags === flags) return buffer; // nothing to patch
  console.log(`[AssetManager] Patching UnityFS flags 0x${flags.toString(16)} -> 0x${cleanFlags.toString(16)}`);
  const patched = buffer.slice(0);
  new DataView(patched).setUint32(off, cleanFlags, false);
  return patched;
}
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
    for (const [i, file] of files.entries()) {
      try {
        onProgress({
          name: file.name,
          progress: (i / files.length) * 100,
          totalAssetNum: infos.length,
        });
        const timeLabel = `[AssetManager] load ${file.name}`;
        console.time(timeLabel);
        const result = await this.loadFile(file, options);
        console.timeEnd(timeLabel);
        console.log(`[AssetManager] ${result.length} assets loaded from ${file.name}`);
        if (result.length) {
          successNum++;
          infos.push(...result);
        }
      } catch (error) {
        errors.push({ name: file.name, error: String(error) });
        console.error(`[AssetManager] failed to load ${file.name}`);
        console.error(error);
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
    const buffer = patchUnityBundleFlags(rawBuffer);
    const md5 = calcMd5(rawBuffer); // use original for cache key

    const fileInfo = { fileId: md5, fileName: file.name };
    const bundle = this.bundleMap.get(md5) || (await loadAssetBundle(buffer, options));
    if (!this.bundleMap.has(md5)) this.bundleMap.set(md5, bundle);

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
