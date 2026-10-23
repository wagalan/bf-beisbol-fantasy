// BF Béisbol Fantasy Worker: serves the static site (from ./dist via the
// ASSETS binding), the JSON API under /api/*, and the scheduled refresh.
import feedsConfig from '../src/data/feeds.json';
import site from '../src/data/site.json';
import { refreshAll, KEYS } from './refresh.js';
import { getScores } from './scores.js';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      ...(init.headers || {}),
    },
  });

function batches(env) {
  const n = Number(env.NEWS_BATCHES || 3);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

// Constant-time comparison for the refresh token.
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function handleApi(req, env, ctx) {
  const url = new URL(req.url);
  switch (url.pathname) {
    case '/api/news': {
      const data = (await env.BF_KV.get(KEYS.news, 'json')) || { updated: null, items: [] };
      const team = url.searchParams.get('team');
      const lang = url.searchParams.get('lang');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 150, 150);
      let items = data.items;
      if (team && team !== 'all') items = items.filter((i) => i.teams.includes(team));
      if (lang) items = items.filter((i) => i.lang === lang);
      return json({ updated: data.updated, teams: feedsConfig.teams, items: items.slice(0, limit) });
    }
    case '/api/videos': {
      const data = (await env.BF_KV.get(KEYS.videos, 'json')) || { updated: null, items: [] };
      const shorts = url.searchParams.get('shorts') === '1';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 500);
      const items = data.items.filter((v) => shorts || !v.short).slice(0, limit);
      return json({ updated: data.updated, mode: data.mode, items });
    }
    case '/api/scores': {
      // LIDOM scoreboard, cached at the edge for 60 s (see worker/scores.js).
      return getScores({ cache: caches.default });
    }
    case '/api/status': {
      const status = (await env.BF_KV.get(KEYS.status, 'json')) || {};
      return json(status, { headers: { 'cache-control': 'no-store' } });
    }
    case '/api/refresh': {
      if (req.method !== 'POST') return json({ error: 'POST only' }, { status: 405 });
      const auth = req.headers.get('authorization') || '';
      if (!env.REFRESH_TOKEN || !safeEqual(auth, `Bearer ${env.REFRESH_TOKEN}`)) {
        return json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      const status = await refreshAll(env, feedsConfig, site, { batches: 1, full: url.searchParams.get('full') === '1' });
      return json(status, { headers: { 'cache-control': 'no-store' } });
    }
    default:
      return json({ error: 'not found' }, { status: 404 });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, ctx);
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    const n = batches(env);
    const slot = Math.floor(new Date(event.scheduledTime).getUTCMinutes() / 10) % n;
    // YouTube changes slowly: refresh it once per full rotation.
    ctx.waitUntil(refreshAll(env, feedsConfig, site, { slot, batches: n, videos: slot === 0 }));
  },
};
