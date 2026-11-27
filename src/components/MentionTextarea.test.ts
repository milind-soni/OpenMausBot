import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MentionTextarea } from "./MentionTextarea";

it.each(["auto", "rtl", "ltr"])("shares the %s direction between the native input and its mirror", (dir) => {
  const html = renderToStaticMarkup(createElement(MentionTextarea, {
    inputRef: createRef<HTMLTextAreaElement>(), dir, readOnly: true,
    value: "مرحبا @Atlas\nEnglish @Atlas\nשלום @Atlas",
    peers: [{ name: "Atlas", color: "blue" }],
  }));
  expect(html).toContain(`<div dir="${dir}" aria-hidden="true" class="mention-editor-mirror`);
  expect(html).toContain(`<textarea dir="${dir}"`);
  expect(html.match(/class="mention-highlight"/g)).toHaveLength(3);
});
