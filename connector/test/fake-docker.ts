// An in-memory Docker Engine for the connector's tests: images, containers, volumes holding files, and the fixed
// helper commands the connector runs (cp, find, du, tar, the box probe) carried out on those files.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContainerInfo, ContainerSpec, ContainerSummary, Docker, DockerInfo, DockerVersion, ImageInfo, VolumeInfo } from "../src/docker.ts";
import { DockerError } from "../src/docker.ts";

export interface FakeContainer {
  id: string;
  name: string;
  spec: ContainerSpec;
  status: "created" | "running" | "exited" | "paused";
  exitCode: number;
  startedAt: number;
  logs: string;
}

export interface FakeVolume {
  labels: Record<string, string>;
  files: Map<string, string>;
}

const VERSION_LABEL = "org.opencontainers.image.version";

export class FakeDocker implements Docker {
  /** What `pull` can fetch: reference → image labels. */
  readonly registry = new Map<string, Record<string, string>>();
  readonly images = new Map<string, Record<string, string>>();
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, FakeVolume>();
  readonly calls: string[] = [];
  /** Commands the helpers ran, in order. */
  readonly helperRuns: string[][] = [];
  readonly startFailures = new Map<string, string>();
  info_: DockerInfo = {
    ServerVersion: "28.0.4", OperatingSystem: "Ubuntu 24.04.3 LTS", KernelVersion: "6.8.0-1021-azure", Architecture: "x86_64", NCPU: 4,
    MemTotal: 16 * 1073741824, SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"], DockerRootDir: "/var/lib/docker",
  };
  /** A copy of /data fails, as on a full disk. */
  failCopy = false;
  /** What the box probe prints and its exit code. */
  probe = { code: 0, output: "" };
  /** Run when a home container starts: lets a test act as the home (write files, crash). */
  onHomeStart: ((container: FakeContainer) => void) | null = null;
  /** Run when a connector container starts: lets a test act as the new connector. */
  onConnectorStart: ((container: FakeContainer) => Promise<void> | void) | null = null;
  now: () => number = () => Date.now();
  private nextId = 1;
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  publish(image: string, version: string | null): void {
    this.registry.set(image, version ? { [VERSION_LABEL]: version } : {});
  }

  volume(name: string): FakeVolume {
    const volume = this.volumes.get(name);
    if (!volume) throw new Error(`no volume ${name}`);
    return volume;
  }

  files(name: string): Record<string, string> {
    return Object.fromEntries([...this.volume(name).files].sort());
  }

  container(name: string): FakeContainer | null {
    return this.containers.get(name) ?? [...this.containers.values()].find((container) => container.id === name) ?? null;
  }

  async version(): Promise<DockerVersion> {
    return { Version: this.info_.ServerVersion, ApiVersion: "1.48", MinAPIVersion: "1.24" };
  }

  async info(): Promise<DockerInfo> {
    return this.info_;
  }

  async pull(image: string): Promise<void> {
    this.calls.push(`pull ${image}`);
    const labels = this.registry.get(image);
    if (!labels) throw new DockerError(404, `manifest for ${image} not found: manifest unknown`);
    this.images.set(image, labels);
  }

  async imageInspect(image: string): Promise<ImageInfo | null> {
    const labels = this.images.get(image);
    return labels ? { Id: `sha256:${image.length}`, RepoDigests: [image], Config: { Labels: labels } } : null;
  }

  async removeImage(image: string): Promise<void> {
    this.calls.push(`rmi ${image}`);
    if ([...this.containers.values()].some((container) => container.spec.Image === image)) return;
    this.images.delete(image);
  }

  async containerInspect(name: string): Promise<ContainerInfo | null> {
    const container = this.container(name);
    if (!container) return null;
    return {
      Id: container.id,
      Name: `/${container.name}`,
      Created: new Date(0).toISOString(),
      Config: { Image: container.spec.Image, Env: container.spec.Env ?? [], Labels: container.spec.Labels ?? {}, Cmd: container.spec.Cmd ?? null, Entrypoint: container.spec.Entrypoint ?? null },
      HostConfig: { ...container.spec.HostConfig } as Record<string, unknown>,
      State: {
        Status: container.status, Running: container.status === "running" || container.status === "paused", Paused: container.status === "paused",
        Restarting: false, ExitCode: container.exitCode, StartedAt: new Date(container.startedAt).toISOString(), FinishedAt: new Date(0).toISOString(),
      },
      Mounts: (container.spec.HostConfig.Mounts ?? []).map((mount) => ({ Type: mount.Type, Name: mount.Source, Source: mount.Source, Destination: mount.Target })),
    };
  }

  async listContainers(labels: Record<string, string>): Promise<ContainerSummary[]> {
    return [...this.containers.values()]
      .filter((container) => Object.entries(labels).every(([key, value]) => container.spec.Labels?.[key] === value))
      .map((container) => ({ Id: container.id, Names: [`/${container.name}`], Image: container.spec.Image, State: container.status, Labels: container.spec.Labels ?? {} }));
  }

  async containersUsing(volume: string): Promise<ContainerSummary[]> {
    return [...this.containers.values()]
      .filter((container) => (container.spec.HostConfig.Mounts ?? []).some((mount) => mount.Source === volume))
      .map((container) => ({ Id: container.id, Names: [`/${container.name}`], Image: container.spec.Image, State: container.status, Labels: container.spec.Labels ?? {} }));
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    this.calls.push(`create ${name} ${spec.Image}`);
    if (this.containers.has(name)) throw new DockerError(409, `Conflict. The container name "/${name}" is already in use`);
    if (!this.images.has(spec.Image)) throw new DockerError(404, `No such image: ${spec.Image}`);
    for (const mount of spec.HostConfig.Mounts ?? []) {
      if (!this.volumes.has(mount.Source)) this.volumes.set(mount.Source, { labels: {}, files: new Map() });
    }
    const id = `c${String(this.nextId++).padStart(11, "0")}`;
    this.containers.set(name, { id, name, spec, status: "created", exitCode: 0, startedAt: 0, logs: "" });
    return id;
  }

  async startContainer(name: string): Promise<void> {
    const container = this.container(name);
    if (!container) throw new DockerError(404, `No such container: ${name}`);
    this.calls.push(`start ${container.name}`);
    const failure = this.startFailures.get(container.name);
    if (failure) throw new DockerError(500, failure);
    if (container.status === "running") return;
    container.status = "running";
    container.startedAt = this.now();
    const role = container.spec.Labels?.["com.mausbot.role"];
    if (role === "helper") this.runHelper(container);
    else if (role === "home") this.onHomeStart?.(container);
    else if (role === "connector") await this.onConnectorStart?.(container);
  }

  async stopContainer(name: string): Promise<void> {
    const container = this.container(name);
    if (!container) return;
    if (container.status === "running" || container.status === "paused") this.calls.push(`stop ${container.name}`);
    if (container.status === "running" || container.status === "paused") container.status = "exited";
  }

  async unpauseContainer(name: string): Promise<void> {
    const container = this.container(name);
    if (container?.status === "paused") container.status = "running";
  }

  async removeContainer(name: string): Promise<void> {
    const container = this.container(name);
    if (!container) return;
    if (container.status === "paused") throw new DockerError(409, "You cannot remove a paused container. Unpause and then stop the container before attempting removal or force remove");
    this.calls.push(`rm ${container.name}`);
    this.containers.delete(container.name);
  }

  async renameContainer(name: string, to: string): Promise<void> {
    const container = this.container(name);
    if (!container) throw new DockerError(404, `No such container: ${name}`);
    if (this.containers.has(to)) throw new DockerError(409, `Conflict. The container name "/${to}" is already in use`);
    this.calls.push(`rename ${container.name} ${to}`);
    this.containers.delete(container.name);
    container.name = to;
    this.containers.set(to, container);
  }

  async waitContainer(name: string): Promise<number> {
    const container = this.container(name);
    if (!container) throw new DockerError(404, `No such container: ${name}`);
    return container.exitCode;
  }

  async logs(name: string): Promise<string> {
    return this.container(name)?.logs ?? "";
  }

  async volumeInspect(name: string): Promise<VolumeInfo | null> {
    const volume = this.volumes.get(name);
    return volume ? { Name: name, Labels: volume.labels } : null;
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.calls.push(`volume create ${name}`);
    if (!this.volumes.has(name)) this.volumes.set(name, { labels, files: new Map() });
  }

  async removeVolume(name: string): Promise<void> {
    if (!this.volumes.has(name)) return;
    if ([...this.containers.values()].some((container) => (container.spec.HostConfig.Mounts ?? []).some((mount) => mount.Source === name))) {
      throw new DockerError(409, `remove ${name}: volume is in use`);
    }
    this.calls.push(`volume rm ${name}`);
    this.volumes.delete(name);
  }

  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    return [...this.volumes]
      .filter(([, volume]) => Object.entries(labels).every(([key, value]) => volume.labels[key] === value))
      .map(([name, volume]) => ({ Name: name, Labels: volume.labels }));
  }

  /** The connector's helpers run fixed commands; these are carried out on the volumes' files. */
  private runHelper(container: FakeContainer): void {
    const command = [...(container.spec.Entrypoint ?? []), ...(container.spec.Cmd ?? [])];
    this.helperRuns.push(command);
    const mounted = (target: string) => {
      const mount = (container.spec.HostConfig.Mounts ?? []).find((entry) => entry.Target === target);
      if (!mount) throw new Error(`helper has nothing mounted at ${target}`);
      return { volume: this.volume(mount.Source), readOnly: Boolean(mount.ReadOnly) };
    };
    const writable = (target: string) => {
      const found = mounted(target);
      if (found.readOnly) throw new Error(`helper writes to read-only ${target}`);
      return found.volume;
    };
    const finish = (code: number, logs = "") => {
      container.status = "exited";
      container.exitCode = code;
      container.logs = logs;
    };
    const line = command.join(" ");
    if (line === "cp -a /from/. /to/") {
      if (this.failCopy) return finish(1, "cp: error writing '/to/big.bin': No space left on device");
      const from = mounted("/from").volume;
      const to = writable("/to");
      for (const [path, content] of from.files) to.files.set(path, content);
      return finish(0);
    }
    if (line === "find /to -mindepth 1 -delete") {
      writable("/to").files.clear();
      return finish(0);
    }
    if (command[0] === "find" && command[1] === "/data" && command.includes("-delete")) {
      const data = writable("/data");
      const patterns = command.flatMap((arg, index) => (arg === "-path" ? [command[index + 1]] : []));
      const matches = (path: string) => patterns.some((pattern) => {
        const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        return regex.test(`/data/${path}`);
      });
      const deleted = [...data.files.keys()].filter(matches);
      for (const path of deleted) data.files.delete(path);
      return finish(0, deleted.map((path) => `/data/${path}`).join("\n"));
    }
    if (line === "du -sk /data") {
      const bytes = [...mounted("/data").volume.files.values()].reduce((sum, content) => sum + content.length, 0);
      return finish(0, `${Math.ceil(bytes / 1024)}\t/data\n`);
    }
    if (command[0] === "tar" && command.includes("-czf")) {
      const archive = command[command.indexOf("-czf") + 1];
      if (!mounted("/state").readOnly) writeFileSync(join(this.stateDir, archive.replace("/state/", "")), JSON.stringify([...mounted("/data").volume.files]));
      return finish(0);
    }
    if (command[0] === "tar" && command.includes("-xzpf")) {
      const archive = command[command.indexOf("-xzpf") + 1];
      let entries: [string, string][];
      try {
        entries = JSON.parse(readFileSync(join(this.stateDir, archive.replace("/state/", "")), "utf8")) as [string, string][];
      } catch {
        return finish(2, "tar: This does not look like a tar archive");
      }
      const data = writable("/data");
      for (const [path, content] of entries) data.files.set(path, content);
      return finish(0);
    }
    if (command[0] === "bwrap") return finish(this.probe.code, this.probe.output);
    return finish(127, `unknown helper command: ${line}`);
  }
}
