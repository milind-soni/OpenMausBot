import { describe, expect, it } from "vitest";
import { exactRequest, hasMomentWords, inRequest, requestKey } from "./key.ts";

describe("requestKey", () => {
  it("drops case, punctuation and filler words", () => {
    expect(requestKey("Hey, could you please open TextEdit and type hello world now!")).toBe("open textedit and type hello world");
    expect(requestKey("open textedit and type hello world")).toBe("open textedit and type hello world");
  });
  it("drops fillers only as whole words", () => expect(requestKey("Open Justin's notes")).toBe("open justin s notes"));
  it("normalises Unicode", () => expect(requestKey("Ｏｐｅｎ  Notes")).toBe("open notes"));
  it("keeps a sign, a symbol and a stop inside a number apart", () => {
    expect(requestKey("set the offset field to -5")).not.toBe(requestKey("set the offset field to 5"));
    expect(requestKey("open the C++ tab")).not.toBe(requestKey("open the C tab"));
    expect(requestKey("open the C# tab")).not.toBe(requestKey("open the C tab"));
    expect(requestKey("zoom to 3.5.")).not.toBe(requestKey("zoom to 35"));
    expect(requestKey("open e-mail settings")).toBe("open e-mail settings");
  });
  it("still strips sentence punctuation, quotes and dashes", () => {
    expect(requestKey("Open “Notes” — then stop!")).toBe("open notes then stop");
    expect(requestKey("open notes - quickly.")).toBe("open notes");
  });
  it("gives a dropped filler or a changed case the same key", () => {
    expect(requestKey("type call me now")).toBe(requestKey("type call me"));
    expect(requestKey("type HELLO")).toBe(requestKey("type hello"));
  });
});

it("keeps a request word for word apart from spacing and Unicode forms", () => {
  expect(exactRequest("  type\n HELLO  ")).toBe("type HELLO");
  expect(exactRequest("type ＨＥＬＬＯ")).toBe("type HELLO");
  expect(exactRequest("type hello")).not.toBe(exactRequest("type HELLO"));
});

it("finds moment words as whole words", () => {
  expect(hasMomentWords("Send this to Ana")).toBe(true);
  expect(hasMomentWords("put it here")).toBe(true);
  expect(hasMomentWords("Open Thistle notes")).toBe(false);
  expect(hasMomentWords("send #this to Ana")).toBe(true);
});

it.each(["latest", "newest", "oldest", "last", "first", "top", "next", "previous", "recent", "today", "tonight", "tomorrow", "yesterday", "current", "unread"])(
  "counts %s as a moment word",
  (word) => {
    expect(hasMomentWords(`open the ${word} email from Bob`)).toBe(true);
    expect(hasMomentWords(`open the ${word.toUpperCase()}-ish email`)).toBe(true);
  },
);

it("matches typed text word for word, ignoring case", () => {
  expect(inRequest("Hello World", "type hello world please")).toBe(true);
  expect(inRequest("hello", "type helloworld")).toBe(false);
  expect(inRequest("a.b", "type a.b now")).toBe(true);
  expect(inRequest("hello world", "type hello, world")).toBe(false);
  expect(inRequest("  ", "anything")).toBe(false);
});
