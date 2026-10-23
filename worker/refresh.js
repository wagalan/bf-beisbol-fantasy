// Pulls the RSS feeds and the YouTube channel into KV.
import { parseNewsFeed, mergeNews, parseYouTubeFeed, mergeVideos, isoDuration, episodeNumber, cleanText } from './parse.js';

export const KEYS = { news: 'news:v1', videos: 'videos:v1', status: 'status:v1' };

// Free Workers allow 50 subrequests per run; keep a margin for YouTube.
const MAX_FEEDS = 40;
const UA = 'BF-Beisbol-Fantasy-NewsBot/1.0 (+https://www.youtube.com/@BeisbolFantasy)';

async function getText(fetchImpl, url, timeoutMs = 10000) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(timeoutMs),
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Which feeds to refresh in this run. Feeds are split into `batches` groups
 * and each cron run takes one group, so a single run stays small enough for
 * the free plan's CPU limit. With a cron every 10 minutes and 3 batches,
 * every feed refreshes every 30 minutes.
 */
export function pickBatch(feeds, slot, batches) {
  if (batches <= 1) return feeds;
  return feeds.filter((_, i) => i % batches === slot % batches);
}

export async function refreshNews(env, cfg, { slot = 0, batches = 1, fetchImpl = fetch, now = Date.now() } = {}) {
  const active = cfg.feeds.filter((f) => f.enabled !== false).slice(0, MAX_FEEDS);
  const batch = pickBatch(active, slot, batches);
  const results = await Promise.allSettled(
    batch.map(async (feed) => {
      const xml = await getText(fetchImpl, feed.url);
      return parseNewsFeed(xml, feed, { now, maxAgeDays: cfg.maxAgeDays });
    }),
  );
  const fresh = [];
  const ok = [];
  const feedStatus = {};
  results.forEach((r, i) => {
    const f = batch[i];
    if (r.status === 'fulfilled') {
      fresh.push(...r.value);
      ok.push(f.id);
      feedStatus[f.id] = { ok: true, items: r.value.length, at: new Date(now).toISOString() };
    } else {
      feedStatus[f.id] = { ok: false, error: String(r.reason?.message || r.reason).slice(0, 200), at: new Date(now).toISOString() };
    }
  });
  const stored = (await env.BF_KV.get(KEYS.news, 'json')) || { items: [] };
  // A failed feed keeps its previous items (it is not in `ok`).
  const items = mergeNews(stored.items, fresh, ok, {
    now,
    maxAgeDays: cfg.maxAgeDays,
    maxItems: cfg.maxItems,
    activeFeedIds: active.map((f) => f.id),
  });
  await env.BF_KV.put(KEYS.news, JSON.stringify({ updated: new Date(now).toISOString(), items }));
  return feedStatus;
}

/**
 * Title/description per site language, from YouTube Studio's "Title &
 * description" translations. Keys like "es-419" or "en-US" collapse to
 * "es"/"en". The video's own language counts as a translation of itself.
 */
export function localizations(v) {
  const out = {};
  const put = (code, t, d) => {
    const lang = String(code || '').slice(0, 2).toLowerCase();
    if ((lang === 'es' || lang === 'en') && t && !out[lang]) {
      out[lang] = { title: cleanText(t, 200), description: cleanText(d, 400) };
    }
  };
  for (const [code, loc] of Object.entries(v.localizations || {})) put(code, loc.title, loc.description);
  put(v.snippet.defaultLanguage, v.snippet.title, v.snippet.description);
  return Object.keys(out).length ? out : undefined;
}

async function youtubeApi(fetchImpl, channelId, key, { pages = 1 } = {}) {
  const base = 'https://www.googleapis.com/youtube/v3';
  const uploads = 'UU' + channelId.slice(2);
  const ids = [];
  let pageToken = '';
  for (let p = 0; p < pages; p++) {
    const u = `${base}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}&key=${key}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = JSON.parse(await getText(fetchImpl, u));
    ids.push(...data.items.map((i) => i.contentDetails.videoId));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const u = `${base}/videos?part=snippet,contentDetails,localizations&id=${ids.slice(i, i + 50).join(',')}&key=${key}`;
    const data = JSON.parse(await getText(fetchImpl, u));
    for (const v of data.items) {
      if (v.snippet.liveBroadcastContent === 'upcoming') continue;
      const duration = isoDuration(v.contentDetails.duration);
      const title = cleanText(v.snippet.title, 200);
      videos.push({
        id: v.id,
        title,
        description: cleanText(v.snippet.description, 400),
        published: new Date(v.snippet.publishedAt).toISOString(),
        // The API has no "is short" flag; refreshVideos overrides this with the
        // RSS feed's exact answer for recent uploads. For older ones, a
        // #shorts tag or a length of 60 s or less counts as a Short.
        short: (duration != null && duration <= 60) || /#shorts?\b/i.test(v.snippet.title + ' ' + v.snippet.description),
        duration,
        episode: episodeNumber(title),
        i18n: localizations(v),
      });
    }
  }
  return videos;
}

export async function refreshVideos(env, channelId, { fetchImpl = fetch, now = Date.now(), full = false } = {}) {
  const stored = (await env.BF_KV.get(KEYS.videos, 'json')) || { items: [] };
  let fresh;
  let mode;
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  if (env.YOUTUBE_API_KEY) {
    // First run (or ?full=1) walks the whole back catalog: up to 10 pages = 500 videos.
    const pages = full || stored.items.length === 0 ? 10 : 1;
    const [api, rss] = await Promise.allSettled([
      youtubeApi(fetchImpl, channelId, env.YOUTUBE_API_KEY, { pages }),
      getText(fetchImpl, rssUrl).then(parseYouTubeFeed),
    ]);
    if (api.status === 'rejected') throw api.reason;
    fresh = api.value;
    // RSS links say exactly which recent uploads are Shorts (/shorts/ URLs).
    if (rss.status === 'fulfilled') {
      const exact = new Map(rss.value.map((v) => [v.id, v.short]));
      for (const v of fresh) if (exact.has(v.id)) v.short = exact.get(v.id);
    }
    mode = 'api';
  } else {
    fresh = parseYouTubeFeed(await getText(fetchImpl, rssUrl));
    mode = 'rss';
  }
  const items = mergeVideos(stored.items, fresh);
  await env.BF_KV.put(KEYS.videos, JSON.stringify({ updated: new Date(now).toISOString(), mode, items }));
  return { ok: true, mode, fetched: fresh.length, total: items.length, at: new Date(now).toISOString() };
}

export async function refreshAll(env, cfg, site, { slot = 0, batches = 1, fetchImpl = fetch, now = Date.now(), full = false, videos = true } = {}) {
  const status = (await env.BF_KV.get(KEYS.status, 'json')) || { feeds: {}, youtube: null };
  // A full YouTube backfill uses up to 21 requests on its own; skip the news
  // that run so the total stays under the 50-request limit.
  const tasks = [full ? Promise.resolve({}) : refreshNews(env, cfg, { slot, batches, fetchImpl, now })];
  if (videos) tasks.push(refreshVideos(env, site.youtubeChannelId, { fetchImpl, now, full }));
  const [news, yt] = await Promise.allSettled(tasks);
  if (news.status === 'fulfilled') Object.assign(status.feeds, news.value);
  else status.newsError = String(news.reason);
  if (videos) {
    status.youtube = yt.status === 'fulfilled' ? yt.value : { ok: false, error: String(yt.reason?.message || yt.reason), at: new Date(now).toISOString() };
  }
  // Drop status for feeds removed from the config.
  const ids = new Set(cfg.feeds.map((f) => f.id));
  for (const id of Object.keys(status.feeds)) if (!ids.has(id)) delete status.feeds[id];
  status.lastRun = new Date(now).toISOString();
  await env.BF_KV.put(KEYS.status, JSON.stringify(status));
  return status;
}
