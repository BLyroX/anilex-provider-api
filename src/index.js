const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3005);
const BASE = String(process.env.UPSTREAM_BASE_URL || 'https://aniwatch.co.at').replace(/\/$/, '');
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 12000);

const http = axios.create({
  timeout: TIMEOUT,
  maxRedirects: 5,
  validateStatus: status => status >= 200 && status < 400,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8'
  }
});

function absoluteUrl(href) {
  if (!href) return null;
  try { return new URL(href, BASE).toString(); } catch { return null; }
}

function slugFromUrl(url) {
  try {
    const p = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    return p || null;
  } catch { return null; }
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function episodeNumberFromText(text) {
  const m = String(text || '').match(/episode\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

function parseSearch(html, query) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('.item').each((_, el) => {
    const item = $(el);

    const link = item.find('a[href]').first();
    const href = link.attr('href');
    const url = absoluteUrl(href);

    if (!url || !url.startsWith(BASE)) return;

    const img = item.find('img').first();

    const title = cleanText(
      item.find('h1, h2, h3, h4, .title, .name').first().text() ||
      link.attr('title') ||
      img.attr('alt') ||
      item.text()
    );

    const image = absoluteUrl(
      img.attr('data-src') ||
      img.attr('data-lazy-src') ||
      img.attr('src')
    );

    const slug = slugFromUrl(url);

    if (!slug || !title) return;

    const haystack = `${title} ${slug}`.toLowerCase();
    if (!haystack.includes(query.toLowerCase())) return;

    if (seen.has(url)) return;
    seen.add(url);

    results.push({
      title,
      id: slug,
      url,
      image: image || null
    });
  });

  return results.slice(0, 50);
}

function parseEpisodes(html, animeUrl) {
  const $ = cheerio.load(html);
  const episodes = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const url = absoluteUrl(href);
    if (!url || !url.startsWith(BASE)) return;

    const text = cleanText($(el).attr('title') || $(el).text());
    const slug = slugFromUrl(url) || '';
    if (!/episode-\d+/i.test(slug) && !/episode\s*\d+/i.test(text)) return;
    if (seen.has(url)) return;
    seen.add(url);

    episodes.push({
      number: episodeNumberFromText(`${text} ${slug}`),
      title: text || slug.replace(/-/g, ' '),
      id: slug,
      url
    });
  });

  episodes.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
  return episodes;
}

function parseDirectMedia(html) {
  const $ = cheerio.load(html);
  const sources = [];
  const seen = new Set();

  const maybeAdd = (raw, typeHint) => {
    const url = absoluteUrl(raw);
    if (!url || seen.has(url)) return;
    if (!/\.(m3u8|mp4)(?:$|\?)/i.test(url)) return;
    seen.add(url);
    sources.push({ url, type: typeHint || (/\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'mp4') });
  };

  $('video[src], source[src]').each((_, el) => maybeAdd($(el).attr('src')));
  $('script').each((_, el) => {
    const txt = $(el).html() || '';
    const matches = txt.match(/https?:[^"'\\\s]+\.(?:m3u8|mp4)(?:\?[^"'\\\s]*)?/gi) || [];
    for (const m of matches) maybeAdd(m.replace(/\\\//g, '/'));
  });

  return sources;
}

async function fetchHtml(url) {
  const started = Date.now();
  try {
    const r = await http.get(url);
    return {
      ok: true,
      status: r.status,
      url: r.request?.res?.responseUrl || url,
      ms: Date.now() - started,
      html: String(r.data || '')
    };
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.code === 'ECONNABORTED' ? `upstream timeout after ${TIMEOUT}ms` : err.message;
    const e = new Error(message);
    e.status = status;
    e.details = { url, upstreamStatus: err.response?.status || null };
    throw e;
  }
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'anileX Provider API', upstream: BASE });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'anileX Provider API' });
});

app.get('/api/search/:query', async (req, res, next) => {
  try {
    const query = cleanText(req.params.query);
    const target = `${BASE}/?s=${encodeURIComponent(query)}`;
    const r = await fetchHtml(target);
    const results = parseSearch(r.html, query);

    const payload = {
      ok: true,
      query,
      upstream: {
        status: r.status,
        url: r.url,
        ms: r.ms
      },
      results
    };

    if (String(req.query.debug || '') === '1') {
      const $ = cheerio.load(r.html);
      const sampleLinks = [];

      $('a[href]').slice(0, 40).each((_, el) => {
        sampleLinks.push({
          text: cleanText(
            $(el).attr('title') || $(el).text()
          ).slice(0, 120),

          href: $(el).attr('href') || null,
          class: $(el).attr('class') || null
        });
      });

      payload.debug = {
        htmlLength: r.html.length,
        pageTitle: cleanText($('title').first().text()),
        anchorCount: $('a[href]').length,
        articleCount: $('article').length,

        itemClassCounts: {
          post: $('.post').length,
          item: $('.item').length,
          result: $('.result').length,
          searchResult: $('.search-result').length,
          bs: $('.bs').length,
          bsx: $('.bsx').length,
          listupd: $('.listupd').length
        },

        sampleLinks
      };
    }

    res.json(payload);
  } catch (e) {
    next(e);
  }
});

app.get('/api/anime/:id/episodes', async (req, res, next) => {
  try {
    const id = cleanText(req.params.id).replace(/^\/+|\/+$/g, '');
    const target = `${BASE}/${id}/`;
    const r = await fetchHtml(target);
    const episodes = parseEpisodes(r.html, target);
    res.json({ ok: true, id, upstream: { status: r.status, url: r.url, ms: r.ms }, episodes });
  } catch (e) { next(e); }
});

app.get('/api/episode', async (req, res, next) => {
  try {
    const url = String(req.query.url || '');
    if (!url || !url.startsWith(BASE)) return res.status(400).json({ ok: false, error: 'url must be an upstream episode URL' });
    const r = await fetchHtml(url);
    const sources = parseDirectMedia(r.html);
    res.json({ ok: true, upstream: { status: r.status, url: r.url, ms: r.ms }, sources, pageUrl: r.url });
  } catch (e) { next(e); }
});

app.get('/api/debug/search/:query', async (req, res, next) => {
  try {
    const query = cleanText(req.params.query);
    const target = `${BASE}/?s=${encodeURIComponent(query)}`;
    const r = await fetchHtml(target);
    res.json({
      ok: true,
      upstream: { status: r.status, url: r.url, ms: r.ms, htmlLength: r.html.length },
      htmlStart: r.html.slice(0, 1200)
    });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'internal error', details: err.details || null });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`anileX Provider API listening on ${PORT}`);
  console.log(`Upstream: ${BASE}`);
});
