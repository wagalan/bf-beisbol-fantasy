# BF Béisbol Fantasy: beta setup guide

This takes the repo from a zip file to a working beta on a `workers.dev`
address, with automatic news, automatic episodes and a CMS your friends can
edit. Search engines stay out while `beta` is on in `src/data/site.json`.

Values you will fill in along the way:

| Placeholder | Meaning | Example |
|---|---|---|
| `GITHUB_OWNER` | GitHub account or org that owns the repo | `wagalan` |
| `KV_ID` | ID of the KV namespace you create in step 4 | `3f2a…` |
| `BETA_URL` | The Worker's address after the first deploy | `https://bf-beisbol-fantasy.<subdomain>.workers.dev` |
| `REFRESH_TOKEN` | A random secret for manual refreshes | from `openssl rand -hex 32` |

> **Ownership:** create the GitHub repo and the Cloudflare account under the
> podcast's own accounts if they have them, and add yourself as a
> collaborator. If they leave the project with you, nothing breaks; if you
> step away, they keep everything.

---

## 0. Before you start: log in

```bash
gh auth login           # GitHub CLI, choose HTTPS or SSH as you prefer
npx wrangler login      # Cloudflare (opens the browser)
```

You will log out of both at the end (step 13).

## 1. Unpack and install

You need Node **22.23.4 or newer** (Astro 7 refuses older ones). On CachyOS:
`sudo pacman -S nodejs npm` gives you a current version. Check with `node -v`.

```bash
mkdir -p ~/repos && cd ~/repos
unzip ~/Downloads/bf-beisbol-fantasy.zip
cd bf-beisbol-fantasy
npm install
```

## 2. Test locally

```bash
npm test               # 10 tests: parsing, de-duplication, stale items, failures
npm run seed:local     # fills the local KV with the test fixtures
npm run preview        # builds and serves at http://localhost:8787
```

Open http://localhost:8787 and http://localhost:8787/en/. With the fixtures
you'll see a few repeated MLB Trade Rumors headlines; that is the test data.

To pull the **real** feeds into your local copy, leave `npm run preview`
running and, in a second terminal:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*&time=$(date -d '00:00' +%s)000"
sleep 10
curl -s http://localhost:8787/api/status | python3 -m json.tool
```

The `time` parameter picks a minute ending in 0, which is the batch that also
refreshes YouTube. Each run refreshes a third of the feeds; run it with
`date -d '00:10'` and `date -d '00:20'` to cover the other two thirds.
Stop the preview with `Ctrl+C`.

## 3. Fill in the placeholders in the code

Edit **`public/admin/config.yml`**, line 5: replace `GITHUB_OWNER` with the
account that will own the repo.

```yaml
  repo: GITHUB_OWNER/bf-beisbol-fantasy
```

Leave `src/data/site.json` → `"url"` as is for now; you'll set it in step 8
once you know `BETA_URL`.

## 4. Create the KV namespace

```bash
npx wrangler kv namespace create BF_KV
```

It prints an `id`. Paste it into **`wrangler.jsonc`**, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`:

```jsonc
{ "binding": "BF_KV", "id": "KV_ID" }
```

## 5. Create the repo and make the first commit

```bash
git init -b main
git config user.name "Your Name"
git config user.email "you@users.noreply.github.com"

git add .gitignore .node-version README.md docs/SETUP.md \
  astro.config.mjs package.json package-lock.json wrangler.jsonc \
  public/admin/config.yml public/admin/index.html \
  public/apple-touch-icon.png public/favicon.png \
  public/img/icon-256.png public/img/logo-blue.png public/img/logo-white.png \
  scripts/seed-local.mjs \
  src/components/ArticleCards.astro src/components/EpisodeList.astro \
  src/components/FantasyBox.astro src/components/Footer.astro \
  src/components/LeadEpisode.astro src/components/NewsList.astro \
  src/content.config.ts \
  src/content/articulos/en/ejemplo-lidom.md src/content/articulos/es/ejemplo-lidom.md \
  src/data/fantasy.json src/data/feeds.json src/data/site.json \
  src/i18n/ui.js src/layouts/Base.astro \
  src/lib/articles.js src/lib/client.js \
  src/pages/404.astro 'src/pages/articulos/[slug].astro' 'src/pages/en/articulos/[slug].astro' \
  src/pages/en/episodios.astro src/pages/en/fantasy.astro src/pages/en/index.astro \
  src/pages/en/lidom.astro src/pages/en/nosotros.astro src/pages/en/noticias.astro \
  src/pages/episodios.astro src/pages/fantasy.astro src/pages/index.astro \
  src/pages/lidom.astro src/pages/nosotros.astro src/pages/noticias.astro \
  src/pages/robots.txt.js src/styles/global.css \
  src/views/Article.astro src/views/Episodios.astro src/views/Fantasy.astro \
  src/views/Home.astro src/views/Lidom.astro src/views/Nosotros.astro \
  src/views/NotFound.astro src/views/Noticias.astro \
  test/fixtures/mlb-en.xml test/fixtures/mlbtr-nyy.xml \
  test/fixtures/nyy-mlb.xml test/fixtures/youtube.xml test/worker.test.mjs \
  worker/index.js worker/parse.js worker/refresh.js

git status        # check: nothing under node_modules/, dist/ or .wrangler/
git commit -m "BF Béisbol Fantasy: beta site, news/YouTube worker, CMS"

gh repo create GITHUB_OWNER/bf-beisbol-fantasy --private --source . --remote origin
git push -u origin main
```

The `[slug]` paths are quoted so the shell doesn't treat the brackets as a
pattern.

## 6. First deploy

```bash
npm run deploy
```

Wrangler prints the address: that is your `BETA_URL`. The cron is created
with the deploy.

Set the refresh secret, then fill KV right away instead of waiting for cron:

```bash
openssl rand -hex 32          # copy the output: that's REFRESH_TOKEN
npx wrangler secret put REFRESH_TOKEN     # paste it when asked

curl -X POST -H "Authorization: Bearer REFRESH_TOKEN" BETA_URL/api/refresh
```

The response lists every feed with `ok: true/false` and the YouTube result.
Open `BETA_URL` and `BETA_URL/en/`: news and the latest episode should be there.

## 7. Connect the repo so every commit redeploys

This is what makes the CMS work: a save in `/admin/` is a commit, and the
commit has to trigger a build.

In the Cloudflare dashboard: **Workers & Pages → bf-beisbol-fantasy →
Settings → Builds → Connect** (labels may shift a little; it's the "Git
repository" / "Builds" section of the Worker). Then:

- Repository: `GITHUB_OWNER/bf-beisbol-fantasy`, branch `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- The build reads `.node-version` (24). If the build log shows an older Node,
  add a build variable `NODE_VERSION` = `24`.

Cloudflare installs its GitHub app on the repo the first time; allow it for
that repo only.

## 8. Test the auto-deploy

```bash
git pull
```

Then edit **`src/data/site.json`**: set `"url"` to your `BETA_URL`. Commit
and push:

```bash
git add src/data/site.json
git commit -m "Set beta URL"
git push
```

Watch the build under the Worker's **Deployments** tab. When it finishes
(1–2 min), the page `<head>` should carry the new URL in its `hreflang`
links.

## 9. Give your friend CMS access

For the beta, editors sign in with a GitHub **fine-grained personal access
token** instead of an OAuth app (no extra Worker to run).

Your friend, on GitHub (his own account, added as a collaborator on the repo
with write access):

1. **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token.**
2. Repository access: **Only select repositories** → `bf-beisbol-fantasy`.
3. Permissions: **Contents: Read and write**. Nothing else.
4. Expiration: 90 days is a reasonable beta window.

Then open `BETA_URL/admin/` → **Sign In Using Access Token** → paste it.
The browser remembers it.

Test: in **Ajustes del sitio → Box fantasy de la semana**, change a player,
**Save**. A commit appears on GitHub, a build starts, and the home page shows
the change in about two minutes.

> Anyone who edits locally as well as through the CMS must `git pull` before
> starting, because the CMS commits to `main` directly.

## 10. (Recommended) YouTube API: full archive and translated titles

The public RSS only lists the **latest 15 uploads**, Shorts included. The
Worker keeps every video it has ever seen, so the archive grows from launch
on, but older episodes won't appear. With a free YouTube Data API key the
Worker also:

- loads the back catalog (up to 500 videos) and durations;
- reads **title and description translations**. In YouTube Studio →
  **Languages** → each video → **Title & description**, add the Spanish or
  English version. The Spanish site shows the Spanish one, the English site
  the English one, and both fall back to the original.

1. Google Cloud console → new project → **APIs & Services → Library →
   YouTube Data API v3 → Enable**.
2. **Credentials → Create credentials → API key**. Restrict it to
   *YouTube Data API v3*.
3. Store it and load the whole catalog once (a full load refreshes videos
   only, not news, to stay under the request limit):

```bash
npx wrangler secret put YOUTUBE_API_KEY
curl -X POST -H "Authorization: Bearer $TOKEN" "BETA_URL/api/refresh?full=1"
```

Quota use is tiny: about 2 units per refresh against 10,000 per day.

**Shorts** appear in the **Clips** strip (home and episodes pages), not in
the episode list. The RSS feed marks Shorts exactly, and the Worker reads it
in both modes. For older videos that are only in the API, a `#shorts` tag or
a length of 60 s or less counts as a Short.

## 11. Checking on it

- `BETA_URL/api/status`: last run, and every feed with `ok`, item count or the
  error.
- `npx wrangler tail`: live logs (run it, then wait for the next 10-minute
  mark).
- Adding a team: in the CMS, **Fuentes de noticias** → add a filter button
  (`teams`) and its feeds. mlb.com feeds follow
  `https://www.mlb.com/<team>/feeds/news/rss.xml` (e.g. `mets`, `redsox`);
  MLB Trade Rumors uses `https://www.mlbtraderumors.com/<full-team-name>/feed`
  (e.g. `boston-red-sox`).

### Free plan limits this design respects

| Limit (Workers Free) | What the site uses |
|---|---|
| 1,000 KV writes/day | about 430 (2–3 writes per run, 144 runs) |
| 50 outbound requests per run | at most 40 feeds, a third per run |
| 10 ms CPU per run | feeds split into 3 batches; heavy article bodies stripped before parsing |

Check these against Cloudflare's current limits page. If `wrangler tail`
shows "exceeded CPU", raise `NEWS_BATCHES` in `wrangler.jsonc` (e.g. `"6"`:
each feed then refreshes every hour) or move to Workers Paid.

## 12. Going live (later)

1. Add the custom domain to the Worker (**Settings → Domains & Routes**).
2. In the CMS, **Sitio**: set `url` to the real domain and turn **Modo beta**
   off. That removes the label, the `noindex` tag and the blocking
   `robots.txt`.
3. Optional: replace token sign-in with GitHub OAuth (Sveltia's
   `sveltia-cms-auth` Worker), so editors don't handle tokens.

## 13. When you finish: log out

```bash
gh auth logout
npx wrangler logout
```

---

## Para editores (resumen en español)

- Entra a `/admin/` con tu token de GitHub.
- **Box fantasy de la semana:** cambia semana, intro y jugadores. Movida =
  Agregar, Mantener o Soltar.
- **Artículos:** crea uno, elige la sección (Fantasy, LIDOM o General),
  escribe en español y, si puedes, la versión en inglés en la otra pestaña de
  idioma. "Borrador" lo guarda sin publicarlo.
- **Fuentes de noticias:** activa, desactiva o agrega fuentes RSS. Máximo 40.
- Cada vez que guardas, el sitio se actualiza solo en 1–2 minutos.
- Las noticias y los episodios de YouTube **no** se editan aquí: se cargan
  solos cada 30 minutos.
- Borra el artículo de ejemplo de LIDOM cuando publiquen el primero de verdad.
