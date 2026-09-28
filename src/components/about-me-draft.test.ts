import { describe, expect, it, vi } from "vitest";
import { createAboutMeDraft } from "./about-me-draft";

describe("About me draft lifetime", () => {
  it("keeps a failed unmount save for the next mount and retries it", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const draft = createAboutMeDraft("saved", save);
    const unsubscribe = draft.subscribe(vi.fn());
    draft.edit("long unsaved draft");
    unsubscribe();
    await draft.flush();
    const remounted = vi.fn();
    const detach = draft.subscribe(remounted);
    draft.confirm("saved");
    expect(draft.getSnapshot()).toEqual({ value: "long unsaved draft", status: "error" });
    await draft.flush();
    expect(save.mock.calls).toEqual([["long unsaved draft"], ["long unsaved draft"]]);
    expect(draft.getSnapshot().status).toBe("saved");
    expect(remounted).toHaveBeenCalled();
    detach();
  });

  it("serializes a newer remounted edit behind an in-flight unmount save", async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const draft = createAboutMeDraft("saved", save);
    draft.edit("first");
    const saving = draft.flush();
    draft.edit("second");
    expect(draft.flush()).toBe(saving);
    draft.confirm("first");
    expect(draft.getSnapshot().value).toBe("second");
    finish();
    await saving;
    expect(save.mock.calls).toEqual([["first"], ["second"]]);
    expect(draft.getSnapshot()).toEqual({ value: "second", status: "saved" });
  });

  it("retains an intentional clear on failure and accepts confirmed changes after retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(undefined);
    const draft = createAboutMeDraft("old", save);
    draft.edit("");
    await draft.flush();
    draft.confirm("old");
    expect(draft.getSnapshot()).toEqual({ value: "", status: "error" });
    await draft.flush();
    draft.confirm("updated elsewhere");
    expect(draft.getSnapshot().value).toBe("updated elsewhere");
  });
});
