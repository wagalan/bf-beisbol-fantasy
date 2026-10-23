// Feed parsing and normalization. Pure functions, no Worker APIs, so they
// can be tested in Node with `npm test`.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  // Never let a feed grow objects we don't need.
  isArray: (name) => name === 'item' || name === 'entry',
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
}

export function cleanText(s, max = 0) {
  let t = String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (max && t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}

function safeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// WordPress feeds (MLB Trade Rumors) put the full article in
// <content:encoded>. We only show an excerpt, so cut those blocks out before
// parsing; it saves most of the CPU on large feeds.
function stripHeavyBlocks(xml) {
  return xml.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/g, '');
}

function dedupeKey(lang, url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // mlb.com publishes the same story under /news/x and /yankees/news/x.
    if (host === 'mlb.com') {
      const slug = u.pathname.split('/').filter(Boolean).pop();
      return `${lang}:${host}:${slug}`;
    }
    return `${lang}:${host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return `${lang}:${url}`;
  }
}

/** Parse an RSS 2.0 or Atom document into normalized news items. */
export function parseNewsFeed(xml, feed, { now = Date.now(), maxAgeDays = 10 } = {}) {
  const doc = parser.parse(stripHeavyBlocks(xml));
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  const minTime = now - maxAgeDays * 864e5;
  const maxTime = now + 864e5; // tolerate small clock/timezone skew
  const out = [];
  for (const it of raw) {
    const title = cleanText(text(it.title), 200);
    let link = text(it.link);
    if (!link && it.link && typeof it.link === 'object') link = it.link['@href'] || '';
    if (Array.isArray(it.link)) link = (it.link.find((l) => l['@rel'] !== 'self') || it.link[0])['@href'];
    const url = safeUrl(link);
    if (!title || !url) continue;

    let time = Date.parse(text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']));
    const epoch = Number(text(it['mlb:display-date-epoch']));
    if (!Number.isFinite(time) && Number.isFinite(epoch)) time = epoch * 1000;
    if (!Number.isFinite(time) || time < minTime || time > maxTime) continue;

    out.push({
      key: dedupeKey(feed.lang, url),
      title,
      url,
      summary: cleanText(text(it.description) || text(it.summary), 220),
      author: cleanText(text(it['dc:creator']) || text(it.author?.name), 80),
      published: new Date(time).toISOString(),
      source: feed.name,
      feed: feed.id,
      lang: feed.lang,
      teams: [feed.team],
    });
  }
  return out;
}

/**
 * Merge fresh items for the feeds refreshed in this run into the stored list.
 * Items from feeds not refreshed this run are kept as they were.
 */
export function mergeNews(stored, fresh, refreshedFeedIds, { now = Date.now(), maxAgeDays = 10, maxItems = 150, activeFeedIds } = {}) {
  const refreshed = new Set(refreshedFeedIds);
  const active = activeFeedIds ? new Set(activeFeedIds) : null;
  const minTime = now - maxAgeDays * 864e5;
  const byKey = new Map();
  const add = (item) => {
    const prev = byKey.get(item.key);
    if (!prev) {
      byKey.set(item.key, { ...item, teams: [...item.teams] });
      return;
    }
    for (const t of item.teams) if (!prev.teams.includes(t)) prev.teams.push(t);
    // Prefer the team-specific source name over the league feed.
    if (prev.teams[0] === 'mlb' && item.teams[0] !== 'mlb') prev.source = item.source;
  };
  for (const it of stored || []) {
    if (refreshed.has(it.feed)) continue;
    if (active && !active.has(it.feed)) continue;
    if (Date.parse(it.published) < minTime) continue;
    add(it);
  }
  for (const it of fresh) add(it);
  return [...byKey.values()]
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, maxItems);
}

// ---------- YouTube ----------

export function episodeNumber(title) {
  const m = String(title).match(/(?:\bep(?:isodio|isode)?\.?\s*|#)(\d{1,4})\b/i);
  return m ? Number(m[1]) : null;
}

/** Parse the channel's public Atom feed (latest 15 uploads). */
export function parseYouTubeFeed(xml) {
  const doc = parser.parse(xml);
  const entries = doc?.feed?.entry ?? [];
  return entries
    .map((e) => {
      const id = text(e['yt:videoId']);
      const link = Array.isArray(e.link) ? e.link[0]?.['@href'] : e.link?.['@href'];
      const group = e['media:group'] || {};
      const title = cleanText(text(e.title) || text(group['media:title']), 200);
      if (!/^[\w-]{11}$/.test(id) || !title) return null;
      return {
        id,
        title,
        description: cleanText(text(group['media:description']), 400),
        published: new Date(text(e.published)).toISOString(),
        short: String(link || '').includes('/shorts/'),
        duration: null,
        episode: episodeNumber(title),
      };
    })
    .filter(Boolean);
}

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export function isoDuration(d) {
  const m = String(d || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, D = 0, H = 0, M = 0, S = 0] = m.map((x) => Number(x || 0));
  return D * 86400 + H * 3600 + M * 60 + S;
}

export function mergeVideos(stored, fresh, maxItems = 500) {
  const byId = new Map((stored || []).map((v) => [v.id, v]));
  for (const v of fresh) {
    const prev = byId.get(v.id) || {};
    byId.set(v.id, {
      ...prev,
      ...v,
      duration: v.duration ?? prev.duration ?? null,
      // RSS-only refreshes carry no translations; keep the ones the API gave.
      i18n: v.i18n ?? prev.i18n,
      short: Boolean(v.short),
    });
  }
  return [...byId.values()].sort((a, b) => b.published.localeCompare(a.published)).slice(0, maxItems);
}
