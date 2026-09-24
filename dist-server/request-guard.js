const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function isLoopbackHostname(hostname) {
    return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}
function hostnameOf(hostHeader) {
    try {
        return new URL(`http://${hostHeader}`).hostname;
    }
    catch {
        return null;
    }
}
/** Returns a rejection reason, or null when the request may proceed. */
export function rejectUntrustedRequest(headers, options = {}) {
    const host = headers.host;
    if (!host)
        return "missing Host header";
    const hostname = hostnameOf(host);
    if (!hostname)
        return "invalid Host header";
    if (!options.allowAnyHost && !isLoopbackHostname(hostname))
        return `untrusted Host: ${host}`;
    const fetchSite = headers["sec-fetch-site"];
    if (fetchSite === "cross-site" || fetchSite === "same-site")
        return "cross-origin request refused";
    const origin = headers.origin;
    if (origin !== undefined) {
        let originHost = null;
        try {
            originHost = new URL(origin).host;
        }
        catch {
            /* "null" and other opaque origins */
        }
        if (originHost !== host.toLowerCase())
            return "cross-origin request refused";
    }
    return null;
}
/** A body-carrying request must declare JSON. */
export function isJsonContentType(headers) {
    const type = headers["content-type"];
    return typeof type === "string" && /^application\/json\s*(;|$)/i.test(type);
}
