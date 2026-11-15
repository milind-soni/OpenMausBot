import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BrandTitle } from '@/components/brand-title';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandTitle />,
      url: '/docs',
      transparentMode: 'none',
    },
    links: [
      { text: 'Website', url: 'https://github.com/alnatourm/obot', external: true },
      { text: 'Changelog', url: '/docs/changelog' },
      { type: 'button', text: 'Download', url: 'https://github.com/alnatourm/Obot/releases/latest', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

