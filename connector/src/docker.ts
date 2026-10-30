// The Docker Engine API over its Unix socket: only the calls the connector makes, and only the fields it reads.
import { request } from "node:http";

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  MinAPIVersion?: string;
}

export interface DockerInfo {
  ServerVersion: string;
  OperatingSystem: string;
  KernelVersion: string;
  Architecture: string;
  NCPU: number;
  MemTotal: number;
  SecurityOptions: string[] | null;
  DockerRootDir: string;
}

export interface ImageInfo {
  Id: string;
  RepoDigests: string[] | null;
  Config: { Labels: Record<string, string> | null } | null;
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Created: string;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null; Cmd: string[] | null; Entrypoint: string[] | null };
  HostConfig: Record<string, unknown>;
  State: { Status: string; Running: boolean; Paused: boolean; Restarting: boolean; ExitCode: number; StartedAt: string; FinishedAt: string; Error?: string };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string }[] | null;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Labels: Record<string, string> | null;
}

export interface VolumeInfo {
  Name: string;
  Labels: Record<string, string> | null;
  CreatedAt?: string;
}

export interface Mount {
  Type: "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
}

/** The body of `POST /containers/create`, as far as the connector fills it. */
export interface ContainerSpec {
  Image: string;
  Env?: string[];
  Cmd?: string[];
  Entrypoint?: string[];
  User?: string;
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  StopTimeout?: number;
  WorkingDir?: string;
  HostConfig: {
    Init?: boolean;
    ShmSize?: number;
    PortBindings?: Record<string, { HostIp: string; HostPort: string }[]>;
    Mounts?: Mount[];
    Binds?: string[];
    SecurityOpt?: string[];
    MaskedPaths?: string[];
    ReadonlyPaths?: string[];
    CapDrop?: string[];
    CapAdd?: string[];
    OomScoreAdj?: number;
    RestartPolicy?: { Name: string };
    NetworkMode?: string;
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
    LogConfig?: { Type: string; Config: Record<string, string> };
    AutoRemove?: boolean;
  };
}

export interface Docker {
  version(): Promise<DockerVersion>;
  info(): Promise<DockerInfo>;
  /** Pulls `image` (a digest reference); throws with Docker's own words when it cannot. */
  pull(image: string): Promise<void>;
  imageInspect(image: string): Promise<ImageInfo | null>;
  removeImage(image: string): Promise<void>;
  containerInspect(name: string): Promise<ContainerInfo | null>;
  listContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  /** Every container, running or not, that mounts `volume`. */
  containersUsing(volume: string): Promise<ContainerSummary[]>;
  createContainer(name: string, spec: ContainerSpec): Promise<string>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string, timeoutS: number): Promise<void>;
  unpauseContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
  renameContainer(name: string, to: string): Promise<void>;
  /** Waits for the container to exit and returns its exit code. */
  waitContainer(name: string, timeoutMs: number): Promise<number>;
  logs(name: string, tail: number): Promise<string>;
  volumeInspect(name: string): Promise<VolumeInfo | null>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]>;
}

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

/** Docker 24 speaks API 1.43; newer engines speak it too, up to the newest version the connector knows. */
const MIN_API = [1, 43] as const;
const MAX_API = [1, 47] as const;

function apiParts(value: string | undefined): [number, number] | null {
  const match = /^(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const below = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** The API version to speak with an engine, or null when it is too old or too new for the connector. */
export function negotiateApi(version: Pick<DockerVersion, "ApiVersion" | "MinAPIVersion">): string | null {
  const engine = apiParts(version.ApiVersion);
  if (!engine || below(engine, MIN_API)) return null;
  const chosen = below(engine, MAX_API) ? engine : MAX_API;
  const engineMin = apiParts(version.MinAPIVersion);
  if (engineMin && below(chosen, engineMin)) return null;
  return `${chosen[0]}.${chosen[1]}`;
}

/** Splits an image reference with a digest into what `POST /images/create` takes. */
export function pullParams(image: string): { fromImage: string; tag: string } {
  const at = image.indexOf("@");
  if (at > 0) return { fromImage: image.slice(0, at), tag: image.slice(at + 1) };
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? { fromImage: image.slice(0, colon), tag: image.slice(colon + 1) } : { fromImage: image, tag: "latest" };
}

/** A container's log stream without a TTY is framed: 8 header bytes (stream, 0, 0, 0, big-endian length), then data. */
export function demuxLogs(raw: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Docker answers a pull 200 and reports a failure inside the stream, one JSON object per line. */
export function pullFailure(stream: string): string | null {
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
      if (event.error || event.errorDetail?.message) return event.errorDetail?.message ?? event.error ?? "the pull failed";
    } catch {
      continue;
    }
  }
  return null;
}

export class SocketDocker implements Docker {
  private readonly socketPath: string;
  private api: string | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private call(method: string, path: string, options: { body?: unknown; timeoutMs?: number; versioned?: boolean } = {}): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
      const req = request({
        socketPath: this.socketPath,
        method,
        path: options.versioned === false ? path : `/v${this.api}${path}`,
        headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
        timeout: options.timeoutMs ?? 60_000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`Docker did not answer ${method} ${path} in time`)));
      req.on("error", (error) => reject(error.message.includes("ENOENT") || error.message.includes("EACCES")
        ? new Error(`the Docker socket ${this.socketPath} cannot be reached (${error.message})`) : error));
      req.end(payload);
    });
  }

  private async ready(): Promise<void> {
    if (this.api) return;
    const version = await this.version();
    const api = negotiateApi(version);
    if (!api) throw new DockerError(0, `Docker ${version.Version} (API ${version.ApiVersion}) is not one the connector supports; MausBot needs Docker 24 or newer`);
    this.api = api;
  }

  private async json<T>(method: string, path: string, options: { body?: unknown; timeoutMs?: number; ok?: number[]; missing?: true } = {}): Promise<T | null> {
    await this.ready();
    const response = await this.call(method, path, options);
    if (options.missing && response.status === 404) return null;
    if (!(options.ok ?? [200, 201, 204, 304]).includes(response.status)) {
      let message = response.body.toString("utf8").trim();
      try { message = (JSON.parse(message) as { message?: string }).message ?? message; } catch { /* plain text */ }
      throw new DockerError(response.status, message || `Docker answered ${response.status} to ${method} ${path}`);
    }
    if (!response.body.length) return null;
    try {
      return JSON.parse(response.body.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  async version(): Promise<DockerVersion> {
    const response = await this.call("GET", "/version", { versioned: false, timeoutMs: 15_000 });
    if (response.status !== 200) throw new DockerError(response.status, "Docker did not report its version");
    return JSON.parse(response.body.toString("utf8")) as DockerVersion;
  }

  async info(): Promise<DockerInfo> {
    return (await this.json<DockerInfo>("GET", "/info", { timeoutMs: 30_000 }))!;
  }

  async pull(image: string): Promise<void> {
    await this.ready();
    const { fromImage, tag } = pullParams(image);
    const response = await this.call("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`, { timeoutMs: 30 * 60_000 });
    const text = response.body.toString("utf8");
    if (response.status !== 200) {
      let message = text.trim();
      try { message = (JSON.parse(message) as { message?: string }).message ?? message; } catch { /* plain text */ }
      throw new DockerError(response.status, message);
    }
    const failure = pullFailure(text);
    if (failure) throw new DockerError(500, failure);
  }

  async imageInspect(image: string): Promise<ImageInfo | null> {
    return this.json<ImageInfo>("GET", `/images/${encodeURIComponent(image)}/json`, { missing: true });
  }

  async removeImage(image: string): Promise<void> {
    await this.json("DELETE", `/images/${encodeURIComponent(image)}`, { ok: [200, 404, 409] });
  }

  async containerInspect(name: string): Promise<ContainerInfo | null> {
    return this.json<ContainerInfo>("GET", `/containers/${encodeURIComponent(name)}/json`, { missing: true });
  }

  async listContainers(labels: Record<string, string>): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }));
    return (await this.json<ContainerSummary[]>("GET", `/containers/json?all=1&filters=${filters}`)) ?? [];
  }

  async containersUsing(volume: string): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ volume: [volume] }));
    return (await this.json<ContainerSummary[]>("GET", `/containers/json?all=1&filters=${filters}`)) ?? [];
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    const created = await this.json<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, { body: spec, ok: [201] });
    return created!.Id;
  }

  async startContainer(name: string): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(name)}/start`, { ok: [204, 304], timeoutMs: 120_000 });
  }

  async stopContainer(name: string, timeoutS: number): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(name)}/stop?t=${timeoutS}`, { ok: [204, 304, 404], timeoutMs: (timeoutS + 60) * 1000 });
  }

  async unpauseContainer(name: string): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(name)}/unpause`, { ok: [204, 404, 409] });
  }

  async removeContainer(name: string): Promise<void> {
    await this.json("DELETE", `/containers/${encodeURIComponent(name)}?force=1`, { ok: [204, 404], timeoutMs: 120_000 });
  }

  async renameContainer(name: string, to: string): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(to)}`, { ok: [204] });
  }

  async waitContainer(name: string, timeoutMs: number): Promise<number> {
    const result = await this.json<{ StatusCode: number }>("POST", `/containers/${encodeURIComponent(name)}/wait`, { ok: [200], timeoutMs });
    return result?.StatusCode ?? -1;
  }

  async logs(name: string, tail: number): Promise<string> {
    await this.ready();
    const response = await this.call("GET", `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=${tail}`);
    return response.status === 200 ? demuxLogs(response.body) : "";
  }

  async volumeInspect(name: string): Promise<VolumeInfo | null> {
    return this.json<VolumeInfo>("GET", `/volumes/${encodeURIComponent(name)}`, { missing: true });
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.json("POST", "/volumes/create", { body: { Name: name, Labels: labels }, ok: [200, 201] });
  }

  async removeVolume(name: string): Promise<void> {
    await this.json("DELETE", `/volumes/${encodeURIComponent(name)}`, { ok: [204, 404], timeoutMs: 120_000 });
  }

  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }));
    return (await this.json<{ Volumes: VolumeInfo[] | null }>("GET", `/volumes?filters=${filters}`))?.Volumes ?? [];
  }
}
