declare module 'lzma' {
  export function decompress(
    data: number[] | Uint8Array,
    callback: (result: number[] | string, error: any) => void,
    progress_callback?: (percent: number) => void,
  ): void;

  export function compress(
    data: string | number[] | Uint8Array,
    mode: number,
    callback: (result: number[], error: any) => void,
    progress_callback?: (percent: number) => void,
  ): void;
}
