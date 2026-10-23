// @ts-check
import { defineConfig } from 'astro/config';
import site from './src/data/site.json' with { type: 'json' };

export default defineConfig({
  site: site.url,
  trailingSlash: 'always',
  build: { format: 'directory' },
  i18n: {
    locales: ['es', 'en'],
    defaultLocale: 'es',
    routing: { prefixDefaultLocale: false },
  },
});
