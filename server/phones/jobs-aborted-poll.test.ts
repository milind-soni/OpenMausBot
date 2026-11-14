import { afterEach, describe, expect, it, vi } from "vitest";

import { PhoneJobs, type PhoneJobDelivery } from "./jobs.ts";

const instances: PhoneJobs[] = [];
const create = () => { const jobs = new PhoneJobs(); instances.push(jobs); return jobs; };
const options = { active: () => true, timeoutMs: 45_000, offlineText: "offline", online: () => true };
afterEach(() => { for (const jobs of instances.splice(0)) jobs.close(); vi.useRealTimers(); });

describe("already aborted phone polls", () => {
  it("answers null immediately without leaving a long poll behind", async () => {
    vi.useFakeTimers();
    const jobs = create();
    const answered = vi.fn();
    void jobs.poll("phone", AbortSignal.abort()).then(answered);
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toHaveBeenCalledExactlyOnceWith(null);
    expect(jobs.polling("phone")).toBe(false);
  });

  it("does not supersede a healthy poll waiting for the next job", async () => {
    vi.useFakeTimers();
    const jobs = create();
    const received = vi.fn<(job: PhoneJobDelivery | null) => void>();
    const healthy = jobs.poll("phone");
    void healthy.then(received);
    void jobs.poll("phone", AbortSignal.abort());
    await vi.advanceTimersByTimeAsync(0);
    expect(received).not.toHaveBeenCalled();
    expect(jobs.polling("phone")).toBe(true);
    const outcome = jobs.request("phone", "PHONE_LIST_EVENTS", { days: 3 }, options);
    const delivered = await healthy;
    expect(delivered).toMatchObject({ tool: "PHONE_LIST_EVENTS", arguments: { days: 3 } });
    expect(jobs.lease("phone", delivered!.id)).toBe(true);
    jobs.complete("phone", delivered!.id, { ok: true, result: [] });
    await expect(outcome).resolves.toEqual({ ok: true, result: [] });
  });

  it("leaves a queued job for the next live poll", async () => {
    vi.useFakeTimers();
    const jobs = create();
    const outcome = jobs.request("phone", "PHONE_LIST_EVENTS", {}, options);
    const answered = vi.fn();
    void jobs.poll("phone", AbortSignal.abort()).then(answered);
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toHaveBeenCalledExactlyOnceWith(null);
    expect(jobs.busy("phone")).toBe(false);
    const delivered = await jobs.poll("phone");
    expect(delivered?.tool).toBe("PHONE_LIST_EVENTS");
    jobs.complete("phone", delivered!.id, { ok: true, result: [] });
    await expect(outcome).resolves.toEqual({ ok: true, result: [] });
  });

  it("still releases a live poll when its signal later aborts", async () => {
    const jobs = create();
    const controller = new AbortController();
    const poll = jobs.poll("phone", controller.signal);
    expect(jobs.polling("phone")).toBe(true);
    controller.abort();
    await expect(poll).resolves.toBeNull();
    expect(jobs.polling("phone")).toBe(false);
  });
});
