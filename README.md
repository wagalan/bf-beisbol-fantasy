# BF Béisbol Fantasy — website

Bilingual (ES/EN) site for the BF Béisbol Fantasy podcast.

- **Site:** Astro, static, "Box score" newspaper design. Spanish at `/`, English at `/en/`.
- **News:** a Cloudflare Worker pulls the RSS feeds in `src/data/feeds.json` on a cron (every feed every 30 min), merges and de-duplicates them, and stores them in KV. Pages read `/api/news`.
- **Episodes:** the same Worker pulls the YouTube channel (public RSS, or the YouTube Data API if `YOUTUBE_API_KEY` is set) into KV. Pages read `/api/videos`.
- **Editing:** Sveltia CMS at `/admin/`. Every save is a Git commit, which redeploys the site.

| Path | What it is |
|---|---|
| `src/data/*.json` | Editable data: site info and hosts, feeds list, fantasy box |
| `src/content/articulos/{es,en}/` | Articles (Markdown), one folder per language |
| `src/views/` | Page layouts, shared by both languages |
| `src/lib/client.js` | Browser code that fills news and episodes |
| `worker/` | Cloudflare Worker: API, cron refresh, feed parsing |
| `public/admin/` | CMS page and config |
| `test/` | Worker tests with real feed structures |

Commands (Node ≥ 22.23.4; `.node-version` says 24):

```bash
npm install
npm test             # worker tests
npm run seed:local   # put fixture news/episodes into the local KV
npm run preview      # build + run the full stack at http://localhost:8787
npm run deploy       # build + deploy with wrangler
```

Full setup, deployment and editor instructions: [`docs/SETUP.md`](docs/SETUP.md).
