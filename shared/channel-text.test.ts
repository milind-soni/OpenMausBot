import { expect, it } from "vitest";
import { formatChannelText } from "./channel-text.ts";
it("renders ordinary headings, emphasis, lists and links as readable text", () => {
 expect(formatChannelText("## **Ready**\n\nTry *this* and __that__.\n\n- **One**\n- [Docs](https://example.com/a_b?q=**raw**)"))
  .toBe("Ready\n\nTry this and that.\n\n• One\n• Docs (https://example.com/a_b?q=**raw**)");
});
it("preserves inline and fenced literal commands including stars, underscores and indentation", () => {
 expect(formatChannelText("Run `echo **hello** _x_`\n\n```sh\nprintf '**value**'\n  echo a_b\n```"))
  .toBe("Run echo **hello** _x_\n\nprintf '**value**'\n  echo a_b");
});
it("preserves literal bare URLs, punctuation and escaped prose markers", () => {
 expect(formatChannelText("See https://example.com/**raw**/a_b?q=*yes* — cost $5; 2 * 3.\n\n\\*literal\\*"))
  .toBe("See https://example.com/**raw**/a_b?q=*yes* — cost $5; 2 * 3.\n\n*literal*");
});
it("retains URLs for reference links and images while leaving code literals intact", () => {
 expect(formatChannelText("Read [Docs][Guide] and ![Diagram][figure].\n\n[guide]: https://example.com/docs\n[figure]: https://example.com/a_b?q=**raw**\n\n`[Docs][guide]`\n\n```txt\n[guide]: https://example.com/literal\n```"))
  .toBe("Read Docs (https://example.com/docs) and Diagram (https://example.com/a_b?q=**raw**).\n\n[Docs][guide]\n\n[guide]: https://example.com/literal");
});
it("resolves nested reference definitions and retains the first definition", () => {
 expect(formatChannelText("[Docs][]\n\n> [docs]: https://example.com/first\n\n[docs]: https://example.com/second"))
  .toBe("Docs (https://example.com/first)");
});
