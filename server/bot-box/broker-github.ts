// The broker's github grant: a bot's git reaches github.com over HTTPS with the person's GitHub sign-in, and never
// holds the token. The box's git config sends https://github.com/ (and the SSH forms) to
// http://127.0.0.1:<broker>/g/github/ with the broker token in a header (server/github/git-env.ts); the broker checks the
// token like any grant's,
// takes only git's smart-HTTP paths, drops whatever credential the client sent, asks for the token of the conversation's
// audience on each request (so a sign-out or a renewed token counts at once) and adds it as GitHub's Basic credential for
// the fixed upstream. Bodies stream both ways. A receive-pack request is held only until its command list is read
// (git-push-guard.ts): a push that deletes a ref, moves a tag or updates the default branch never reaches GitHub, nor
// a push to a repository the conversation has not cloned or fetched (`mayPush`), and git shows the bot why. GitHub's
// 401 tells the sign-in its token is refused (server/github/token.ts). Reads are not narrowed: the grant reaches every
// repository the person's token can.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import type { BrokerGrant, BrokerServeRequest } from "./broker.ts";
import { forwardableHeaders, relayableHeaders } from "./broker.ts";
import { CommandListReader, advertisedDefaultBranch, type CommandList, refusalBody, refusalMessage, refusedCommands } from "./git-push-guard.ts";

export const GITHUB_GRANT = "github";
export const GITHUB_UPSTREAM = "https://github.com";
/** A token asked for this long ago is asked for again: a git clone or push is a few requests in a row. */
export const GITHUB_TOKEN_REUSE_MS = 60_000;
/** A repository's default branch is read again after this long. */
export const DEFAULT_BRANCH_REUSE_MS = 10 * 60_000;
/** Reading it gives up after this long, and the push is refused (git can push again). */
export const DEFAULT_BRANCH_TIMEOUT_MS = 15_000;
const ADVERTISEMENT_MAX = 64 * 1024;
const MAX_REPOS = 200;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

export interface GithubGrantDeps {
  /** Whose sign-in this grant uses, asked on each request: null gives no credential. */
  audience(): string | null;
  token(audience: string | null): Promise<string | null>;
  reportAuthFailure(audience: string | null): void;
  now?(): number;
  /** Whether this conversation may push to `repo` (owner/name, lower case): one it has a clone of, or fetched through
   * this broker. None lets every push through to the guard. */
  mayPush?(repo: string): Promise<boolean>;
  /** The conversation read `repo`'s refs through this broker (a clone or a fetch). */
  fetched?(repo: string): void;
  /** Test seam, in code only: another upstream than github.com. */
  upstream?: string;
  /** Test seam: DEFAULT_BRANCH_TIMEOUT_MS. */
  defaultBranchTimeoutMs?: number;
}

/** The smart-HTTP request this path and query are, or null: `/<owner>/<repo>[.git]/info/refs?service=git-…-pack` on
 * GET, `/<owner>/<repo>[.git]/git-…-pack` on POST, and nothing else (no `%`, no `..`, no other GitHub page). */
export function gitRequest(method: string, path: string, query: string): { repo: string; service: string; advertisement: boolean } | null {
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== "") return null;
  const [, owner = "", repo = "", ...rest] = parts;
  const name = repo.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || !name || name === "." || name === "..") return null;
  const key = `${owner}/${name}`.toLowerCase();
  const tail = rest.join("/");
  if (tail === "info/refs" && method === "GET") {
    const service = /^\?service=(git-upload-pack|git-receive-pack)$/.exec(query)?.[1];
    return service ? { repo: key, service, advertisement: true } : null;
  }
  if (SERVICES.has(tail) && method === "POST" && query === "") return { repo: key, service: tail, advertisement: false };
  return null;
}

/** A Location GitHub answered (a renamed repository), pointed back through the broker when it is on the upstream. */
export function brokeredLocation(location: string, upstream: string, prefix: string): string {
  for (const base of new Set([upstream.replace(/\/+$/, ""), GITHUB_UPSTREAM])) {
    if (location.startsWith(`${base}/`)) return `${prefix}${location.slice(base.length)}`;
  }
  return location;
}

const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;

export function githubGrant(deps: GithubGrantDeps): BrokerGrant {
  const upstream = new URL(deps.upstream ?? GITHUB_UPSTREAM);
  const now = deps.now ?? Date.now;
  let held: { audience: string | null; token: string | null; at: number } | null = null;
  /** A token GitHub answered 401 to: not sent again while the sign-in still gives it, so public repositories (a
   * package's git dependency) keep working without a credential until the person signs in again. */
  let refusedToken: string | null = null;
  const defaults = new Map<string, { branch: string | null; at: number }>();

  const credential = async (): Promise<{ audience: string | null; token: string | null }> => {
    const audience = deps.audience();
    if (held && held.audience === audience && now() - held.at < GITHUB_TOKEN_REUSE_MS) return held;
    const given = audience === null ? null : await deps.token(audience).catch(() => null);
    held = { audience, token: given !== null && given === refusedToken ? null : given, at: now() };
    return held;
  };

  /** GitHub refused the token: tell the sign-in, and send no credential while it gives the same one. */
  const tokenRefused = (audience: string | null, token: string) => {
    deps.reportAuthFailure(audience);
    refusedToken = token;
    if (held?.token === token) held = { ...held, token: null };
  };

  const send = (input: BrokerServeRequest, method: string, path: string, headers: Record<string, string | string[]>, answer: (res: IncomingMessage) => void) => {
    const fn = input.request ?? (upstream.protocol === "https:" ? httpsRequest : httpRequest);
    return fn({ protocol: upstream.protocol, host: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80), method, path, headers: { ...headers, host: upstream.host } }, answer);
  };

  /** The repository's default branch, from its upload-pack ref list (v0, whose first ref line names HEAD's target):
   * null for a list that names none (an empty repository), or why it could not be read. */
  const defaultBranch = (input: BrokerServeRequest, repoPath: string, repo: string, token: string | null): Promise<{ branch: string | null } | { failed: string }> => {
    const known = defaults.get(repo);
    if (known && now() - known.at < DEFAULT_BRANCH_REUSE_MS) return Promise.resolve({ branch: known.branch });
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome: { branch: string | null } | { failed: string }) => {
        if (done) return;
        done = true;
        if ("branch" in outcome) {
          defaults.delete(repo);
          defaults.set(repo, { branch: outcome.branch, at: now() });
          if (defaults.size > MAX_REPOS) defaults.delete(defaults.keys().next().value!);
        }
        resolve(outcome);
        asked.destroy();
      };
      const asked = send(input, "GET", `${repoPath}/info/refs?service=git-upload-pack`, { "user-agent": "git/2.0 (openmausbot-broker)", ...(token ? { authorization: basic(token) } : {}) }, (answer) => {
        if (answer.statusCode !== 200) { answer.resume(); return finish({ failed: `GitHub answered ${answer.statusCode}` }); }
        let body = Buffer.alloc(0);
        answer.on("data", (chunk: Buffer) => {
          body = Buffer.concat([body, chunk]);
          const found = advertisedDefaultBranch(body);
          if (found !== "more") finish({ branch: found });
          else if (body.length > ADVERTISEMENT_MAX) finish({ failed: "its ref list could not be read" });
        });
        answer.on("end", () => finish({ branch: null }));
        answer.on("error", () => finish({ failed: "the connection failed" }));
      });
      asked.setTimeout(deps.defaultBranchTimeoutMs ?? DEFAULT_BRANCH_TIMEOUT_MS, () => finish({ failed: "GitHub did not answer in time" }));
      asked.on("error", () => finish({ failed: "GitHub could not be reached" }));
      asked.end();
    });
  };

  const relay = (input: BrokerServeRequest, audience: string | null, sentToken: string | null) => (answer: IncomingMessage) => {
    if (answer.statusCode === 401 && sentToken) tokenRefused(audience, sentToken);
    const headers = relayableHeaders(answer.headers);
    if (typeof headers.location === "string") headers.location = brokeredLocation(headers.location, upstream.href, input.prefix);
    input.res.writeHead(answer.statusCode ?? 502, headers);
    answer.pipe(input.res);
  };

  const failed = (res: ServerResponse) => () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("GitHub could not be reached.\n"); else res.destroy(); };

  const refuse = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`${text}\n`);
  };

  /** Answers a push it will not send on, once the client has sent it all (git reads the answer only then). */
  const refusePush = (input: BrokerServeRequest, body: Buffer) => {
    const answer = () => {
      if (input.res.headersSent) return;
      input.res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" }).end(body);
    };
    if (input.req.readableEnded) answer();
    else { input.req.on("end", answer); input.req.resume(); }
  };

  async function serve(input: BrokerServeRequest): Promise<void> {
    const { req, res } = input;
    const method = req.method ?? "GET";
    const git = gitRequest(method, input.path, input.query);
    if (!git) { req.resume(); return refuse(res, 403, "Only git's own requests to a GitHub repository go through here."); }
    const repoPath = `${upstream.pathname.replace(/\/+$/, "")}${input.path.slice(0, input.path.lastIndexOf(git.advertisement ? "/info/refs" : `/${git.service}`))}`;
    const target = `${upstream.pathname.replace(/\/+$/, "")}${input.path}${input.query}`;
    const headers = forwardableHeaders(req.headers);
    // Node's server has already answered a client's 100-continue; GitHub is sent the body at once.
    delete headers.expect;
    if (!(git.service === "git-receive-pack" && !git.advertisement)) {
      req.pause();
      const { audience, token } = await credential();
      // A ref list (a GET, no body) GitHub refused with the token is asked again at once without one.
      const forward = (sent: string | null) => {
        const forwarded = send(input, method, target, { ...headers, ...(sent ? { authorization: basic(sent) } : {}) }, (answer) => {
          if (answer.statusCode === 401 && sent && method === "GET") {
            tokenRefused(audience, sent);
            answer.resume();
            forward(null).end();
            return;
          }
          if (answer.statusCode === 200 && git.advertisement && git.service === "git-upload-pack") deps.fetched?.(git.repo);
          relay(input, audience, sent)(answer);
        });
        forwarded.on("error", failed(res));
        res.on("close", () => forwarded.destroy());
        return forwarded;
      };
      const first = forward(token);
      if (method === "GET") { req.resume(); first.end(); } else req.pipe(first);
      return;
    }
    // A push: the command list first, then the decision, then the bytes held and the rest streamed on.
    const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      return refusePush(input, refusalBody({ capabilities: [], refused: [], message: "This push was sent compressed, which is not taken here; push again with git's defaults." }));
    }
    const held: Buffer[] = [];
    let heldBytes = 0;
    const reader = new CommandListReader();
    const list = await new Promise<Exclude<CommandList, { state: "more" }>>((resolve) => {
      const check = (chunk: Buffer, ended: boolean) => {
        const read = reader.feed(chunk, ended);
        if (read.state === "more") return false;
        req.off("data", onData);
        req.off("end", onEnd);
        req.pause();
        resolve(read);
        return true;
      };
      const onData = (chunk: Buffer) => { held.push(chunk); heldBytes += chunk.length; check(chunk, false); };
      const onEnd = () => { check(Buffer.alloc(0), true); };
      req.on("data", onData);
      req.on("end", onEnd);
    });
    if (list.state === "bad") return refusePush(input, refusalBody({ capabilities: [], refused: [], message: `This push was refused: ${list.reason}.` }));
    const { audience, token } = await credential();
    const notHere = (reason: string, message: string) => refusePush(input, refusalBody({ capabilities: list.capabilities, refused: list.commands.map((command) => ({ ref: command.ref, reason })), message }));
    if (list.commands.length && deps.mayPush && !(await deps.mayPush(git.repo).catch(() => false))) {
      return notHere("not a repository this conversation works in", `This push was refused: ${git.repo} is not a repository this conversation has cloned or fetched. Push from a clone of it made here, to a new branch.`);
    }
    const touchesBranches = list.commands.some((command) => command.ref.startsWith("refs/heads/") && !/^0+$/.test(command.new));
    const learned = touchesBranches ? await defaultBranch(input, repoPath, git.repo, token) : { branch: null };
    if ("failed" in learned) {
      return notHere("the default branch could not be read; push again", `This push was refused because the repository's default branch could not be read (${learned.failed}). Nothing was applied; push again in a moment.`);
    }
    const branch = learned.branch;
    const refused = refusedCommands(list.commands, branch);
    if (refused.length) return refusePush(input, refusalBody({ capabilities: list.capabilities, refused, message: refusalMessage(refused, branch) }));
    const forwarded = send(input, method, target, { ...headers, ...(token ? { authorization: basic(token) } : {}) }, relay(input, audience, token));
    forwarded.on("error", failed(res));
    res.on("close", () => forwarded.destroy());
    forwarded.write(Buffer.concat(held, heldBytes));
    if (req.readableEnded) forwarded.end();
    else req.pipe(forwarded);
  }

  return {
    upstream: upstream.href.replace(/\/+$/, ""),
    headers: {},
    serve: (input) => { serve(input).catch(() => failed(input.res)()); },
  };
}
