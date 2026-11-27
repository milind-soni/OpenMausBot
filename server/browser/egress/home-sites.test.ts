import { describe, expect, it } from "vitest";

import { opensFromHome } from "./home-sites.ts";

describe("the sites that open through the person's own connection", () => {
  it("are Instagram, YouTube with its videos and its player's check, and Google in every country, subdomains included", () => {
    for (const host of [
      "instagram.com", "www.instagram.com", "i.instagram.com", "instagr.am",
      "www.youtube.com", "m.youtube.com", "accounts.youtube.com", "youtu.be", "www.youtube-nocookie.com",
      "rr3---sn-4g5e6nsz.googlevideo.com", "jnn-pa.googleapis.com",
      "accounts.google.com", "www.google.com", "mail.google.com",
      "www.google.de", "accounts.google.co.in", "www.google.com.br", "google.fr",
    ]) expect(opensFromHome(host), host).toBe(true);
  });

  it("read a name as Chrome sends it: any case, and a trailing dot", () => {
    expect(opensFromHome("WWW.Instagram.COM")).toBe(true);
    expect(opensFromHome("accounts.google.com.")).toBe(true);
    expect(opensFromHome("www.google.co.uk.")).toBe(true);
  });

  it("are nothing else: every other site, Google's static and API hosts, and names that only look like these", () => {
    for (const host of [
      "en.wikipedia.org", "example.com", "api.ipify.org", "www.reddit.com",
      // Static files, pictures and APIs answer a data centre as they answer anyone.
      "fonts.gstatic.com", "www.googleapis.com", "fonts.googleapis.com", "i.ytimg.com", "static.cdninstagram.com", "lh3.googleusercontent.com",
      // Look-alikes.
      "notgoogle.com", "xgoogle.de", "google.com.evil.example", "instagram.com.evil.example", "evil-youtube.com", "googlevideo.com.example",
      "google.example", "google.co.example", "googlecom", "93.184.215.14", "[2a00:1450::1]",
    ]) expect(opensFromHome(host), host).toBe(false);
  });
});
