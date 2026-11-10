/** A model a server on this machine or network holds, as that server describes it: bytes on disk, parameter count
 * and quantization in its own words, and whether it can call tools or see images when it says. */
export interface LocalModelFacts {
  bytes?: number;
  parameters?: string;
  quantization?: string;
  tools?: boolean;
  vision?: boolean;
}
