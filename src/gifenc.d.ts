declare module "gifenc" {
  interface FrameOptions {
    palette?: number[][];
    delay?: number;
    repeat?: number;
  }
  interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): Encoder;
}
