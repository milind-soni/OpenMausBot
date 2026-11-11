import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(body: string, signature: string, secret: string) {
  return Buffer.byteLength(body) <= 1000000 && /^sha256=[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature.slice(7), "hex"), createHmac("sha256", secret).update(body).digest());
}
export function parseGitHubEvent(body: string, kind: string, deliveryId: string) {
  if (!/^[\w-]{1,200}$/.test(deliveryId)) throw new Error("Delivery ID required");
  const payload = JSON.parse(body);
  const repo = payload.repository?.full_name;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid repository");
  const item = kind === "check_run" ? payload.check_run : payload.check_suite;
  const numbers: unknown[] = kind === "issues" ? [payload.issue?.number] : kind === "pull_request" || kind === "pull_request_review" ? [payload.pull_request?.number] : item?.pull_requests?.map((pr: { number?: unknown }) => pr.number) ?? [];
  if (numbers.length > 100 || numbers.some(n => !Number.isSafeInteger(n) || Number(n) < 1) || (["issues", "pull_request", "pull_request_review"].includes(kind) && !numbers.length)) throw new Error("Invalid issue or PR number");
  const headSha = ["check_run", "check_suite"].includes(kind) ? item?.head_sha : undefined;
  if (["check_run", "check_suite"].includes(kind) && (typeof headSha !== "string" || !/^[a-f0-9]{40,64}$/i.test(headSha))) throw new Error("Invalid head SHA");
  return { repoUrl: `https://github.com/${repo}`, numbers: numbers as number[], headSha: headSha as string | undefined, deliveryId, fingerprint: createHash("sha256").update(`${kind}\n${body}`).digest("hex") };
}
