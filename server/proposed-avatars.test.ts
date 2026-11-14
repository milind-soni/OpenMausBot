import { describe, expect, it, vi } from "vitest";
import { pendingCardAvatarUrls, ProposedAvatars } from "./proposed-avatars.ts";

const harness = () => {
  let next = 0;
  const save = vi.fn(async (path: string) => {
    if (path.endsWith(".svg")) throw new Error("not a picture");
    return `/api/attachments/copy-${++next}.png`;
  });
  const remove = vi.fn();
  return { save, remove, avatars: new ProposedAvatars(save, remove) };
};

describe("pictures a bot proposes by file path", () => {
  it("copies a file path and passes a stored URL or a clear through untouched", async () => {
    const { avatars, save } = harness();
    expect(await avatars.inChanges({ avatarUrl: "face.png", color: "blue" })).toEqual({ avatarUrl: "/api/attachments/copy-1.png", color: "blue" });
    expect(await avatars.inChanges({ avatarUrl: "/api/attachments/kept.png" })).toEqual({ avatarUrl: "/api/attachments/kept.png" });
    expect(await avatars.inChanges({ avatarUrl: "" })).toEqual({ avatarUrl: "" });
    expect(await avatars.inChanges({ name: "Scout" })).toEqual({ name: "Scout" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the copies of an applied or pending request", async () => {
    for (const state of ["applied", "pending"]) {
      const { avatars, remove } = harness();
      await avatars.inChanges({ avatarUrl: "face.png" });
      await avatars.submit(() => ({ state }));
      expect(remove).not.toHaveBeenCalled();
    }
  });

  it("removes every copy when the request is refused, returned or thrown", async () => {
    const thrown = harness();
    await thrown.avatars.inPlan({ operations: [{ fields: { avatarUrl: "a.png" } }, { fields: { avatarUrl: "b.png" } }] });
    await expect(thrown.avatars.submit(() => { throw new Error("Nothing would change"); })).rejects.toThrow("Nothing would change");
    expect(thrown.remove.mock.calls).toEqual([["/api/attachments/copy-1.png"], ["/api/attachments/copy-2.png"]]);

    const refused = harness();
    await refused.avatars.inChanges({ avatarUrl: "face.png" });
    await refused.avatars.submit(() => ({ state: "refused" }));
    expect(refused.remove).toHaveBeenCalledWith("/api/attachments/copy-1.png");
  });

  it("removes earlier copies of a plan when a later file cannot be copied", async () => {
    const { avatars, remove } = harness();
    await expect(avatars.inPlan({ operations: [{ fields: { avatarUrl: "a.png" } }, { fields: { avatarUrl: "b.svg" } }] })).rejects.toThrow("not a picture");
    expect(remove).toHaveBeenCalledWith("/api/attachments/copy-1.png");
  });

  it("copies nothing for a plan longer than the setup's own operation cap", async () => {
    const { avatars, save } = harness();
    const plan = { operations: Array.from({ length: 41 }, () => ({ fields: { avatarUrl: "a.png" } })) };
    expect(await avatars.inPlan(plan)).toBe(plan);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("pictures that open cards still need", () => {
  it("lists stored pictures from profile and team-setup cards and skips everything else", () => {
    expect(pendingCardAvatarUrls([
      JSON.stringify({ profileRequest: { changes: { avatarUrl: "/api/attachments/profile.png" } } }),
      JSON.stringify({ teamSetupRequest: { operations: [{ fields: { avatarUrl: "/api/attachments/setup.png" } }, { fields: { name: "x" } }] } }),
      JSON.stringify({ profileRequest: { changes: { avatarUrl: "" } } }),
      JSON.stringify({ question: "mentions /api/attachments/other.png only in text" }),
      "not json /api/attachments/broken.png",
      null,
    ])).toEqual(["/api/attachments/profile.png", "/api/attachments/setup.png"]);
  });
});
