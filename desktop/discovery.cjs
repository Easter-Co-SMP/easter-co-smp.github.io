'use strict';
// The launcher's one editorial read: the latest public dispatch and a curated store
// highlight. Both are optional furniture on the home screen and neither may ever
// change what the player can do, so everything here is bounded, cached and thrown
// away the moment it stops being trustworthy (doc/launcher-discovery.md).
//
// The document is published with the site the launcher already downloads from, at one
// fixed path on that origin: no second host, no credentials, no signing, no provider
// SDK and nothing the renderer can name. A player's launcher therefore fetches the
// same public bytes their browser would, over the same TLS, and the content can be
// corrected by pushing the site.
const {apiFetch} = require('./security.cjs');
const {clientOrigin} = require('./config.cjs');

const CONTENT_PATH = '/home.json';
const TIMEOUT_MS = 8000;              // bounded far below the transport's own 30 s ceiling
const MAX_BYTES = 64 * 1024;          // a newsletter, not an archive
const CACHE_MS = 30 * 60 * 1000;      // one read, then quiet for half an hour
const POSTS_MAX = 12;

// A dispatch link leaves for the system browser (main's window-open handler validates it
// again), so only an ordinary HTTPS page is accepted here: no credentials in the URL, no
// other scheme, no data: URL wearing a link's clothes.
function cleanURL(value){
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href;
}
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// An identifier is either the source's own or nothing: truncating it could turn two
// different items into the same key, which is exactly what a stable id must never do.
const id = value => {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(clean) ? clean : null;
};
const stamp = value => {
  const clean = text(value, 40);
  return clean && Number.isFinite(Date.parse(clean)) ? new Date(Date.parse(clean)).toISOString() : null;
};

// One post, or null. Every field the renderer reads is decided here rather than there:
// the renderer still filters (it must not trust main either), but a malformed entry is
// dropped at the boundary so the renderer never sees it.
function cleanPost(value) {
  if (!value || typeof value !== 'object') return null;
  const key = id(value.id), title = text(value.title, 160), url = cleanURL(value.url), publishedAt = stamp(value.publishedAt);
  if (!key || !title || !url || !publishedAt) return null;
  return {id: key, title, excerpt: text(value.excerpt, 400), publishedAt, url};
}

function cleanItem(value) {
  if (!value || typeof value !== 'object') return null;
  const key = id(value.id), title = text(value.title, 120);
  if (!key || !title) return null;
  return {id: key, title, description: text(value.description, 1600), category: text(value.category, 40)};
}

// The whole document, or a refusal. An unknown schema is not guessed at: a newer launcher
// document than this build understands is exactly the case where showing nothing is
// right, and the home screen already has an honest empty state.
function cleanContent(value) {
  if (!value || typeof value !== 'object' || value.schema !== 1) throw Error('Unsupported content');
  if (!Array.isArray(value.posts)) throw Error('Unsupported content');
  const seen = new Set(), posts = [];
  for (const entry of value.posts.slice(0, POSTS_MAX)) {
    const post = cleanPost(entry);
    if (post && !seen.has(post.id)) { seen.add(post.id); posts.push(post); }
  }
  return {schema: 1, posts, featuredItem: cleanItem(value.featuredItem)};
}

// Where the document lives: the same origin the launcher installs from. `clientOrigin()`
// is the one place that origin is decided, so a development override moves the content
// with the rest of the public files rather than leaving it pointed at production.
function contentURL(origin = clientOrigin()) {
  return new URL(CONTENT_PATH, origin).href;
}

class Discovery {
  constructor({request = apiFetch, now = Date.now, url = null} = {}) {
    this.request = request;
    this.now = now;
    this.url = url || contentURL();
    this.cached = null;
    this.cachedAt = 0;
    this.inFlight = null;
  }

  // A read the home screen asks for once. Concurrent asks share one request; a fresh
  // answer is reused for half an hour; and an answer already in hand survives a later
  // failure, because losing the network is not a reason to blank a dispatch the player
  // was reading a moment ago.
  async content() {
    if (this.cached && this.now() - this.cachedAt < CACHE_MS) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async fetchOnce() {
    try {
      const response = await this.request(this.url, {
        headers: {accept: 'application/json'},
        signal: AbortSignal.timeout(TIMEOUT_MS),
        maxBytes: MAX_BYTES
      });
      if (!response.ok) throw Error('The latest content could not be read.');
      const document = await response.json();
      const content = cleanContent(document);
      this.cached = content;
      this.cachedAt = this.now();
      return content;
    } catch (error) {
      if (this.cached) return this.cached;
      const failed = Error('The latest content could not be read.');
      failed.code = 'content_unavailable';
      failed.cause = error;
      throw failed;
    }
  }
}

module.exports = {Discovery, cleanContent, cleanPost, cleanItem, contentURL, CONTENT_PATH, TIMEOUT_MS, MAX_BYTES, CACHE_MS};
