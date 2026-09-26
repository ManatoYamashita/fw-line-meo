import type { MetadataRoute } from 'next';
import { PUBLIC_SITE_URL } from '../lib/public-site';

export default function robots(): MetadataRoute.Robots {
  return {
    // /s/と/ui-checkはクロール可能に保ち、HTMLのnoindexを読み取れるようにする。
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/health'] },
    sitemap: `${PUBLIC_SITE_URL}sitemap.xml`,
  };
}
