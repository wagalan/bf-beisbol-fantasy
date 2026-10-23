// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNewsFeed, parseYouTubeFeed, mergeNews, episodeNumber, isoDuration, cleanText } from '../worker/parse.js';
import { refreshAll, pickBatch, KEYS } from '../worker/refresh.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-23T19:00:00Z');
const FEEDS = {
  maxAgeDays: 10,
  maxItems: 150,
  teams: [{ id: 'mlb', label: 'MLB' }, { id: 'nyy', label: 'NYY' }],
  feeds: [
    { id: 'mlb-en', name: 'MLB.com', url: 'https://feeds.test/mlb-en.xml', team: 'mlb', lang: 'en' },
    { id: 'nyy-mlb', name: 'MLB.com · Yankees', url: 'https://feeds.test/nyy-mlb.xml', team: 'nyy', lang: 'en' },
    { id: 'nyy-mlbtr', name: 'MLB Trade Rumors', url: 'https://feeds.test/mlbtr-nyy.xml', team: 'nyy', lang: 'en' },
    { id: 'broken', name: 'Broken', url: 'https://feeds.test/404.xml', team: 'mlb', lang: 'en' },
  ],
};
const SITE = { youtubeChannelId: 'UCvc-JRJ-e-PJRicZkrd_QCQ' };

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
function fakeFetch(url) {
  const name = url.includes('youtube.com/feeds') ? 'youtube.xml' : url.split('/').pop();
  try {
    return Promise.resolve(new Response(fx(name)));
  } catch {
    return Promise.resolve(new Response('nope', { status: 404 }));
  }
}

test('parses MLB RSS, drops unsafe links', () => {
  const items = parseNewsFeed(fx('mlb-en.xml'), FEEDS.feeds[0], { now: NOW });
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.url.startsWith('https://')));
  assert.equal(items[0].author, 'Thomas Harrigan');
  assert.match(items[3].title, /& permanent GM/);
});

test('drops stale items (old prospects list, evergreen trivia)', () => {
  const items = parseNewsFeed(fx('nyy-mlb.xml'), FEEDS.feeds[1], { now: NOW });
  assert.deepEqual(items.map((i) => i.title.slice(0, 7)), ['Cashman', 'Boone t']);
});

test('MLBTR: excerpt only, entities decoded, summary capped', () => {
  const items = parseNewsFeed(fx('mlbtr-nyy.xml'), FEEDS.feeds[2], { now: NOW });
  assert.equal(items.length, 24);
  assert.ok(items[0].summary.length <= 221);
  assert.match(items[0].summary, /New York’s/);
});

test('league and team copies of a story merge into one, tagged with both teams', () => {
  const a = parseNewsFeed(fx('mlb-en.xml'), FEEDS.feeds[0], { now: NOW });
  const b = parseNewsFeed(fx('nyy-mlb.xml'), FEEDS.feeds[1], { now: NOW });
  const merged = mergeNews([], [...a, ...b], ['mlb-en', 'nyy-mlb'], { now: NOW });
  const cashman = merged.filter((i) => i.title.startsWith('Cashman'));
  assert.equal(cashman.length, 1);
  assert.deepEqual(cashman[0].teams.sort(), ['mlb', 'nyy']);
  assert.equal(cashman[0].source, 'MLB.com · Yankees');
});

test('YouTube Atom: episodes, shorts flagged, numbers parsed', () => {
  const v = parseYouTubeFeed(fx('youtube.xml'));
  assert.equal(v.length, 3);
  assert.equal(v[0].episode, 42);
  assert.equal(v[0].title, 'Episodio 42: Previa de la Serie Mundial & waivers');
  assert.equal(v[1].short, true);
  assert.equal(v[2].episode, 41);
});

test('helpers', () => {
  assert.equal(isoDuration('PT1H2M3S'), 3723);
  assert.equal(isoDuration('PT59S'), 59);
  assert.equal(episodeNumber('Sin número'), null);
  assert.equal(episodeNumber('BF #105 - Draft'), 105);
  assert.equal(cleanText('<b>a</b>&amp;b &#8217; c'), 'a &b ’ c');
});

test('batches rotate through every feed', () => {
  const f = [1, 2, 3, 4, 5, 6, 7];
  const seen = [0, 1, 2].flatMap((s) => pickBatch(f, s, 3));
  assert.deepEqual(seen.sort(), f);
});

test('full refresh writes news, videos and status; broken feed reported, not fatal', async () => {
  const env = { BF_KV: fakeKV() };
  const status = await refreshAll(env, FEEDS, SITE, { fetchImpl: fakeFetch, now: NOW });
  const news = JSON.parse(env.BF_KV.m.get(KEYS.news));
  const videos = JSON.parse(env.BF_KV.m.get(KEYS.videos));
  assert.ok(news.items.length >= 25);
  assert.equal(videos.items.length, 3);
  assert.equal(videos.mode, 'rss');
  assert.equal(status.feeds.broken.ok, false);
  assert.equal(status.feeds['mlb-en'].ok, true);
  // Sorted newest first
  const t = news.items.map((i) => i.published);
  assert.deepEqual([...t].sort().reverse(), t);
});

test('a failing feed keeps its previous items', async () => {
  const env = { BF_KV: fakeKV() };
  await refreshAll(env, FEEDS, SITE, { fetchImpl: fakeFetch, now: NOW });
  const before = JSON.parse(env.BF_KV.m.get(KEYS.news)).items.filter((i) => i.feed === 'nyy-mlbtr').length;
  const failing = (url) => (url.includes('mlbtr') ? Promise.reject(new Error('timeout')) : fakeFetch(url));
  await refreshAll(env, FEEDS, SITE, { fetchImpl: failing, now: NOW + 60000 });
  const after = JSON.parse(env.BF_KV.m.get(KEYS.news)).items.filter((i) => i.feed === 'nyy-mlbtr').length;
  assert.equal(after, before);
});

test('CPU budget: parsing a heavy MLBTR feed stays small', () => {
  const xml = fx('mlbtr-nyy.xml');
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) parseNewsFeed(xml, FEEDS.feeds[2], { now: NOW });
  const ms = (performance.now() - t0) / 10;
  console.log(`  MLBTR 630 KB feed: ${ms.toFixed(2)} ms per parse`);
  assert.ok(ms < 20);
});

// ---------- YouTube Data API mode ----------
import { localizations, refreshVideos } from '../worker/refresh.js';

const apiVideo = (id, title, extra = {}) => ({
  id,
  snippet: { title, description: `desc ${id}`, publishedAt: '2026-10-20T12:00:00Z', liveBroadcastContent: 'none', ...extra.snippet },
  contentDetails: { duration: extra.duration || 'PT1H5M' },
  localizations: extra.localizations,
});
function apiFetch(videos) {
  return (url) => {
    if (url.includes('/playlistItems')) return Promise.resolve(Response.json({ items: videos.map((v) => ({ contentDetails: { videoId: v.id } })) }));
    if (url.includes('/videos?')) return Promise.resolve(Response.json({ items: videos }));
    return fakeFetch(url); // RSS
  };
}

test('localizations: picks es/en from YouTube Studio translations', () => {
  const v = apiVideo('X', 'World Series preview', {
    snippet: { defaultLanguage: 'en' },
    localizations: { 'es-419': { title: 'Previa de la Serie Mundial', description: 'Hablamos de…' }, fr: { title: 'Aperçu' } },
  });
  const l = localizations(v);
  assert.equal(l.es.title, 'Previa de la Serie Mundial');
  assert.equal(l.en.title, 'World Series preview');
  assert.equal(l.fr, undefined);
  assert.equal(localizations(apiVideo('Y', 'No translations')), undefined);
});

test('API mode: RSS decides which recent uploads are Shorts; durations kept', async () => {
  const env = { BF_KV: fakeKV(), YOUTUBE_API_KEY: 'k' };
  // BBBBBBBBBB2 is a Short in the RSS fixture even though it is 2 min long and untagged here
  const videos = [apiVideo('AAAAAAAAAA1', 'Episodio 42'), apiVideo('BBBBBBBBBB2', 'Caminero rompe la pantalla', { duration: 'PT2M' }), apiVideo('DDDDDDDDDD4', 'Old clip #shorts', { duration: 'PT40S' })];
  const r = await refreshVideos(env, SITE.youtubeChannelId, { fetchImpl: apiFetch(videos), now: NOW });
  assert.equal(r.mode, 'api');
  const items = JSON.parse(env.BF_KV.m.get(KEYS.videos)).items;
  const by = Object.fromEntries(items.map((v) => [v.id, v]));
  assert.equal(by.AAAAAAAAAA1.short, false);
  assert.equal(by.AAAAAAAAAA1.duration, 3900);
  assert.equal(by.BBBBBBBBBB2.short, true); // from RSS
  assert.equal(by.DDDDDDDDDD4.short, true); // heuristic, not in RSS
});

test('translations survive a later RSS-only refresh', async () => {
  const env = { BF_KV: fakeKV(), YOUTUBE_API_KEY: 'k' };
  const videos = [apiVideo('AAAAAAAAAA1', 'Episode 42', { snippet: { defaultLanguage: 'en' }, localizations: { es: { title: 'Episodio 42' } } })];
  await refreshVideos(env, SITE.youtubeChannelId, { fetchImpl: apiFetch(videos), now: NOW });
  delete env.YOUTUBE_API_KEY;
  await refreshVideos(env, SITE.youtubeChannelId, { fetchImpl: fakeFetch, now: NOW + 1000 });
  const v = JSON.parse(env.BF_KV.m.get(KEYS.videos)).items.find((x) => x.id === 'AAAAAAAAAA1');
  assert.equal(v.i18n.es.title, 'Episodio 42');
});

test('full backfill skips news to stay under the request limit', async () => {
  const env = { BF_KV: fakeKV(), YOUTUBE_API_KEY: 'k' };
  const seen = [];
  const f = apiFetch([apiVideo('AAAAAAAAAA1', 'Ep')]);
  await refreshAll(env, FEEDS, SITE, { fetchImpl: (u) => (seen.push(u), f(u)), now: NOW, full: true });
  assert.ok(!seen.some((u) => u.includes('feeds.test')));
  assert.equal(env.BF_KV.m.get(KEYS.news), undefined);
});

// ---------- LIDOM (Google News sitemap) ----------
import { isSitemap } from '../worker/parse.js';
const LIDOM = { id: 'lidom', name: 'LIDOM', url: 'https://feeds.test/lidom-news.xml', team: 'lidom', lang: 'es' };

test('LIDOM: Google News sitemap parses into items', () => {
  const xml = fx('lidom-news.xml');
  assert.ok(isSitemap(xml));
  assert.ok(!isSitemap(fx('mlb-en.xml')));
  const items = parseNewsFeed(xml, LIDOM, { now: NOW });
  assert.equal(items.length, 3);
  assert.equal(items[0].published, '2026-10-23T15:29:01.000Z'); // -03:00 offset honored
  assert.match(items[1].title, /presión/);
  assert.deepEqual(items[0].teams, ['lidom']);
});

test('LIDOM: sitemap items accumulate across refreshes; updated titles win', async () => {
  const cfg = { maxAgeDays: 10, maxItems: 150, teams: [], feeds: [LIDOM] };
  const env = { BF_KV: fakeKV() };
  await refreshAll(env, cfg, SITE, { fetchImpl: fakeFetch, now: NOW, videos: false });
  // Next hour the sitemap only lists one story, retitled.
  const later = fx('lidom-news.xml')
    .replace(/<url><loc>https:\/\/lidom.com\/estrellas[\s\S]*?<\/url>\n/, '')
    .replace(/<url><loc>https:\/\/lidom.com\/gigantes[\s\S]*?<\/url>\n/, '')
    .replace('Alfredo Sena destaca', 'Alfredo Sena celebra');
  await refreshAll(env, cfg, SITE, { fetchImpl: async () => new Response(later), now: NOW + 3600e3, videos: false });
  const items = JSON.parse(env.BF_KV.m.get(KEYS.news)).items;
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => i.title.startsWith('Alfredo Sena celebra')));
  assert.ok(!items.some((i) => i.title.startsWith('Alfredo Sena destaca')));
});

test('headlines: emoji stripped, video links tagged', async () => {
  const { stripEmoji, isVideoUrl } = await import('../worker/parse.js');
  assert.equal(stripEmoji('Palco LIDOM ⚾️ Ep.2 📺 TIGRES LANZAN NO HITTER! LEONES Y AGUILAS CON MAL INICIO ⚾️'), 'Palco LIDOM Ep.2 TIGRES LANZAN NO HITTER! LEONES Y AGUILAS CON MAL INICIO');
  assert.equal(stripEmoji('¡Regresa Woodruff! 🇺🇸 Listo'), '¡Regresa Woodruff! Listo');
  assert.equal(stripEmoji('Sin emojis, 100% texto'), 'Sin emojis, 100% texto');
  assert.ok(isVideoUrl('https://lidom.com/videos/palco-lidom-ep-2-97673.html'));
  assert.ok(!isVideoUrl('https://lidom.com/tigres-del-licey/gilbert-gomez-97663.html'));
  const xml = fx('lidom-news.xml').replace(
    '<url><loc>https://lidom.com/nuestro-beisbol/',
    '<url><loc>https://lidom.com/videos/palco-lidom-ep-2-97673.html</loc><news:news><news:publication_date>2026-10-23T09:00:00-03:00</news:publication_date><news:title>Palco LIDOM ⚾️ Ep.2 📺 TIGRES</news:title></news:news></url>\n<url><loc>https://lidom.com/nuestro-beisbol/',
  );
  const items = parseNewsFeed(xml, LIDOM, { now: NOW });
  const v = items.find((i) => i.url.includes('/videos/'));
  assert.equal(v.title, 'Palco LIDOM Ep.2 Tigres'); // emoji gone, caps normalized
  assert.equal(v.video, true);
  assert.equal(items.filter((i) => i.video).length, 1);
});

test('ALL-CAPS headlines become sentence case; normal ones untouched', async () => {
  const { normalizeTitle } = await import('../worker/parse.js');
  assert.equal(
    normalizeTitle('Palco LIDOM Ep.2 TIGRES LANZAN NO HITTER! LEONES Y AGUILAS CON MAL INICIO'),
    'Palco LIDOM Ep.2 Tigres lanzan no hitter! Leones y Águilas con mal inicio',
  );
  assert.equal(normalizeTitle('¡ESCOGIDO GANA EN SANTO DOMINGO! ¿QUIÉN PARA AL LICEY?'), '¡Escogido gana en Santo Domingo! ¿Quién para al Licey?');
  assert.equal(normalizeTitle('TOROS DEL ESTE BLANQUEAN AL LICEY EN LA SERIE'), 'Toros del este blanquean al Licey en la serie');
  for (const t of ['Gigantes ganan su segundo en línea al dejar en el terreno a los Toros', 'Rays-Brewers World Series Game 1 FAQ (Fri., 8 ET on FOX)', 'MLB']) {
    assert.equal(normalizeTitle(t), t);
  }
});
