import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/excalidraw/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] }];
  },
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    config.resolve.fallback = { ...config.resolve.fallback, canvas: false };
    return config;
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
