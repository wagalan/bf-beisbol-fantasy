// Browser code: fills news and episode blocks from the Worker's JSON API.
// Everything from the feeds is inserted with textContent, never innerHTML,
// because headlines come from third parties.

const cache = new Map();
function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url, { headers: { accept: 'application/json' } }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(url);
}

const locale = (lang) => (lang === 'en' ? 'en-US' : 'es-DO');

export function relTime(iso, lang) {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto', style: 'short' });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
export const fmtDate = (iso, lang) =>
  new Date(iso).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' });
export function fmtDur(s) {
  if (s == null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// ---------- News ----------

function initNews(root) {
  const lang = root.dataset.lang;
  const s = JSON.parse(root.dataset.i18n);
  const limit = Number(root.dataset.limit || 12);
  const wide = root.dataset.layout === 'wide';
  const list = root.querySelector('.news');
  const chips = [...root.querySelectorAll('.chip')];
  let team = root.dataset.team || 'all';
  let data = null;

  const render = () => {
    list.replaceChildren();
    if (!data) return;
    const items = data.items.filter((i) => team === 'all' || i.teams.includes(team)).slice(0, limit);
    if (!items.length) {
      list.append(el('li', { class: 'state', text: s.newsEmpty }));
      return;
    }
    for (const i of items) {
      const tag = i.teams.filter((x) => x !== 'mlb')[0]?.toUpperCase() || 'MLB';
      const meta = el(
        'span',
        { class: 'n-meta' },
        el('b', { text: tag }),
        // Skip the source when it just repeats the tag ("LIDOM · LIDOM").
        i.source.toUpperCase() === tag ? ' · ' : ` · ${i.source} · `,
        el('time', { datetime: i.published, title: new Date(i.published).toLocaleString(locale(lang)), text: relTime(i.published, lang) }),
        el('span', { class: 'lang', text: i.lang.toUpperCase(), title: i.lang === 'es' ? 'Español' : 'English' }),
        i.video ? el('span', { class: 'vid', text: 'VIDEO' }) : null,
      );
      const a = el('a', { href: i.url, rel: 'noopener', target: '_blank' }, meta, el('span', { class: 'n-title', text: i.title }));
      if (wide && i.summary) a.append(el('span', { class: 'n-sum', text: i.summary }));
      list.append(el('li', {}, a));
    }
  };

  chips.forEach((c) =>
    c.addEventListener('click', () => {
      team = c.dataset.team;
      chips.forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      render();
    }),
  );

  getJSON('/api/news')
    .then((d) => {
      data = d;
      render();
      const up = root.querySelector('[data-updated]');
      if (up && d.updated) up.textContent = `${s.updated} ${relTime(d.updated, lang)}`;
    })
    .catch(() => {
      list.replaceChildren(el('li', { class: 'state', text: s.newsError }));
    });
}

// ---------- Episodes ----------

const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** The video in the page's language when the channel added a translation in YouTube Studio. */
function localize(v, lang) {
  const t = v.i18n?.[lang];
  return t ? { ...v, title: t.title || v.title, description: t.description || v.description } : v;
}

/** Click-to-load player: no YouTube iframe (or cookies) until the visitor presses play. */
export function mountPlayer(box, video, s) {
  box.replaceChildren(
    (() => {
      const img = el('img', { src: thumb(video.id), alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.remove()); // keep the plain blue box
      return img;
    })(),
    el(
      'button',
      { type: 'button', 'aria-label': `${s.play}: ${video.title}` },
      (() => {
        const p = el('span', { class: 'play' });
        p.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="#16348c" aria-hidden="true"><path d="M8 5l12 7-12 7z"/></svg>';
        return p;
      })(),
    ),
  );
  box.querySelector('button').addEventListener('click', () => {
    box.replaceChildren(
      el('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`,
        title: video.title,
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
        allowfullscreen: '',
      }),
    );
  });
}

function epLabel(v, s) {
  return v.episode != null ? `EP ${v.episode}` : s.episode.slice(0, 2).toUpperCase();
}

function fillLead(root, v, s, lang) {
  const f = (k) => root.querySelector(`[data-f="${k}"]`);
  f('kicker').textContent = v.episode != null ? `${s.episode} ${v.episode} · ${s.newEpisode}` : s.newEpisode;
  f('title').textContent = v.title;
  if (f('desc')) f('desc').textContent = v.description || '';
  f('meta').textContent = [fmtDate(v.published, lang), fmtDur(v.duration)].filter(Boolean).join(' · ');
  const yt = f('yt');
  if (yt) yt.href = `https://www.youtube.com/watch?v=${v.id}`;
  mountPlayer(f('player'), v, s);
}

function initVideos(root) {
  const lang = root.dataset.lang;
  const s = JSON.parse(root.dataset.i18n);
  const mode = root.dataset.videos; // "lead" | "archive"
  const skip = Number(root.dataset.skip || 0);
  const limit = Number(root.dataset.limit || 500);
  const base = root.dataset.epHref;

  getJSON('/api/videos')
    .then((d) => {
      const vids = d.items;
      if (!vids.length) throw new Error('empty');
      if (mode === 'lead') {
        const wanted = new URLSearchParams(location.search).get('v');
        const v = (root.dataset.useQuery && vids.find((x) => x.id === wanted)) || vids[0];
        fillLead(root, localize(v, lang), s, lang);
        return;
      }
      const ul = root.querySelector('.eps');
      ul.replaceChildren();
      for (const raw of vids.slice(skip, skip + limit)) {
        const v = localize(raw, lang);
        ul.append(
          el(
            'li',
            {},
            el(
              'a',
              { href: `${base}?v=${encodeURIComponent(v.id)}` },
              el('span', { class: 'e-num', text: epLabel(v, s) }),
              el('span', { class: 'e-date', text: fmtDate(v.published, lang) }),
              el('span', { class: 'e-title', text: v.title }),
              el('span', { class: 'e-dur', text: fmtDur(v.duration) }),
            ),
          ),
        );
      }
    })
    .catch(() => {
      const target = root.querySelector('.eps') || root.querySelector('[data-f="title"]');
      if (target) target.replaceChildren(el(target.tagName === 'UL' ? 'li' : 'span', { class: 'state', text: s.videosEmpty }));
    });
}

// ---------- Clips (YouTube Shorts) ----------

function initClips(root) {
  const lang = root.dataset.lang;
  const s = JSON.parse(root.dataset.i18n);
  const limit = Number(root.dataset.limit || 12);
  const row = root.querySelector('.clips');
  getJSON('/api/videos?shorts=1')
    .then((d) => {
      const clips = d.items.filter((v) => v.short).slice(0, limit);
      if (!clips.length) {
        root.hidden = true; // no Shorts: hide the whole strip
        return;
      }
      row.replaceChildren();
      for (const raw of clips) {
        const v = localize(raw, lang);
        const box = el('div', { class: 'player clip-player' });
        mountPlayer(box, v, s);
        row.append(
          el(
            'li',
            { class: 'clip' },
            box,
            el('span', { class: 'clip-title', text: v.title.replace(/\s*#shorts?\b/gi, '').trim() }),
            el('span', { class: 'meta', text: fmtDate(v.published, lang) }),
          ),
        );
      }
    })
    .catch(() => {
      root.hidden = true;
    });
}

// ---------- LIDOM scoreboard ----------

const DR_TZ = 'America/Santo_Domingo';
const drDay = (ms) => new Date(ms - 4 * 3600e3).toISOString().slice(0, 10); // DR is UTC−4, no DST

function sbStatus(g, s, lang) {
  if (g.state === 'final') return g.extra ? `${s.final}/${g.extra}` : s.final;
  if (g.state === 'live') {
    const half = { top: '▲', bottom: '▼', middle: `${s.mid} `, end: `${s.end} ` }[g.half] ?? '';
    return `${half}${g.inning ?? ''}${g.outs != null && (g.half === 'top' || g.half === 'bottom') ? ` · ${g.outs} ${s.outs}` : ''}`;
  }
  if (g.state === 'suspended') return g.reason && /rain/i.test(g.reason) ? `${s.suspended} (${s.rain})` : s.suspended;
  if (g.state === 'postponed') return s.postponed;
  if (g.state === 'cancelled') return s.cancelled;
  if (g.state === 'delayed') return s.delayed;
  return new Date(g.start).toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-DO', { hour: 'numeric', minute: '2-digit', timeZone: DR_TZ });
}

function sbDayLabel(date, s, lang) {
  const today = drDay(Date.now());
  const off = Math.round((Date.parse(date) - Date.parse(today)) / 864e5);
  if (off === 0) return s.today;
  if (off === -1) return s.yesterday;
  if (off === 1) return s.tomorrow;
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-US' : 'es-DO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '').toUpperCase();
}

function sbTeamRow(t, g, winner) {
  const played = g.state !== 'pre' && g.state !== 'postponed' && g.state !== 'cancelled' && t.runs != null;
  return el(
    'span',
    { class: `sb-team${winner === false ? ' sb-lost' : ''}` },
    el('b', { class: 'sb-abbr', text: t.abbr }),
    played ? el('span', { class: 'sb-r', text: String(t.runs) }) : el('span', { class: 'sb-rec', text: t.record || '' }),
    played && t.hits != null ? el('span', { class: 'sb-he', text: `${t.hits} ${t.errors ?? 0}` }) : null,
  );
}

function initScoreboard(root) {
  const lang = root.dataset.lang;
  const s = JSON.parse(root.dataset.i18n);
  const row = root.querySelector('.sb-row');
  let timer = null;
  let first = true;

  const render = (games) => {
    row.replaceChildren();
    let day = null;
    let todayNode = null;
    for (const g of games) {
      if (g.date !== day) {
        day = g.date;
        const label = el('li', { class: 'sb-day', text: sbDayLabel(day, s, lang) });
        if (day === drDay(Date.now())) todayNode = label;
        row.append(label);
      }
      const done = g.state === 'final' && g.away.runs != null && g.home.runs != null && g.away.runs !== g.home.runs;
      const awayWon = done ? g.away.runs > g.home.runs : null;
      const title = `${g.away.name} @ ${g.home.name}${g.venue ? ` · ${g.venue}` : ''} — ${s.gameday}`;
      row.append(
        el(
          'li',
          { class: `sb-game sb-${g.state}` },
          el(
            'a',
            { href: `https://www.mlb.com/${lang === 'en' ? '' : 'es/'}gameday/${g.id}`, rel: 'noopener', target: '_blank', title },
            el('span', { class: 'sb-status', text: sbStatus(g, s, lang) }),
            sbTeamRow(g.away, g, done ? awayWon : null),
            sbTeamRow(g.home, g, done ? !awayWon : null),
          ),
        ),
      );
    }
    root.hidden = games.length === 0;
    // First paint: start the strip at today's games.
    if (first && todayNode) row.scrollLeft = todayNode.offsetLeft - row.offsetLeft - 8;
    first = false;
  };

  const load = () =>
    fetch('/api/scores', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => {
        render(d.games || []);
        // Keep live games fresh: re-check every minute while a game is on
        // or about to start, and only while the tab is visible.
        const soon = (d.games || []).some((g) => g.state === 'live' || g.state === 'delayed' || (g.state === 'pre' && Math.abs(Date.parse(g.start) - Date.now()) < 30 * 6e4));
        clearTimeout(timer);
        if (soon) timer = setTimeout(() => (document.hidden ? document.addEventListener('visibilitychange', load, { once: true }) : load()), 60e3);
      })
      .catch(() => {
        root.hidden = true;
      });
  load();
}

/** Adds .stuck to the menu once it is pinned to the top, to show the small logo. */
function initStickyNav() {
  const bar = document.querySelector('[data-navbar]');
  const sentinel = document.querySelector('[data-nav-sentinel]');
  if (!bar) return;
  // Phones: the menu scrolls sideways; bring the current page's link into view.
  const nav = bar.querySelector('.nav');
  const cur = nav?.querySelector('[aria-current="page"]');
  if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - nav.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  if (!sentinel || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([e]) => bar.classList.toggle('stuck', !e.isIntersecting)).observe(sentinel);
}

export function init() {
  initStickyNav();
  document.querySelectorAll('[data-scoreboard]').forEach(initScoreboard);
  document.querySelectorAll('[data-clips]').forEach(initClips);
  document.querySelectorAll('[data-news]').forEach(initNews);
  document.querySelectorAll('[data-videos]').forEach(initVideos);
  document.querySelectorAll('[data-today]').forEach((n) => {
    n.textContent = new Date().toLocaleDateString(locale(n.dataset.today), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  });
}
