import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export default function sitemap(): MetadataRoute.Sitemap {
  return siteUrl ? source.getPages().map((page) => ({ url: `${siteUrl}${page.url}` })) : [];
}
