export class StreamingResampler {
  constructor(inputRate: number, outputRate: number);
  push(input: Float32Array): Float32Array<ArrayBuffer>;
}
export class Pcm16Framer {
  constructor(frameSamples?: number);
  push(input: Float32Array): ArrayBuffer[];
}
