import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  redirects() {
    return [{ source: '/docs/byo-vps', destination: '/docs/computers/byo-vps', permanent: true }];
  },
};

export default withMDX(config);
