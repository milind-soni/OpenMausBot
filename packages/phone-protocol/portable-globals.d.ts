// The only globals beyond ES2022 this package may use: web-platform APIs that Node 24 and browsers have and a React
// Native app provides (Hermes, or a polyfill the phone app installs). Anything else is a compile error here, which keeps
// the package free of DOM and Node APIs.

interface URLSearchParams {
  get(name: string): string | null;
  has(name: string): boolean;
  toString(): string;
}
declare var URLSearchParams: {
  prototype: URLSearchParams;
  new (init?: string | Record<string, string>): URLSearchParams;
};

interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
}
declare var URL: {
  prototype: URL;
  new (url: string, base?: string | URL): URL;
};

interface TextEncoder {
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};

declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function structuredClone<T>(value: T): T;
