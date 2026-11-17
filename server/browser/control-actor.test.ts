import { describe, expect, it } from "vitest";
import { ProfileControl } from "./control.ts";
import type { BrowserActor } from "./cdp/transport.ts";
describe("browser operation identity", () => {
    it("carries agent identity through browser-wide work", async () => {
        let actor: BrowserActor | undefined;
        const control = new ProfileControl(() => [], { withActor: async (next, work) => { actor = next; return work(); } });
        await control.agent(null, async () => expect(actor).toEqual({ kind: "agent" }));
    });
    it("carries the acknowledged person identity through human work", async () => {
        let actor: BrowserActor | undefined;
        const tab = { control: { take: async () => undefined, human: async (_owner: string, work: () => Promise<unknown>) => work() } };
        const control = new ProfileControl(() => [], { withActor: async (next, work) => { actor = next; return work(); } });
        await control.take("person-a");
        await control.human("person-a", tab as never, async () => expect(actor).toEqual({ kind: "viewer", viewerId: "person-a" }));
        await expect(control.human("person-b", tab as never, async () => undefined)).rejects.toThrow(/control/i);
    });
});
