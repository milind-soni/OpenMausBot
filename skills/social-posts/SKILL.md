---
name: social-posts
description: "Show how a social post will look on each platform, with show_html: Instagram (with carousels), LinkedIn (with document carousels), X, Threads, Facebook, TikTok, Reels and Shorts. Use whenever you write a social post, whether or not Postiz is connected."
---

# Social post previews

Whenever you write a social post, show it as it will look. Don't ask first, and don't wait for an answer: show the preview and
carry on with the work. It's for social posts only, so skip it for a blog post or an article.

## Fill the template

`posts.html` sits next to this guide, in the folder named by this skill's `root`. Copy it to your working folder and replace
only the JSON in the `posts-data` block at the top. Keep the rest, including the licence notice at the top of the file.

```json
{
  "account": { "name": "Juniper Coffee", "handle": "junipercoffee", "subtitle": "Roasters in Leeds", "avatar": "avatar.png" },
  "posts": [{
    "title": "Autumn launch",
    "when": "Draft",
    "text": "Text for every platform that has none of its own.",
    "media": [{ "src": "photo.jpg", "alt": "A bag of coffee" }],
    "platforms": {
      "instagram": { "text": "Its own caption.", "media": [] },
      "x": {}
    }
  }]
}
```

- `platforms` decides which previews show: `instagram`, `linkedin`, `x`, `threads`, `facebook`, `tiktok`, `reels`, `shorts`. Each can
  have its own `text`, `media` and `when`; anything left out comes from the post. Write each platform's text for that platform.
- A plan of several posts is several entries in `posts`; they stack on one page.
- With no `avatar` the card shows initials. No media and empty text still draw properly.
- `media` items: an image `{ "src", "alt" }`, a video `{ "video", "poster", "duration" }` (seconds), or a slide (below). Add `width` and
  `height` when a file's size can't be read, so its shape can be checked.

## Show it

Pick by what the post has:

| The post has | Do this |
|---|---|
| Only text, or slides you wrote | Send the file's whole text as `html`. At most 256 KB, and the template is about 48 KB. |
| Images on disk | Make a folder: the template as `index.html`, the images beside it, named in `src` (`"src": "photo.jpg"`). Show it with `path`. png, jpg, gif, webp, avif and svg work. The folder holds at most 5 MB and 200 files, and `index.html` at most 256 KB, so shrink big images first. |
| An image on the web | Download it into the folder first. The chat blocks images from other sites, and the card says so. |
| A video on disk | Put it in the folder and name it: `{ "video": "clip.mp4", "poster": "frame.jpg" }`. It plays and seeks in the chat, at any size: mp4 (H.264), webm or mov. It plays from the folder and isn't copied, so keep the file there unchanged. If it is moved, edited or deleted, the card falls back to the poster until you show the page again. Always add a poster. |
| A public link | `publish_page` leaves video out and says so, and the public page shows the poster with a play mark. The chat card keeps playing the video. |

Call `show_html` with `title` and the `path`, or the `html`. To change a preview, call it again with the page's `app_id`.
When the person shares it, `publish_page` publishes the same folder; only do that when they ask.

## Carousels without images

You can make a carousel with no image tool: write the slides. `layout` slides take care of the design, and set the shape with
`"slideShape": "4:5"` (the default) or `"1:1"` on the post.

```json
"brand": { "background": "#2b1d16", "text": "#fbf3e6", "accent": "#e8a15b" },
"media": [
  { "layout": "cover", "kicker": "New on Friday", "title": "Three things to know", "note": "Swipe to read" },
  { "layout": "points", "title": "What's in the bag", "points": ["Plum", "Cocoa", "Smoke"] },
  { "layout": "quote", "quote": "Like the first cold morning.", "by": "Priya, head roaster" },
  { "html": "<p class=\"slide-kicker\">Your own</p><h3 class=\"slide-title\">Any HTML you like</h3>" }
]
```

Write a good carousel like this: one idea per slide, a cover that promises something specific, 5 to 10 slides, about 20 words a
slide, and a last slide that says what to do next. In your own `html` slides size text in `cqw` (a percentage of the slide's width),
so it fits at every size.

These slides show in the preview only. To post them for real, the person needs them as images, or as a PDF for LinkedIn: say so
plainly. This skill can't export them.

## What each platform wants

From each platform's own docs. The cards note these quietly; nothing is ever blocked.

| Platform | Text | Media |
|---|---|---|
| Instagram | 2,200 characters, 30 hashtags, 20 @ tags | Images 4:5 to 1.91:1. Carousel up to 20; every slide crops to the first one's shape |
| LinkedIn | 3,000 characters. LinkedIn's guidance is to stay within 150 to avoid a cut, so put the hook first | A "carousel" is a document (usually a PDF): up to 300 pages, 100 MB |
| X | 280, where emoji and CJK count as 2 and any link as 23 | Up to 4 photos, or 1 video |
| Threads | 500; an emoji counts as its UTF-8 bytes | Carousel 2 to 20. Video up to 5 minutes |
| Facebook | No published limit, so no check | |
| TikTok | Video caption 2,200; photo description 4,000 | Up to 35 photos |
| Reels | As Instagram | 9:16 recommended; 3 seconds to 15 minutes |
| Shorts | | Square or vertical; up to 3 minutes |

When Postiz is connected, its `integrationSchema` is the authority for that channel's rules; follow it where it differs.
The preview is a close likeness, not a pixel match: say so if the person asks.
