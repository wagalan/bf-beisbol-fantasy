import site from '../data/site.json';

// While the site is in beta, ask search engines to stay out.
export function GET() {
  const body = site.beta
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${new URL('/sitemap.xml', site.url)}\n`;
  return new Response(body, { headers: { 'content-type': 'text/plain' } });
}
