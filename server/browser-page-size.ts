// The size of a bot's page on the agent-browser engine: the standard page while nobody watches, and the shape of the
// watching person's panel, at a desktop's width, while someone does.
import { fillPage } from "./browser/viewers/viewport.ts";

export type PageSize = { width: number; height: number };

/** Page size in CSS pixels. agent-browser sizes the Chrome window, and headless full Chrome (Chrome for Testing) takes its
 * emulated UI out of it (page 1280×577, screencast 1280×720); `set viewport` is agent-browser's only page-size control. */
export const BROWSER_VIEWPORT: PageSize = { width: 1280, height: 720 };

export const viewportArgs = (size: PageSize): string[] => ["set", "viewport", String(size.width), String(size.height)];

/** A screenshot of a page larger than the standard one comes as JPEG unless the bot asked for a format: a tall PNG of a
 * busy page can pass the 5 MB that Claude's API (2026) takes for one image. */
const ENLARGED_PICTURE = { format: "jpeg", quality: 80 } as const;

/** agent-browser's live stream sends frames at the page's own size (0.37.0 ignores a size cap), and a frame of a page of
 * noise this large is about 2.8 MB of base64: a larger panel gets this many pixels in its shape, drawn larger. */
export const MAX_PAGE_PIXELS = 1280 * 2560;

/** The page that fills `panel` within MAX_PAGE_PIXELS, still at least a desktop wide. */
export function streamedPage(panel: PageSize): PageSize {
  const page = fillPage(panel);
  const pixels = page.width * page.height;
  if (pixels <= MAX_PAGE_PIXELS) return page;
  const scale = Math.sqrt(MAX_PAGE_PIXELS / pixels);
  return { width: Math.floor(page.width * scale), height: Math.floor(page.height * scale) };
}

const key = (size: PageSize) => `${size.width}x${size.height}`;

export interface PageSizeHost {
  /** Sizes the session's running page; resolves once the engine answered or gave up. */
  apply(session: string, size: PageSize): Promise<unknown>;
  /** Runs `work` in the session's browser lane, after the bot's call running now; null when that call outlasted the wait. */
  lane(session: string, work: () => Promise<void>): Promise<void | null>;
  /** Someone watches the session's browser, and it is not closing. */
  watched(session: string): boolean;
}

/**
 * Each session's page size: the one its watchers' panels want, and the one its browser was last given. A change waits for
 * the bot's call running in the browser's lane, so no action sees the page change under it; while nobody watches, the
 * bot's next call applies it.
 */
export class PageSizes {
  readonly #host: PageSizeHost;
  readonly #sessions = new Map<string, { wanted: PageSize; applied: string | null; applying: Promise<void> | null }>();

  constructor(host: PageSizeHost) {
    this.#host = host;
  }

  #entry(session: string) {
    let entry = this.#sessions.get(session);
    if (!entry) this.#sessions.set(session, entry = { wanted: BROWSER_VIEWPORT, applied: null, applying: null });
    return entry;
  }

  wanted(session: string): PageSize {
    return this.#sessions.get(session)?.wanted ?? BROWSER_VIEWPORT;
  }

  /** The browser may be a new one, sized as Chrome chose: the next call sizes it again. */
  forget(session: string): void {
    const entry = this.#sessions.get(session);
    if (!entry) return;
    if (entry.wanted === BROWSER_VIEWPORT && !entry.applying) this.#sessions.delete(session);
    else entry.applied = null;
  }

  /**
   * The page a watching panel of `panel` CSS pixels needs, or the standard one (null). `fresh` sizes it even when this
   * server sized it so before, for a browser a view just started.
   */
  resize(session: string, panel: PageSize | null, fresh = false): Promise<void> {
    const entry = this.#entry(session);
    entry.wanted = panel ? streamedPage(panel) : BROWSER_VIEWPORT;
    if (fresh) entry.applied = null;
    if (!entry.applying && this.#behind(session, entry)) entry.applying = this.#follow(session, entry);
    return entry.applying ?? Promise.resolve();
  }

  #behind(session: string, entry: { wanted: PageSize; applied: string | null }): boolean {
    return this.#host.watched(session) && entry.applied !== key(entry.wanted);
  }

  /** Applies the newest wanted size until the page has it; a size wanted meanwhile is picked up before this ends. */
  async #follow(session: string, entry: { wanted: PageSize; applied: string | null; applying: Promise<void> | null }): Promise<void> {
    try {
      while (this.#behind(session, entry)) {
        await this.#host.lane(session, async () => {
          const wanted = entry.wanted;
          if (!this.#behind(session, entry)) return;
          await this.#host.apply(session, wanted).catch(() => undefined);
          entry.applied = key(wanted);
        });
      }
    } finally {
      entry.applying = null;
    }
  }

  /** Before a bot's call, in its lane: true when the page had to be sized first. */
  async beforeCall(session: string): Promise<boolean> {
    const entry = this.#entry(session);
    const wanted = entry.wanted;
    if (entry.applied === key(wanted)) return false;
    await this.#host.apply(session, wanted).catch(() => undefined);
    entry.applied = key(wanted);
    return true;
  }

  /** A browser the engine relaunched under a call: sized again at once. */
  async again(session: string): Promise<void> {
    this.forget(session);
    await this.beforeCall(session);
  }

  /** A call's arguments as the engine gets them: a screenshot of an enlarged page is a JPEG unless the bot chose. */
  callArguments(session: string, params: unknown): unknown {
    const call = params as { name?: unknown; arguments?: Record<string, unknown> } | null;
    const size = this.wanted(session);
    if (call?.name !== "agent_browser_screenshot" || size.width * size.height <= BROWSER_VIEWPORT.width * BROWSER_VIEWPORT.height) return params;
    if (call.arguments?.format !== undefined) return params;
    return { ...call, arguments: { ...call.arguments, ...ENLARGED_PICTURE } };
  }
}
