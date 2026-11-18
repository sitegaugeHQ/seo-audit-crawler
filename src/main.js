// SEO Audit Crawler
// Crawls a website politely (robots.txt aware, identified user agent), audits every URL for
// on-page and technical SEO issues, then runs cross-page checks (duplicates, broken internal
// links, redirect chains, sitemap coverage, hreflang return links) before saving one row per URL.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const BOT_NAME = 'SiteAuditBot';
const BOT_INFO_URL = process.env.BOT_INFO_URL || 'https://apify.com/sitegauge/seo-audit-crawler';
const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; ${BOT_NAME}/1.0; +${BOT_INFO_URL})`;
const ITEM_EVENT = 'apify-default-dataset-item';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const CONNECT_ATTEMPT_MS = 3_000; // each address of a host that has several
const MAX_RETRIES = 1;
const SITEMAP_BUDGET_MS = Number(process.env.SITEMAP_BUDGET_MS) || 60_000;
const MIN_HOST_INTERVAL_MS = 100; // at most ~10 requests per second per host
const MAX_CRAWL_DELAY_MS = 3_000;
const MAX_LINKS_KEPT_PER_PAGE = 1000;
const HARD_MAX_PAGES = 20_000;

// When a host has several addresses, Node gives each of them a quarter of a second to connect before it moves on,
// and gives up when the last one fails. A healthy server far away needs longer than that, so each address gets more.
net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);

const TRACKING_PARAMS = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid|ref_src)$/i;
const SKIP_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|mp[34]|m4[av]|mov|avi|wmv|webm|ogg|wav|css|js|mjs|json|xml|rss|atom|txt|csv|woff2?|ttf|eot|otf|exe|dmg|apk|ics|vcf)$/i;

// Issue catalogue: code -> severity, short title, how to fix.
const ISSUES = {
    // Errors
    http_4xx: ['error', 'Page returns a 4xx error', 'Restore the page, redirect it to the closest relevant URL, or remove links that point to it.'],
    http_5xx: ['error', 'Page returns a 5xx server error', 'Check server logs for this URL; search engines drop pages that keep failing.'],
    fetch_failed: ['error', 'Page could not be fetched', 'The request timed out or failed (DNS, TLS or connection error). Check that the URL is reachable.'],
    redirect_loop: ['error', 'Redirect loop or very long redirect chain', 'Point the first URL straight at the final destination.'],
    broken_internal_links: ['error', 'Links to broken internal pages', 'Update or remove the links listed in brokenInternalLinks.'],
    title_missing: ['error', 'Title tag is missing or empty', 'Add a unique, descriptive <title> of roughly 30 to 60 characters.'],
    duplicate_title: ['error', 'Title is duplicated on other indexable pages', 'Give each indexable page its own title, or canonicalise true duplicates.'],
    h1_missing: ['error', 'H1 heading is missing', 'Add one H1 that states the main topic of the page.'],
    canonical_multiple: ['error', 'Conflicting canonical URLs', 'Keep a single canonical URL per page (HTML tag and HTTP header must agree).'],
    canonical_broken: ['error', 'Canonical points to a URL that does not return 200', 'Point the canonical at a live, indexable URL.'],
    non_200_in_sitemap: ['error', 'Sitemap lists a URL that does not return 200', 'List only final, live URLs in the XML sitemap.'],
    mixed_content: ['error', 'HTTPS page loads resources over HTTP', 'Load every image, script, stylesheet and frame over HTTPS.'],
    hreflang_invalid: ['error', 'Invalid hreflang annotation', 'Use valid language or language-region codes (for example en, en-GB, x-default) with absolute URLs.'],
    structured_data_invalid: ['error', 'JSON-LD structured data cannot be parsed', 'Fix the JSON syntax so search engines can read the markup.'],
    viewport_missing: ['error', 'Mobile viewport meta tag is missing', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'],
    // Warnings
    title_too_long: ['warning', 'Title is longer than 60 characters', 'Shorten the title so it is not truncated in search results.'],
    title_too_short: ['warning', 'Title is shorter than 30 characters', 'Use the space to describe the page more specifically.'],
    title_multiple: ['warning', 'More than one title tag', 'Keep exactly one <title> in the <head>.'],
    meta_description_missing: ['warning', 'Meta description is missing', 'Add a meta description of roughly 70 to 160 characters.'],
    meta_description_too_long: ['warning', 'Meta description is longer than 160 characters', 'Shorten it so the key message is not cut off.'],
    meta_description_too_short: ['warning', 'Meta description is shorter than 70 characters', 'Expand it to summarise the page and invite the click.'],
    meta_description_multiple: ['warning', 'More than one meta description', 'Keep exactly one meta description.'],
    duplicate_meta_description: ['warning', 'Meta description is duplicated on other indexable pages', 'Write a distinct description for each indexable page.'],
    h1_multiple: ['warning', 'More than one H1 heading', 'Use a single H1 and H2 to H6 for sub-sections.'],
    canonical_missing: ['warning', 'Canonical tag is missing', 'Add a self-referencing canonical to indexable pages.'],
    noindex_in_sitemap: ['warning', 'Sitemap lists a page that is set to noindex', 'Remove noindex pages from the sitemap, or remove the noindex.'],
    nofollow_meta: ['warning', 'Page has a nofollow robots directive', 'Remove nofollow unless you really want crawlers to ignore every link on the page.'],
    redirect_chain: ['warning', 'Redirect chain with two or more hops', 'Redirect straight to the final URL.'],
    internal_links_to_redirects: ['warning', 'Links to internal URLs that redirect', 'Link directly to the final URLs listed in linksToRedirects.'],
    thin_content: ['warning', 'Low word count', 'Indexable pages with under 200 words often struggle to rank; add useful content or noindex the page.'],
    duplicate_content: ['warning', 'Page text is identical to other indexable pages', 'Consolidate the duplicates or canonicalise them to one URL.'],
    images_missing_alt: ['warning', 'Images without an alt attribute', 'Add descriptive alt text (or alt="" for purely decorative images).'],
    slow_response: ['warning', 'Slow server response', 'The HTML took more than 1.5 seconds to download; look at caching and server performance.'],
    large_html: ['warning', 'HTML document is larger than 1 MB', 'Reduce inline scripts, styles and markup.'],
    http_url: ['warning', 'Page is served over HTTP', 'Serve the page over HTTPS and redirect the HTTP version.'],
    compression_missing: ['warning', 'HTML is served without compression', 'Enable gzip or Brotli for text responses.'],
    orphan_page: ['warning', 'Page is in the sitemap but has no internal links pointing to it', 'Link to the page from relevant pages so users and crawlers can reach it.'],
    blocked_for_googlebot: ['warning', 'URL is disallowed for Googlebot in robots.txt', 'Remove the disallow rule if the page should appear in search.'],
    hreflang_no_return: ['warning', 'hreflang alternate does not link back', 'Every page in an hreflang set must reference all the others, including itself.'],
    // Notices
    noindex: ['notice', 'Page is set to noindex', 'Fine if intentional; remove the directive if the page should rank.'],
    canonicalised: ['notice', 'Canonical points to a different URL', 'Fine if intentional; this page will usually be left out of the index.'],
    redirect_temporary: ['notice', 'Temporary redirect (302, 303 or 307)', 'Use a 301 or 308 if the move is permanent.'],
    not_in_sitemap: ['notice', 'Indexable page is missing from the XML sitemap', 'Add it to the sitemap so it is discovered and recrawled reliably.'],
    deep_page: ['notice', 'Page is more than four clicks from the start URL', 'Bring important pages closer to the homepage through internal links.'],
    url_too_long: ['notice', 'URL is longer than 120 characters', 'Prefer short, readable URLs.'],
    url_uppercase: ['notice', 'URL path contains uppercase letters', 'Use lowercase paths to avoid duplicate URL variants.'],
    url_underscores: ['notice', 'URL path contains underscores', 'Hyphens are the conventional word separator in URLs.'],
    url_parameters: ['notice', 'Indexable URL contains query parameters', 'Make sure parameter URLs are canonicalised or intended to rank.'],
    lang_missing: ['notice', 'HTML lang attribute is missing', 'Declare the page language, for example <html lang="en">.'],
    og_missing: ['notice', 'Open Graph title or image is missing', 'Add og:title and og:image so shared links show a rich preview.'],
    twitter_card_missing: ['notice', 'Twitter card tag is missing', 'Add <meta name="twitter:card" content="summary_large_image">.'],
    structured_data_missing: ['notice', 'No structured data found', 'Add schema.org markup that matches the page type.'],
    heading_level_skipped: ['notice', 'Heading levels are skipped', 'Keep headings in order (H2 after H1, H3 after H2).'],
    hreflang_no_self: ['notice', 'hreflang set has no self-reference', 'Include the page itself in its hreflang annotations.'],
    links_empty_anchor: ['notice', 'Links without anchor text', 'Give every link descriptive text or an image with alt text.'],
    charset_missing: ['notice', 'Character encoding is not declared', 'Declare UTF-8 in the Content-Type header or a <meta charset> tag.'],
    html_truncated: ['notice', 'HTML was larger than 5 MB and was only partly analysed', 'Reduce the page size.'],
};
const SEVERITY_WEIGHT = { error: 15, warning: 5, notice: 1 };
const SEVERITY_ORDER = { error: 0, warning: 1, notice: 2 };

// ---------------------------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------------------------

function normalizeUrl(raw, base) {
    if (typeof raw !== 'string') return null;
    let u;
    try {
        u = new URL(raw.trim(), base);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const drop = [];
    for (const key of u.searchParams.keys()) if (TRACKING_PARAMS.test(key)) drop.push(key);
    for (const key of drop) u.searchParams.delete(key);
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
}

const bareHost = (hostname) => hostname.replace(/^www\./, '');

function makeScope(startUrl, mode) {
    const s = new URL(startUrl);
    const baseHost = bareHost(s.hostname);
    const basePath = s.pathname.endsWith('/') ? s.pathname : s.pathname.replace(/[^/]*$/, '');
    return (url) => {
        let u;
        try {
            u = new URL(url);
        } catch {
            return false;
        }
        const h = bareHost(u.hostname);
        if (mode === 'domain') return h === baseHost || h.endsWith(`.${baseHost}`);
        if (h !== baseHost) return false;
        if (mode === 'path') return u.pathname.startsWith(basePath);
        return true;
    };
}

function globToRegExp(pattern) {
    const escaped = pattern.trim().replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(pattern.includes('*') ? `^${escaped}$` : escaped, 'i');
}

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const internPool = new Map();
const intern = (s) => {
    const hit = internPool.get(s);
    if (hit !== undefined) return hit;
    internPool.set(s, s);
    return s;
};
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

async function fetchOnce(url, { userAgent, readAll = false, maxBytes = MAX_HTML_BYTES, timeoutMs = REQUEST_TIMEOUT_MS }) {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            redirect: 'manual',
            signal: ctrl.signal,
            headers: {
                'user-agent': userAgent,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
            },
        });
        const headers = {};
        for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
        const contentType = (headers['content-type'] || '').toLowerCase();
        const isHtml = /text\/html|application\/xhtml\+xml/.test(contentType);
        let body = null;
        let bytes = 0;
        let truncated = false;
        if (res.body && (isHtml || readAll)) {
            const chunks = [];
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) {
                    truncated = true;
                    chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes)));
                    bytes = maxBytes;
                    await reader.cancel().catch(() => {});
                    break;
                }
                chunks.push(value);
            }
            body = Buffer.concat(chunks);
        } else if (res.body) {
            await res.body.cancel().catch(() => {});
        }
        return { ok: true, status: res.status, headers, contentType, isHtml, body, bytes, truncated, timeMs: Math.round(performance.now() - t0) };
    } catch (err) {
        const aborted = err?.name === 'AbortError' || ctrl.signal.aborted;
        const code = aborted ? 'TIMEOUT' : (err?.cause?.code || err?.code || 'FETCH_ERROR');
        const message = aborted ? `No response within ${Math.round(timeoutMs / 1000)} s` : String(err?.cause?.message || err?.message || err);
        return { ok: false, errorCode: String(code), errorMessage: message.slice(0, 200), timeMs: Math.round(performance.now() - t0) };
    } finally {
        clearTimeout(timer);
    }
}

// Fetch with a retry for transient failures (network errors, 429, 5xx). Timeouts are not retried.
async function fetchWithRetry(url, opts) {
    const maxRetries = opts.retries ?? MAX_RETRIES;
    let last;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        last = await fetchOnce(url, opts);
        const transient = last.ok ? last.status === 429 || last.status >= 500 : last.errorCode !== 'TIMEOUT';
        if (!transient || attempt === maxRetries) break;
        let wait = 1000 * (attempt + 1) * (attempt + 1);
        const retryAfter = last.ok ? Number(last.headers['retry-after']) : NaN;
        if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1000, 10_000);
        await sleep(wait);
    }
    return last;
}

// Follow redirects manually (used for robots.txt and sitemaps).
async function fetchFollow(url, opts, maxHops = 5) {
    let current = url;
    let res;
    for (let hop = 0; hop <= maxHops; hop++) {
        res = await fetchWithRetry(current, opts);
        if (!res.ok || res.status < 300 || res.status >= 400 || !res.headers.location) break;
        const next = normalizeUrl(res.headers.location, current);
        if (!next) break;
        current = next;
    }
    return { ...res, finalUrl: current };
}

// ---------------------------------------------------------------------------------------------
// robots.txt and sitemaps
// ---------------------------------------------------------------------------------------------

async function loadRobots(origin, opts) {
    const url = `${origin}/robots.txt`;
    const res = await fetchFollow(url, { ...opts, readAll: true, maxBytes: 512 * 1024, timeoutMs: 10_000 });
    const status = res.ok ? res.status : null;
    const exists = res.ok && res.status === 200 && !!res.body && !res.isHtml;
    const text = exists ? res.body.toString('utf8') : '';
    const parser = robotsParser(url, text);
    const delay = Number(parser.getCrawlDelay(BOT_NAME));
    return {
        origin,
        url,
        status,
        exists,
        serverError: status !== null && status >= 500,
        parser,
        sitemaps: exists ? parser.getSitemaps() : [],
        crawlDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay * 1000, MAX_CRAWL_DELAY_MS) : 0,
    };
}

async function loadSitemaps(sitemapUrls, opts, limit) {
    const pageUrls = new Set();
    const files = [];
    const queue = [...sitemapUrls];
    const seen = new Set();
    const stopAt = Date.now() + SITEMAP_BUDGET_MS;
    let inFlight = 0;
    // Reads one sitemap file. Slow or huge files are cut off so they cannot stall the audit.
    async function readOne(sm) {
        const timeoutMs = Math.min(20_000, Math.max(stopAt - Date.now(), 1_000));
        const res = await fetchFollow(sm, { ...opts, readAll: true, maxBytes: 30 * 1024 * 1024, timeoutMs, retries: 0 });
        const info = { url: sm, status: res.ok ? res.status : null, type: null, urlCount: 0 };
        files.push(info);
        if (!res.ok || res.status !== 200 || !res.body) return;
        let buf = res.body;
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            try {
                buf = gunzipSync(buf);
            } catch {
                info.type = 'unreadable';
                return;
            }
        }
        const text = buf.toString('utf8');
        if (/<sitemapindex[\s>]/i.test(text) || /<urlset[\s>]/i.test(text)) {
            const isIndex = /<sitemapindex[\s>]/i.test(text);
            const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
            info.type = isIndex ? 'index' : 'urlset';
            info.urlCount = locs.length;
            for (const loc of locs) {
                const n = normalizeUrl(loc, sm);
                if (!n) continue;
                if (isIndex) queue.push(n);
                else if (pageUrls.size < limit) pageUrls.add(n);
            }
        } else if (!/<html[\s>]/i.test(text)) {
            // Plain-text sitemap: one URL per line.
            const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
            if (lines.length) {
                info.type = 'text';
                info.urlCount = lines.length;
                for (const line of lines) {
                    const n = normalizeUrl(line);
                    if (n && pageUrls.size < limit) pageUrls.add(n);
                }
            }
        }
    }
    async function runner() {
        for (;;) {
            if (Date.now() > stopAt || files.length >= 50 || pageUrls.size >= limit) return;
            const sm = queue.shift();
            if (sm === undefined) {
                if (inFlight === 0) return;
                await sleep(50);
                continue;
            }
            if (seen.has(sm)) continue;
            seen.add(sm);
            inFlight += 1;
            try {
                await readOne(sm);
            } finally {
                inFlight -= 1;
            }
        }
    }
    await Promise.all(Array.from({ length: 4 }, () => runner()));
    return { pageUrls, files, notRead: queue.filter((u) => !seen.has(u)).length };
}

// ---------------------------------------------------------------------------------------------
// Page analysis
// ---------------------------------------------------------------------------------------------

function parseLinkHeaderCanonical(header, base) {
    if (!header) return [];
    const out = [];
    for (const part of header.split(',')) {
        const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i);
        if (m && m[2].toLowerCase().split(/\s+/).includes('canonical')) {
            const n = normalizeUrl(m[1], base);
            if (n) out.push(n);
        }
    }
    return out;
}

function collectJsonLdTypes(node, types, depth = 0) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
        for (const item of node) collectJsonLdTypes(item, types, depth + 1);
        return;
    }
    if (typeof node !== 'object') return;
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.add(x);
    for (const value of Object.values(node)) if (value && typeof value === 'object') collectJsonLdTypes(value, types, depth + 1);
}

const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

// Encoding precedence follows browsers: byte order mark, then the Content-Type header, then <meta charset>.
// When nothing is declared, bytes that are valid UTF-8 are read as UTF-8 and anything else as windows-1252.
function encodingOptions(res) {
    const label = /charset\s*=\s*["']?([^\s;"']+)/i.exec(res.contentType)?.[1];
    if (label) return { transportLayerEncodingLabel: label, defaultEncoding: 'utf-8' };
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(res.body, { stream: true });
        return { defaultEncoding: 'utf-8' };
    } catch {
        return { defaultEncoding: 'windows-1252' };
    }
}

function analyzeHtml(url, res, inScope) {
    const $ = cheerio.loadBuffer(res.body, { encoding: encodingOptions(res) });
    const isHttps = url.startsWith('https://');
    const baseHref = $('base[href]').first().attr('href');
    const base = normalizeUrl(baseHref || url, url) || url;

    // Meta tags
    const metas = {};
    $('meta').each((_, el) => {
        const name = clean($(el).attr('name') || $(el).attr('property') || $(el).attr('http-equiv') || '').toLowerCase();
        if (!name) return;
        (metas[name] ||= []).push(clean($(el).attr('content')));
    });

    const titles = $('head title').map((_, el) => clean($(el).text())).get();
    const title = titles[0] || clean($('html > title').first().text()) || '';
    const descriptions = (metas.description || []).filter((d) => d !== undefined);
    const metaDescription = descriptions[0] || '';
    const metaRobots = [...(metas.robots || []), ...(metas.googlebot || [])].join(', ').toLowerCase();
    const xRobotsTag = (res.headers['x-robots-tag'] || '').toLowerCase();
    const robotsDirectives = `${metaRobots}, ${xRobotsTag}`;
    const noindex = /\bnoindex\b|\bnone\b/.test(robotsDirectives);
    const nofollow = /\bnofollow\b|\bnone\b/.test(robotsDirectives);

    // Link elements
    const canonicals = new Set(parseLinkHeaderCanonical(res.headers.link, url));
    const hreflang = [];
    let hreflangInvalid = 0;
    $('link[rel]').each((_, el) => {
        const rel = clean($(el).attr('rel')).toLowerCase().split(' ');
        const href = $(el).attr('href');
        if (rel.includes('canonical')) {
            const n = normalizeUrl(href || '', base);
            if (n) canonicals.add(n);
        }
        if (rel.includes('alternate') && $(el).attr('hreflang') !== undefined) {
            const lang = clean($(el).attr('hreflang'));
            const n = href && /^https?:\/\//i.test(href.trim()) ? normalizeUrl(href, base) : null;
            if (!HREFLANG_RE.test(lang) || !n) hreflangInvalid += 1;
            if (n) hreflang.push({ lang, url: n });
        }
    });
    const canonicalList = [...canonicals];
    const canonical = canonicalList[0] || null;

    // Headings
    const headingLevels = [];
    const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    const h1 = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
        const tag = el.tagName.toLowerCase();
        counts[tag] += 1;
        headingLevels.push(Number(tag[1]));
        if (tag === 'h1' && h1.length < 3) h1.push(clean($(el).text()).slice(0, 200));
    });
    let headingSkipped = false;
    for (let i = 1; i < headingLevels.length; i++) if (headingLevels[i] > headingLevels[i - 1] + 1) headingSkipped = true;

    // Images
    const images = $('img');
    let imagesMissingAlt = 0;
    images.each((_, el) => {
        if ($(el).attr('alt') === undefined) imagesMissingAlt += 1;
    });

    // Links
    const internalTargets = new Set();
    let internalLinks = 0;
    let externalLinks = 0;
    let nofollowLinks = 0;
    let emptyAnchors = 0;
    $('a[href]').each((_, el) => {
        const raw = ($(el).attr('href') || '').trim();
        if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|sms|data|blob|about):/i.test(raw)) return;
        const n = normalizeUrl(raw, base);
        if (!n) return;
        const rel = clean($(el).attr('rel')).toLowerCase();
        if (/\bnofollow\b/.test(rel)) nofollowLinks += 1;
        const text = clean($(el).text()) || clean($(el).attr('aria-label')) || clean($(el).attr('title')) || clean($(el).find('img[alt]').attr('alt'));
        if (!text) emptyAnchors += 1;
        if (inScope(n)) {
            internalLinks += 1;
            if (internalTargets.size < MAX_LINKS_KEPT_PER_PAGE) internalTargets.add(intern(n));
        } else {
            externalLinks += 1;
        }
    });

    // Mixed content
    let mixedContent = 0;
    if (isHttps) {
        $('img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], link[rel="stylesheet"][href]').each((_, el) => {
            const src = ($(el).attr('src') || $(el).attr('href') || '').trim();
            if (/^http:\/\//i.test(src)) mixedContent += 1;
        });
    }

    // Structured data
    const types = new Set();
    let jsonLdBlocks = 0;
    let jsonLdErrors = 0;
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = ($(el).html() || '').trim();
        if (!raw) return;
        jsonLdBlocks += 1;
        try {
            collectJsonLdTypes(JSON.parse(raw), types);
        } catch {
            jsonLdErrors += 1;
        }
    });
    $('[itemscope][itemtype]').each((_, el) => {
        const t = clean($(el).attr('itemtype')).split('/').pop();
        if (t) types.add(t);
    });

    // Visible text
    const lang = clean($('html').attr('lang'));
    const hasCharset = $('meta[charset]').length > 0 || /charset=/.test(res.contentType) || !!metas['content-type'];
    $('script, style, noscript, template, svg, iframe').remove();
    const text = clean($('body').text());
    const wordCount = text ? text.split(' ').length : 0;

    return {
        title,
        titleCount: titles.length,
        metaDescription,
        metaDescriptionCount: descriptions.length,
        metaRobots: metaRobots || null,
        xRobotsTag: xRobotsTag || null,
        noindex,
        nofollow,
        canonical,
        canonicalList,
        hreflang,
        hreflangInvalid,
        h1,
        counts,
        headingSkipped,
        imagesCount: images.length,
        imagesMissingAlt,
        internalLinks,
        externalLinks,
        nofollowLinks,
        emptyAnchors,
        internalTargets: [...internalTargets],
        mixedContent,
        structuredDataTypes: [...types].slice(0, 30),
        jsonLdBlocks,
        jsonLdErrors,
        lang: lang || null,
        hasCharset,
        hasViewport: !!(metas.viewport && metas.viewport[0]),
        og: {
            title: metas['og:title']?.[0] || null,
            description: metas['og:description']?.[0] || null,
            image: metas['og:image']?.[0] || null,
        },
        twitterCard: metas['twitter:card']?.[0] || null,
        wordCount,
        textHash: wordCount >= 50 ? sha1(text.toLowerCase()) : null,
    };
}

// ---------------------------------------------------------------------------------------------
// Row building and issue rules
// ---------------------------------------------------------------------------------------------

function buildRow(url, res, facts, meta) {
    const row = {
        url,
        site: bareHost(new URL(url).hostname),
        statusCode: res.ok ? res.status : null,
        pageType: 'other',
        contentType: res.ok ? (res.contentType.split(';')[0] || null) : null,
        redirectTo: null,
        redirectChain: null,
        finalUrl: null,
        depth: meta.depth,
        discoveredFrom: meta.from,
        inSitemap: null,
        inlinksCount: 0,
        indexable: false,
        indexabilityReason: null,
        score: null,
        errorsCount: 0,
        warningsCount: 0,
        noticesCount: 0,
        issueCodes: [],
        issues: [],
        title: null,
        titleLength: null,
        metaDescription: null,
        metaDescriptionLength: null,
        h1: null,
        h1Count: null,
        h2Count: null,
        canonical: null,
        canonicalType: null,
        metaRobots: null,
        xRobotsTag: null,
        lang: null,
        hreflang: null,
        wordCount: null,
        htmlSizeBytes: null,
        responseTimeMs: res.timeMs,
        contentEncoding: null,
        imagesCount: null,
        imagesMissingAlt: null,
        internalLinksCount: null,
        externalLinksCount: null,
        nofollowLinksCount: null,
        structuredDataTypes: null,
        ogTitle: null,
        ogImage: null,
        twitterCard: null,
        duplicateTitleUrls: null,
        duplicateDescriptionUrls: null,
        duplicateContentUrls: null,
        brokenInternalLinks: null,
        linksToRedirects: null,
        fetchError: null,
        auditedAt: new Date().toISOString(),
    };
    const codes = new Set();

    if (!res.ok) {
        row.pageType = 'failed';
        row.fetchError = `${res.errorCode}: ${res.errorMessage}`;
        row.indexabilityReason = 'Fetch failed';
        codes.add('fetch_failed');
        return { row, codes };
    }

    row.contentEncoding = res.headers['content-encoding'] || null;

    if (res.status >= 300 && res.status < 400) {
        row.pageType = 'redirect';
        row.redirectTo = normalizeUrl(res.headers.location || '', url);
        row.indexabilityReason = row.redirectTo ? `Redirect (${res.status})` : `HTTP ${res.status} without a Location header`;
        if ([302, 303, 307].includes(res.status)) codes.add('redirect_temporary');
        return { row, codes };
    }
    if (res.status >= 500) codes.add('http_5xx');
    else if (res.status >= 400) codes.add('http_4xx');

    if (!facts) {
        row.pageType = res.isHtml ? 'html' : 'non-html';
        row.indexabilityReason = res.status === 200 ? 'Not an HTML document' : `HTTP ${res.status}`;
        return { row, codes };
    }

    row.pageType = 'html';
    row.title = facts.title || null;
    row.titleLength = facts.title.length;
    row.metaDescription = facts.metaDescription || null;
    row.metaDescriptionLength = facts.metaDescription.length;
    row.h1 = facts.h1.length ? facts.h1 : null;
    row.h1Count = facts.counts.h1;
    row.h2Count = facts.counts.h2;
    row.canonical = facts.canonical;
    row.metaRobots = facts.metaRobots;
    row.xRobotsTag = facts.xRobotsTag;
    row.lang = facts.lang;
    row.hreflang = facts.hreflang.length ? facts.hreflang : null;
    row.wordCount = facts.wordCount;
    row.htmlSizeBytes = res.bytes;
    row.imagesCount = facts.imagesCount;
    row.imagesMissingAlt = facts.imagesMissingAlt;
    row.internalLinksCount = facts.internalLinks;
    row.externalLinksCount = facts.externalLinks;
    row.nofollowLinksCount = facts.nofollowLinks;
    row.structuredDataTypes = facts.structuredDataTypes.length ? facts.structuredDataTypes : null;
    row.ogTitle = facts.og.title;
    row.ogImage = facts.og.image;
    row.twitterCard = facts.twitterCard;

    if (facts.canonicalList.length > 1) row.canonicalType = 'multiple';
    else if (!facts.canonical) row.canonicalType = 'missing';
    else row.canonicalType = facts.canonical === url ? 'self' : 'other';

    // Indexability
    if (res.status !== 200) row.indexabilityReason = `HTTP ${res.status}`;
    else if (facts.noindex) row.indexabilityReason = 'noindex directive';
    else if (row.canonicalType === 'other') row.indexabilityReason = 'Canonicalised to another URL';
    else row.indexable = true;

    if (res.status !== 200) return { row, codes };

    // On-page rules (only for pages that return 200)
    const u = new URL(url);
    if (!facts.title) codes.add('title_missing');
    else if (facts.title.length > 60) codes.add('title_too_long');
    else if (facts.title.length < 30) codes.add('title_too_short');
    if (facts.titleCount > 1) codes.add('title_multiple');

    if (!facts.metaDescription) codes.add('meta_description_missing');
    else if (facts.metaDescription.length > 160) codes.add('meta_description_too_long');
    else if (facts.metaDescription.length < 70) codes.add('meta_description_too_short');
    if (facts.metaDescriptionCount > 1) codes.add('meta_description_multiple');

    if (facts.counts.h1 === 0) codes.add('h1_missing');
    else if (facts.counts.h1 > 1) codes.add('h1_multiple');
    if (facts.headingSkipped) codes.add('heading_level_skipped');

    if (row.canonicalType === 'multiple') codes.add('canonical_multiple');
    else if (row.canonicalType === 'missing') codes.add('canonical_missing');
    else if (row.canonicalType === 'other') codes.add('canonicalised');

    if (facts.noindex) codes.add('noindex');
    if (facts.nofollow) codes.add('nofollow_meta');
    if (facts.hreflangInvalid > 0) codes.add('hreflang_invalid');
    if (facts.hreflang.length && !facts.hreflang.some((h) => h.url === url)) codes.add('hreflang_no_self');

    if (facts.mixedContent > 0) codes.add('mixed_content');
    if (facts.jsonLdErrors > 0) codes.add('structured_data_invalid');
    if (!facts.hasViewport) codes.add('viewport_missing');
    if (facts.imagesMissingAlt > 0) codes.add('images_missing_alt');
    if (facts.emptyAnchors > 0) codes.add('links_empty_anchor');
    if (!facts.lang) codes.add('lang_missing');
    if (!facts.hasCharset) codes.add('charset_missing');
    if (!facts.og.title || !facts.og.image) codes.add('og_missing');
    if (!facts.twitterCard) codes.add('twitter_card_missing');
    if (!facts.structuredDataTypes.length && facts.jsonLdBlocks === 0) codes.add('structured_data_missing');

    if (row.indexable && facts.wordCount < 200 && !res.truncated) codes.add('thin_content');
    if (row.indexable && u.search) codes.add('url_parameters');
    if (res.timeMs > 1500) codes.add('slow_response');
    if (res.bytes > 1024 * 1024) codes.add('large_html');
    if (res.truncated) codes.add('html_truncated');
    if (u.protocol === 'http:') codes.add('http_url');
    if (!row.contentEncoding && res.bytes > 1024) codes.add('compression_missing');
    let readableUrl = url;
    try { readableUrl = decodeURI(url); } catch { /* malformed escapes: keep the raw URL */ }
    if (readableUrl.length > 120) codes.add('url_too_long');
    if (/[A-Z]/.test(u.pathname.replace(/%[0-9a-f]{2}/gi, ''))) codes.add('url_uppercase');
    if (u.pathname.includes('_')) codes.add('url_underscores');

    return { row, codes };
}

function finaliseIssues(row, codes, details = {}) {
    const list = [...codes]
        .filter((code) => ISSUES[code])
        .map((code) => ({ code, severity: ISSUES[code][0], message: ISSUES[code][1], howToFix: ISSUES[code][2], ...(details[code] ? { detail: details[code] } : {}) }))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
    row.issues = list;
    row.issueCodes = list.map((i) => i.code);
    row.errorsCount = list.filter((i) => i.severity === 'error').length;
    row.warningsCount = list.filter((i) => i.severity === 'warning').length;
    row.noticesCount = list.filter((i) => i.severity === 'notice').length;
    if (row.pageType === 'html' && row.statusCode === 200) {
        const penalty = list.reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0);
        row.score = Math.max(0, 100 - penalty);
    } else {
        row.score = null;
    }
}

// ---------------------------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderReport(summary, rows) {
    const worst = rows.filter((r) => r.score !== null).sort((a, b) => a.score - b.score).slice(0, 50);
    const badge = (sev) => `<span class="b ${sev}">${sev}</span>`;
    const issueRows = summary.issueBreakdown.map((i) => `
      <tr><td>${badge(i.severity)}</td><td><strong>${esc(i.title)}</strong><br><span class="m">${esc(i.howToFix)}</span></td><td class="n">${i.count}</td>
      <td class="u">${i.exampleUrls.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join('<br>')}</td></tr>`).join('');
    const pageRows = worst.map((r) => `
      <tr><td class="n">${r.score}</td><td class="u"><a href="${esc(r.url)}">${esc(r.url)}</a><br><span class="m">${esc(r.title || '(no title)')}</span></td>
      <td class="n">${r.errorsCount}</td><td class="n">${r.warningsCount}</td><td class="n">${r.noticesCount}</td><td class="m">${esc(r.issueCodes.slice(0, 8).join(', '))}</td></tr>`).join('');
    const statusCells = Object.entries(summary.statusCodes).map(([k, v]) => `<div class="c"><div class="v">${v}</div><div class="l">${esc(k)}</div></div>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO audit report: ${esc(summary.sites.join(', '))}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2330;margin:0;background:#f5f6f8}
main{max-width:1100px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 12px}
.m{color:#667085;font-size:13px}.cards{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
.c{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:14px 18px;min-width:120px}
.v{font-size:26px;font-weight:650}.l{color:#667085;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ec;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef0f4;vertical-align:top}
th{background:#fafbfc;font-size:13px;color:#475467}.n{text-align:right;white-space:nowrap}
.u{word-break:break-all;font-size:13px}a{color:#1d4ed8;text-decoration:none}
.b{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;text-transform:capitalize}
.error{background:#fde8e8;color:#b42318}.warning{background:#fff1d6;color:#93500a}.notice{background:#e6f0ff;color:#1849a9}
</style></head><body><main>
<h1>SEO audit report</h1>
<div class="m">${esc(summary.sites.join(', '))} &middot; ${esc(summary.finishedAt)} &middot; ${summary.urlsAudited} URLs audited</div>
<div class="cards">
<div class="c"><div class="v">${summary.score ?? 'n/a'}</div><div class="l">Site score (0 to 100)</div></div>
<div class="c"><div class="v">${summary.htmlPages}</div><div class="l">HTML pages</div></div>
<div class="c"><div class="v">${summary.indexablePages}</div><div class="l">Indexable pages</div></div>
<div class="c"><div class="v">${summary.issues.errors}</div><div class="l">Errors</div></div>
<div class="c"><div class="v">${summary.issues.warnings}</div><div class="l">Warnings</div></div>
<div class="c"><div class="v">${summary.issues.notices}</div><div class="l">Notices</div></div>
</div>
${summary.siteChecks.length ? `<h2>Site-level checks</h2><table><tbody>${summary.siteChecks.map((c) => `<tr><td>${badge(c.severity)}</td><td>${esc(c.message)}</td></tr>`).join('')}</tbody></table>` : ''}
<h2>Status codes</h2><div class="cards">${statusCells}</div>
<h2>Issues found</h2>
<table><thead><tr><th>Severity</th><th>Issue and fix</th><th class="n">URLs</th><th>Examples</th></tr></thead><tbody>${issueRows || '<tr><td colspan="4">No issues found.</td></tr>'}</tbody></table>
<h2>Pages needing most attention</h2>
<table><thead><tr><th class="n">Score</th><th>Page</th><th class="n">Errors</th><th class="n">Warnings</th><th class="n">Notices</th><th>Issue codes</th></tr></thead><tbody>${pageRows}</tbody></table>
<p class="m">Scores start at 100 and lose 15 points per error, 5 per warning and 1 per notice. HTML is analysed as served; content added by JavaScript after load is not included.</p>
</main></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const startUrls = [];
for (const item of input.startUrls ?? []) {
    const n = normalizeUrl(typeof item === 'string' ? item : item?.url);
    if (n && !startUrls.includes(n)) startUrls.push(n);
}
if (!startUrls.length) {
    await Actor.fail('No valid start URL. Provide at least one http(s) URL in "startUrls".');
}

const crawlScope = ['hostname', 'domain', 'path', 'listOnly'].includes(input.crawlScope) ? input.crawlScope : 'hostname';
const useSitemap = input.useSitemap !== false && crawlScope !== 'listOnly';
const respectRobots = input.respectRobotsTxt !== false;
const maxDepth = Number.isInteger(input.maxDepth) ? input.maxDepth : 20;
const maxConcurrency = Math.min(Math.max(Number(input.maxConcurrency) || 5, 1), 20);
const userAgent = clean(input.userAgent) || DEFAULT_USER_AGENT;
const includePatterns = (input.includeUrlPatterns ?? []).filter(Boolean).map(globToRegExp);
const excludePatterns = (input.excludeUrlPatterns ?? []).filter(Boolean).map(globToRegExp);
let maxPages = Math.min(Math.max(Number(input.maxPages) || 100, 1), HARD_MAX_PAGES);

// Respect the user's spending limit: never audit more URLs than can be charged for.
const chargingManager = Actor.getChargingManager();
const pricing = chargingManager.getPricingInfo();
if (pricing.isPayPerEvent) {
    const chargeable = chargingManager.calculateMaxEventChargeCountWithinLimit(ITEM_EVENT);
    if (chargeable <= 0) {
        await Actor.exit('The maximum cost per run is too low to audit a single URL. Raise the limit and run again.');
    }
    if (chargeable < maxPages) {
        log.info(`Limiting the audit to ${chargeable} URLs to stay within the maximum cost set for this run.`);
        maxPages = chargeable;
    }
}

// Resume protection: if the run is restarted after results were saved, do not save them twice.
const state = (await Actor.getValue('STATE')) ?? { pushedUrls: [], done: false };
if (state.done) {
    await Actor.exit('Results were already saved by an earlier attempt of this run.');
}

const scopes = startUrls.map((u) => makeScope(u, crawlScope === 'listOnly' ? 'hostname' : crawlScope));
const inScope = (url) => scopes.some((fn) => fn(url));
const allowedByPatterns = (url) => (!includePatterns.length || includePatterns.some((re) => re.test(url))) && !excludePatterns.some((re) => re.test(url));

const fetchOpts = { userAgent };
const startedAt = new Date();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - 60_000 : Infinity;
let stopRequested = false;
Actor.on('aborting', () => {
    stopRequested = true;
});

// robots.txt per origin
const robotsByOrigin = new Map();
async function getRobots(url) {
    const { origin } = new URL(url);
    if (!robotsByOrigin.has(origin)) robotsByOrigin.set(origin, loadRobots(origin, fetchOpts));
    return robotsByOrigin.get(origin);
}

// Crawl state
const seen = new Set(); // every URL ever queued
const linkQueue = []; // found through links (breadth-first)
const sitemapQueue = []; // found only in sitemaps, crawled after linked pages
const sitemapPending = new Set(); // sitemap-only URLs not yet reached through a link
const depthOf = new Map();
const fromOf = new Map();
const pages = new Map(); // url -> { row, codes, facts }
const robotsBlocked = new Set();
let sitemapUrls = new Set();
let sitemapFiles = [];
let discoveredNotAudited = 0;

function enqueue(url, depth, from, viaSitemap = false) {
    if (depth !== null) {
        const known = depthOf.get(url);
        if (known === undefined || known === null || depth < known) {
            depthOf.set(url, depth);
            if (from) fromOf.set(url, from);
        }
    }
    if (seen.has(url)) {
        // A sitemap-only URL that is later found through a link moves to the main queue.
        if (!viaSitemap && sitemapPending.delete(url)) linkQueue.push(url);
        return;
    }
    if (!inScope(url) || !allowedByPatterns(url)) return;
    if (SKIP_EXTENSIONS.test(new URL(url).pathname)) return;
    if (depth !== null && depth > maxDepth) return;
    seen.add(url);
    if (!depthOf.has(url)) depthOf.set(url, depth);
    if (viaSitemap) {
        sitemapPending.add(url);
        sitemapQueue.push(url);
    } else {
        linkQueue.push(url);
    }
}

// Linked pages are crawled first; sitemap-only URLs follow once the link graph is exhausted.
let sitemapPhase = false;
function nextUrl() {
    const linked = linkQueue.shift();
    if (linked !== undefined) return linked;
    while (sitemapPhase && sitemapQueue.length) {
        const url = sitemapQueue.shift();
        if (sitemapPending.delete(url)) return url;
    }
    return undefined;
}

for (const url of startUrls) {
    seen.add(url);
    depthOf.set(url, 0);
    linkQueue.push(url);
}

// Seed from sitemaps
let sitemapsNotRead = 0;
if (useSitemap) {
    log.info('Reading robots.txt and XML sitemaps.');
    const sitemapCandidates = new Set();
    const origins = [...new Set(startUrls.map((u) => new URL(u).origin))];
    for (const origin of origins) {
        const robots = await getRobots(`${origin}/`);
        for (const sm of robots.sitemaps) {
            const n = normalizeUrl(sm, robots.url);
            if (n) sitemapCandidates.add(n);
        }
        if (!robots.sitemaps.length) sitemapCandidates.add(`${origin}/sitemap.xml`);
    }
    const loaded = await loadSitemaps([...sitemapCandidates], fetchOpts, Math.max(maxPages * 5, 5000));
    sitemapFiles = loaded.files;
    sitemapsNotRead = loaded.notRead;
    if (sitemapsNotRead > 0) log.warning(`Sitemap reading stopped at its time or size limit; ${sitemapsNotRead} sitemap file(s) were not read.`);
    sitemapUrls = new Set([...loaded.pageUrls].filter((u) => inScope(u)));
    for (const url of sitemapUrls) enqueue(url, null, null, true);
    log.info(`Sitemaps: ${sitemapFiles.filter((f) => f.type).length} file(s) read, ${sitemapUrls.size} in-scope URL(s) found.`);
}

// Politeness: space out requests to the same host.
const nextSlot = new Map();
async function waitForSlot(url) {
    const { host, origin } = new URL(url);
    const robots = robotsByOrigin.has(origin) ? await robotsByOrigin.get(origin) : null;
    const interval = Math.max(MIN_HOST_INTERVAL_MS, respectRobots && robots ? robots.crawlDelayMs : 0);
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, at + interval);
    if (at > now) await sleep(at - now);
}

async function processUrl(url) {
    const robots = await getRobots(url);
    if (respectRobots && robots.exists && robots.parser.isAllowed(url, BOT_NAME) === false) {
        robotsBlocked.add(url);
        return;
    }
    await waitForSlot(url);
    const res = await fetchWithRetry(url, fetchOpts);
    let facts = null;
    if (res.ok && res.isHtml && res.body && res.body.length && res.status < 300) {
        try {
            facts = analyzeHtml(url, res, inScope);
        } catch (err) {
            log.warning(`Could not parse ${url}: ${err.message}`);
        }
    } else if (res.ok && res.isHtml && res.body && res.body.length && res.status >= 400) {
        facts = null; // error pages are reported by status only
    }
    const depth = depthOf.get(url) ?? null;
    const { row, codes } = buildRow(url, res, facts, { depth, from: fromOf.get(url) ?? null });
    if (robots.exists && robots.parser.isAllowed(url, 'Googlebot') === false) codes.add('blocked_for_googlebot');
    pages.set(url, { row, codes, facts: facts ? { internalTargets: facts.internalTargets, textHash: facts.textHash, hreflang: facts.hreflang, nofollow: facts.nofollow } : null });

    if (crawlScope === 'listOnly') return;
    const nextDepth = depth === null ? null : depth + 1;
    if (row.redirectTo) enqueue(row.redirectTo, depth, url);
    if (facts) {
        for (const target of facts.internalTargets) enqueue(target, nextDepth, url);
        if (facts.canonical && facts.canonical !== url) enqueue(facts.canonical, nextDepth, url);
        for (const alt of facts.hreflang) enqueue(alt.url, nextDepth, url);
    }
}

// Worker pool
let started = 0;
let active = 0;
let lastLog = Date.now();
async function worker() {
    for (;;) {
        if (stopRequested || Date.now() > deadline || started >= maxPages) return;
        const url = nextUrl();
        if (url === undefined) {
            if (active === 0) return;
            await sleep(50);
            continue;
        }
        if (pages.has(url) || robotsBlocked.has(url)) continue;
        started += 1;
        active += 1;
        try {
            await processUrl(url);
        } catch (err) {
            log.warning(`Unexpected error on ${url}: ${err.message}`);
        } finally {
            active -= 1;
            if (robotsBlocked.has(url)) started -= 1; // blocked URLs do not count towards the limit
        }
        if (Date.now() - lastLog > 10_000) {
            lastLog = Date.now();
            const msg = `Audited ${pages.size} of up to ${maxPages} URLs (${linkQueue.length + sitemapPending.size} queued)`;
            log.info(msg);
            await Actor.setStatusMessage(msg).catch(() => {});
        }
    }
}

log.info(`Starting audit of ${startUrls.join(', ')} (scope: ${crawlScope}, max URLs: ${maxPages}).`);
await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
if (sitemapPending.size) {
    sitemapPhase = true;
    await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
}
for (const url of startUrls) {
    if (robotsBlocked.has(url)) log.warning(`${url} is disallowed by robots.txt for this crawler, so it was not fetched.`);
}
discoveredNotAudited = [...seen].filter((u) => !pages.has(u) && !robotsBlocked.has(u)).length;
const crawlComplete = discoveredNotAudited === 0;
if (Date.now() > deadline) log.warning('Stopping early to save results before the run timeout.');
if (pages.size === 0) {
    const why = robotsBlocked.size ? 'robots.txt disallows the start URL for this crawler. Turn off "Respect robots.txt" only if you own the site.' : 'no start URL could be processed.';
    await Actor.exit(`Nothing was audited: ${why}`);
}
let startNote = '';
for (const url of startUrls) {
    const first = pages.get(url)?.row;
    if (!first) continue;
    let note = '';
    if (first.pageType === 'redirect' && first.redirectTo && !inScope(first.redirectTo)) {
        note = `${url} redirects to ${first.redirectTo}, which is outside the crawl scope. Use the destination as the start URL to audit that site.`;
    } else if (first.pageType === 'failed') {
        note = `${url} could not be fetched (${first.fetchError}). Check the address and that the site is reachable from the public internet.`;
    } else if ([401, 403, 429, 503].includes(first.statusCode)) {
        note = `${url} answered HTTP ${first.statusCode}, so the site may be refusing automated requests. If it is your site, allow the ${BOT_NAME} user agent in your firewall or CDN.`;
    }
    if (note) {
        log.warning(note);
        startNote ||= note;
    }
}

// ---------------------------------------------------------------------------------------------
// Cross-page analysis
// ---------------------------------------------------------------------------------------------

const details = new Map(); // url -> { code: detail }
const addDetail = (url, code, detail) => {
    if (!details.has(url)) details.set(url, {});
    details.get(url)[code] = detail;
};
const hasSitemap = sitemapUrls.size > 0;

// Redirect chains
for (const [url, page] of pages) {
    const { row } = page;
    if (row.pageType !== 'redirect') continue;
    const chain = [url];
    let current = row.redirectTo;
    let loop = false;
    while (current && chain.length <= 6) {
        if (chain.includes(current)) {
            loop = true;
            break;
        }
        chain.push(current);
        const next = pages.get(current);
        if (!next || next.row.pageType !== 'redirect') break;
        current = next.row.redirectTo;
    }
    row.redirectChain = chain;
    row.finalUrl = loop ? null : chain[chain.length - 1];
    const hops = chain.length - 1;
    if (loop || hops > 5) page.codes.add('redirect_loop');
    else if (hops >= 2) page.codes.add('redirect_chain');
}

// Inlinks, broken links, links to redirects
const inlinks = new Map();
for (const [url, page] of pages) {
    if (!page.facts) continue;
    const broken = [];
    const redirecting = [];
    for (const target of page.facts.internalTargets) {
        if (target === url) continue;
        inlinks.set(target, (inlinks.get(target) ?? 0) + 1);
        const t = pages.get(target);
        if (!t) continue;
        if (t.row.pageType === 'failed' || (t.row.statusCode !== null && t.row.statusCode >= 400)) broken.push({ url: target, status: t.row.statusCode ?? 'failed' });
        else if (t.row.pageType === 'redirect') redirecting.push({ url: target, status: t.row.statusCode, redirectsTo: t.row.redirectTo });
    }
    if (broken.length) {
        page.codes.add('broken_internal_links');
        page.row.brokenInternalLinks = broken.slice(0, 50);
    }
    if (redirecting.length) {
        page.codes.add('internal_links_to_redirects');
        page.row.linksToRedirects = redirecting.slice(0, 50);
    }
}

// Duplicates among indexable pages
function markDuplicates(keyFn, field, code) {
    const groups = new Map();
    for (const [url, page] of pages) {
        if (!page.row.indexable) continue;
        const key = keyFn(page);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(url);
    }
    for (const urls of groups.values()) {
        if (urls.length < 2) continue;
        for (const url of urls) {
            const page = pages.get(url);
            page.codes.add(code);
            page.row[field] = urls.filter((u) => u !== url).slice(0, 10);
        }
    }
}
markDuplicates((p) => (p.row.title ? p.row.title.toLowerCase() : null), 'duplicateTitleUrls', 'duplicate_title');
markDuplicates((p) => (p.row.metaDescription ? p.row.metaDescription.toLowerCase() : null), 'duplicateDescriptionUrls', 'duplicate_meta_description');
markDuplicates((p) => p.facts?.textHash ?? null, 'duplicateContentUrls', 'duplicate_content');

// Per-row cross checks
for (const [url, page] of pages) {
    const { row, codes } = page;
    row.inlinksCount = inlinks.get(url) ?? 0;
    row.depth = depthOf.get(url) ?? null;
    row.discoveredFrom = fromOf.get(url) ?? (sitemapUrls.has(url) && row.depth === null ? 'sitemap' : row.discoveredFrom);
    row.inSitemap = hasSitemap ? sitemapUrls.has(url) : null;

    if (row.canonicalType === 'other' && row.canonical) {
        const target = pages.get(row.canonical);
        if (target && target.row.statusCode !== 200) {
            codes.add('canonical_broken');
            addDetail(url, 'canonical_broken', `${row.canonical} returns ${target.row.statusCode ?? 'no response'}`);
        }
    }
    if (hasSitemap) {
        if (row.inSitemap && row.statusCode !== 200) codes.add('non_200_in_sitemap');
        if (row.inSitemap && row.statusCode === 200 && row.indexabilityReason === 'noindex directive') codes.add('noindex_in_sitemap');
        if (!row.inSitemap && row.indexable) codes.add('not_in_sitemap');
        if (crawlComplete && row.inSitemap && row.inlinksCount === 0 && !startUrls.includes(url) && row.pageType === 'html' && row.statusCode === 200) codes.add('orphan_page');
    }
    if (row.indexable && row.depth !== null && row.depth > 4) codes.add('deep_page');
    if (page.facts?.hreflang?.length) {
        const missing = [];
        for (const alt of page.facts.hreflang) {
            if (alt.url === url) continue;
            const other = pages.get(alt.url);
            if (other?.facts && !other.facts.hreflang.some((h) => h.url === url)) missing.push(alt.url);
        }
        if (missing.length) {
            codes.add('hreflang_no_return');
            addDetail(url, 'hreflang_no_return', missing.slice(0, 10).join(', '));
        }
    }
    finaliseIssues(row, codes, details.get(url));
}

// ---------------------------------------------------------------------------------------------
// Save results
// ---------------------------------------------------------------------------------------------

const rows = [...pages.values()].map((p) => p.row);

// The dataset checks every row against the declared output fields and refuses a whole batch when one row does not
// fit. Such a row is saved again with its main facts only, so that it cannot hold back the rows around it.
async function saveRows(batch) {
    try {
        return await Actor.pushData(batch);
    } catch (err) {
        const invalid = err?.data?.invalidItems;
        if (!Array.isArray(invalid) || !invalid.length) throw err;
        const whole = (v) => (Number.isInteger(v) ? v : null);
        const text = (v) => (typeof v === 'string' ? v : null);
        for (const { itemPosition, validationErrors } of invalid) {
            const row = batch[itemPosition];
            if (!row) throw err;
            log.warning(`The row for ${row.url} did not fit the output fields and was saved with its main facts only.`, { validationErrors: JSON.stringify(validationErrors ?? null).slice(0, 500) });
            batch[itemPosition] = {
                url: String(row.url),
                site: text(row.site),
                statusCode: whole(row.statusCode),
                pageType: text(row.pageType),
                indexable: row.indexable === true,
                indexabilityReason: text(row.indexabilityReason),
                score: whole(row.score),
                errorsCount: whole(row.errorsCount),
                warningsCount: whole(row.warningsCount),
                noticesCount: whole(row.noticesCount),
                issueCodes: Array.isArray(row.issueCodes) ? row.issueCodes.filter((c) => typeof c === 'string') : [],
                title: text(row.title),
                fetchError: 'Some details of this URL could not be saved. Please report it on the Issues tab.',
                auditedAt: text(row.auditedAt),
            };
        }
        return Actor.pushData(batch);
    }
}

const alreadyPushed = new Set(state.pushedUrls);
const toPush = rows.filter((r) => !alreadyPushed.has(r.url));
const BATCH = 200;
let saved = alreadyPushed.size;
for (let i = 0; i < toPush.length; i += BATCH) {
    const batch = toPush.slice(i, i + BATCH);
    const result = await saveRows(batch);
    for (const r of batch) state.pushedUrls.push(r.url);
    saved += batch.length;
    await Actor.setValue('STATE', state);
    if (result?.eventChargeLimitReached) {
        log.warning('The maximum cost for this run was reached; remaining rows were not saved.');
        break;
    }
}

// Summary
const statusCodes = {};
for (const r of rows) {
    const key = r.statusCode === null ? 'failed' : String(r.statusCode);
    statusCodes[key] = (statusCodes[key] ?? 0) + 1;
}
const breakdown = new Map();
for (const r of rows) {
    for (const issue of r.issues) {
        if (!breakdown.has(issue.code)) breakdown.set(issue.code, { code: issue.code, severity: issue.severity, title: issue.message, howToFix: issue.howToFix, count: 0, exampleUrls: [] });
        const b = breakdown.get(issue.code);
        b.count += 1;
        if (b.exampleUrls.length < 5) b.exampleUrls.push(r.url);
    }
}
const scored = rows.filter((r) => r.score !== null);
const htmlRows = rows.filter((r) => r.pageType === 'html' && r.statusCode === 200);
const avg = (list, fn) => (list.length ? Math.round(list.reduce((s, x) => s + fn(x), 0) / list.length) : null);
const robotsInfo = [];
for (const promise of robotsByOrigin.values()) {
    const r = await promise;
    robotsInfo.push({ url: r.url, status: r.status, exists: r.exists, sitemapsDeclared: r.sitemaps, crawlDelaySecs: r.crawlDelayMs / 1000 });
}
const siteChecks = [];
for (const r of robotsInfo) {
    if (r.status !== null && r.status >= 500) siteChecks.push({ severity: 'error', message: `${r.url} returns ${r.status}. Search engines may stop crawling the site until robots.txt is reachable.` });
    else if (!r.exists) siteChecks.push({ severity: 'notice', message: `${r.url} was not found. Add a robots.txt file, even an empty one, and declare the sitemap in it.` });
    else if (useSitemap && !r.sitemapsDeclared.length) siteChecks.push({ severity: 'notice', message: `${r.url} does not declare a sitemap. Add a "Sitemap:" line.` });
}
if (useSitemap && !hasSitemap) siteChecks.push({ severity: 'warning', message: 'No XML sitemap with in-scope URLs was found (checked robots.txt and /sitemap.xml).' });
const finishedAt = new Date();
const store = await Actor.openKeyValueStore();
const summary = {
    startUrls,
    sites: [...new Set(rows.map((r) => r.site))],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSecs: Math.round((finishedAt - startedAt) / 1000),
    urlsAudited: rows.length,
    htmlPages: htmlRows.length,
    indexablePages: rows.filter((r) => r.indexable).length,
    score: avg(scored, (r) => r.score),
    statusCodes,
    issues: {
        errors: rows.reduce((s, r) => s + r.errorsCount, 0),
        warnings: rows.reduce((s, r) => s + r.warningsCount, 0),
        notices: rows.reduce((s, r) => s + r.noticesCount, 0),
    },
    issueBreakdown: [...breakdown.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count),
    siteChecks,
    averages: {
        responseTimeMs: avg(rows.filter((r) => r.responseTimeMs !== null), (r) => r.responseTimeMs),
        wordCount: avg(htmlRows, (r) => r.wordCount ?? 0),
        htmlSizeBytes: avg(htmlRows, (r) => r.htmlSizeBytes ?? 0),
    },
    robotsTxt: robotsInfo,
    urlsSkippedByRobotsTxt: { count: robotsBlocked.size, examples: [...robotsBlocked].slice(0, 10) },
    sitemaps: { files: sitemapFiles, urlsInScope: sitemapUrls.size, filesNotRead: sitemapsNotRead },
    limits: { maxUrls: maxPages, limitReached: rows.length >= maxPages, urlsDiscoveredButNotAudited: discoveredNotAudited, stoppedEarly: stopRequested || Date.now() > deadline },
    reportUrl: store.getPublicUrl('REPORT'),
};

await Actor.setValue('REPORT', renderReport(summary, rows), { contentType: 'text/html; charset=utf-8' });
await Actor.setValue('OUTPUT', summary);
state.done = true;
await Actor.setValue('STATE', state);

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const found = `Issues found on the audited site: ${count(summary.issues.errors, 'error')}, ${count(summary.issues.warnings, 'warning')}, ${count(summary.issues.notices, 'notice')}.`;
log.info(`Audit complete. ${count(saved, 'URL')} saved. Site score ${summary.score ?? 'n/a'}. ${found}`);
log.info(`HTML report: ${summary.reportUrl}`);
const scoreText = summary.score === null || summary.score === undefined ? '' : ` Site score ${summary.score}/100.`;
await Actor.exit(`Audit complete: ${count(rows.length, 'URL')} audited.${scoreText} ${found}${startNote ? ` Note: ${startNote}` : ''}`);
