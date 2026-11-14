// Which site a host belongs to: its registrable domain, for telling a page's
// own requests from third parties. Not the whole Public Suffix List: an unknown
// suffix falls back to the last two labels, which over-merges a few hosts and
// never splits one.

/** Public suffixes with more than one label, where the registrable domain is
 * one label more. */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.my",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "co.id", "or.id", "web.id", "co.th", "in.th", "com.ph", "com.vn", "com.pk",
  "com.br", "net.br", "org.br", "com.mx", "org.mx", "com.ar", "com.co", "com.pe", "com.uy", "com.tr", "com.ua", "com.pl", "co.za", "org.za", "co.il", "org.il", "com.eg", "com.ng", "co.ke",
]);

/** Hosting platforms where every subdomain is a different site: one app on
 * vercel.app is not another's first party. */
const PLATFORM_SUFFIXES = new Set([
  "vercel.app", "netlify.app", "pages.dev", "workers.dev", "github.io", "gitlab.io", "herokuapp.com", "onrender.com", "fly.dev",
  "railway.app", "up.railway.app", "web.app", "firebaseapp.com", "azurewebsites.net", "azurestaticapps.net", "cloudfront.net",
  "amplifyapp.com", "framer.website", "framer.app", "framer.ai", "webflow.io", "wixsite.com", "carrd.co", "notion.site", "super.site",
  "replit.app", "repl.co", "glitch.me", "surge.sh", "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "lovable.app",
  "bolt.host", "deno.dev", "val.run", "appspot.com", "blogspot.com", "wordpress.com", "substack.com", "myshopify.com", "squarespace.com",
  "typedream.app", "softr.app", "bubbleapps.io", "glide.page", "durable.co", "hostinger.site", "web.val.run", "pages.github.com",
]);

function isIpAddress(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
}

/** The site a host belongs to: its registrable domain ("app.acme.co.uk" →
 * "acme.co.uk", "shop.vercel.app" stays itself), or the whole host for an IP
 * address or a single label such as localhost. */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  if (isIpAddress(host) || !host.includes(".")) return host;
  const labels = host.split(".");
  for (let take = 4; take >= 2; take--) {
    if (labels.length <= take) continue;
    const suffix = labels.slice(-take).join(".");
    if (PLATFORM_SUFFIXES.has(suffix)) return labels.slice(-(take + 1)).join(".");
  }
  const lastTwo = labels.slice(-2).join(".");
  if (PLATFORM_SUFFIXES.has(lastTwo)) return host;
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}
