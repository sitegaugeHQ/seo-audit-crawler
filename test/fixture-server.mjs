// Local fixture site that exercises the audit rules. Not shipped with the Actor.
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT || 8089);
const ORIGIN = `http://localhost:${PORT}`;
const words = (n, seed = 'lorem') => Array.from({ length: n }, (_, i) => `${seed}${i % 37}`).join(' ');

const page = ({ title, desc, h1 = ['Heading'], body = '', head = '', canonical, lang = 'en', viewport = true, htmlAttrs = '' }) => `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}${htmlAttrs}><head><meta charset="utf-8">
${viewport ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}
${title === undefined ? '' : `<title>${title}</title>`}
${desc ? `<meta name="description" content="${desc}">` : ''}
${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
${head}</head><body>
${h1.map((h) => `<h1>${h}</h1>`).join('')}
${body}
</body></html>`;

const GOOD_DESC = 'A carefully written description that explains what this page offers and why a searcher should click through to read it now.';
const routes = {
    '/': () => page({
        title: 'Fixture Home Page For The SEO Audit Crawler',
        desc: GOOD_DESC,
        canonical: `${ORIGIN}/`,
        head: `<meta property="og:title" content="Home"><meta property="og:image" content="${ORIGIN}/a.png"><meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},{"@type":["WebSite","Thing"]}]}</script>`,
        body: `<h2>Sub</h2><p>${words(260)}</p>
<a href="/about">About</a> <a href="/dup-a">Dup A</a> <a href="/dup-b">Dup B</a> <a href="/old">Old</a> <a href="/gone">Gone</a>
<a href="/private/secret">Secret</a> <a href="/no-google/page">NoGoogle</a> <a href="/thin">Thin</a> <a href="/hreflang-en">EN</a>
<a href="/chain1">Chain</a> <a href="/temp">Temp</a> <a href="/slow">Slow</a> <a href="/file.pdf">PDF</a> <a href="https://example.org/">External</a>
<a href="/notitle">No title</a> <a href="/error500">500</a> <a href="/canonical-other">Canon</a> <a href="/UPPER_case_Path">Upper</a>
<a href="/params?x=1&utm_source=news">Params</a> <a href="/noindex-page">Noindex</a> <a href="/gzip">Gzip</a> <a href="/jsonld-bad">Bad JSON-LD</a>
<a href="/download">Download</a> <a href="/xrobots" rel="nofollow">XRobots</a> <a href="#top">Top</a> <a href="mailto:a@example.org">Mail</a>
<a href="/multi">Multi</a> <a href="/about#team">About again</a> <a href="/about"><img src="/a.png"></a>`,
    }),
    '/about': () => page({
        title: 'About This Fixture Site And All Of The Many Different Things It Contains Inside',
        h1: ['One', 'Two'],
        canonical: `${ORIGIN}/about`,
        body: `<h3>Skipped level</h3><p>${words(220, 'about')}</p><img src="/a.png"><img src="/b.png" alt=""><a href="/">Home</a> <a href="/loop-a">Loop</a> <a href="/canonical-broken">CB</a>`,
    }),
    '/dup-a': () => page({ title: 'Duplicate Title Used On Two Different Pages', desc: GOOD_DESC.replace('carefully', 'duplicate'), canonical: `${ORIGIN}/dup-a`, body: `<p>${words(230, 'dup')}</p><a href="/">Home</a>` }),
    '/dup-b': () => page({ title: 'Duplicate Title Used On Two Different Pages', desc: GOOD_DESC.replace('carefully', 'duplicate'), canonical: `${ORIGIN}/dup-b`, body: `<p>${words(230, 'dup')}</p><a href="/">Home</a>` }),
    '/thin': () => page({ title: 'A Thin Page With Very Little Content', desc: 'Too short.', body: '<p>Only a few words here.</p>' }),
    '/orphan': () => page({ title: 'An Orphan Page Listed Only In The Sitemap', desc: GOOD_DESC.replace('carefully', 'orphan'), canonical: `${ORIGIN}/orphan`, body: `<p>${words(210, 'orphan')}</p>` }),
    '/noindex-page': () => page({ title: 'A Page That Asks Not To Be Indexed At All', desc: GOOD_DESC.replace('carefully', 'noindex'), head: '<meta name="robots" content="noindex, follow">', body: `<p>${words(210, 'noindex')}</p>` }),
    '/canonical-other': () => page({ title: 'A Page Canonicalised To The About Page', desc: GOOD_DESC.replace('carefully', 'canonical'), canonical: `${ORIGIN}/about`, body: `<p>${words(210, 'canon')}</p>` }),
    '/canonical-broken': () => page({ title: 'A Page Whose Canonical Target Is Missing', desc: GOOD_DESC.replace('carefully', 'broken'), canonical: `${ORIGIN}/gone`, body: `<p>${words(210, 'cb')}</p>` }),
    '/hreflang-en': () => page({
        title: 'English Version Of The Hreflang Test Page', desc: GOOD_DESC.replace('carefully', 'english'), canonical: `${ORIGIN}/hreflang-en`,
        head: `<link rel="alternate" hreflang="en" href="${ORIGIN}/hreflang-en"><link rel="alternate" hreflang="de" href="${ORIGIN}/hreflang-de">`,
        body: `<p>${words(210, 'en')}</p>`,
    }),
    '/hreflang-de': () => page({
        title: 'Deutsche Version Der Hreflang Testseite Hier', desc: GOOD_DESC.replace('carefully', 'deutsch'), canonical: `${ORIGIN}/hreflang-de`, lang: 'de',
        head: `<link rel="alternate" hreflang="de" href="${ORIGIN}/hreflang-de"><link rel="alternate" hreflang="xx_YY" href="/relative">`,
        body: `<p>${words(210, 'de')}</p>`,
    }),
    '/slow': () => page({ title: 'A Page That Responds Rather Slowly Today', desc: GOOD_DESC.replace('carefully', 'slow'), canonical: `${ORIGIN}/slow`, body: `<p>${words(210, 'slow')}</p>` }),
    '/gzip': () => page({ title: 'A Page That Is Served With Gzip Compression', desc: GOOD_DESC.replace('carefully', 'gzip'), canonical: `${ORIGIN}/gzip`, body: `<p>${words(210, 'gzip')}</p>` }),
    '/jsonld-bad': () => page({ title: 'A Page With Broken JSON-LD Structured Data', desc: GOOD_DESC.replace('carefully', 'jsonld'), canonical: `${ORIGIN}/jsonld-bad`, head: '<script type="application/ld+json">{"@type": "Article", }</script>', body: `<p>${words(210, 'jl')}</p>` }),
    '/UPPER_case_Path': () => page({ title: 'A Page With Uppercase And Underscores In URL', desc: GOOD_DESC.replace('carefully', 'upper'), canonical: `${ORIGIN}/UPPER_case_Path`, body: `<p>${words(210, 'up')}</p>` }),
    '/params': () => page({ title: 'A Page Reached Through A Query Parameter URL', desc: GOOD_DESC.replace('carefully', 'params'), body: `<p>${words(210, 'pa')}</p>` }),
    '/no-google/page': () => page({ title: 'A Page That Googlebot Is Not Allowed To Fetch', desc: GOOD_DESC.replace('carefully', 'nogoogle'), canonical: `${ORIGIN}/no-google/page`, body: `<p>${words(210, 'ng')}</p>` }),
    '/private/secret': () => page({ title: 'Secret', body: 'secret' }),
    '/xrobots': () => page({ title: 'A Page With An X-Robots-Tag Noindex Header', desc: GOOD_DESC.replace('carefully', 'xrobots'), canonical: `${ORIGIN}/xrobots`, body: `<p>${words(210, 'xr')}</p>` }),
    '/notitle': () => page({ title: undefined, h1: [], lang: '', viewport: false, body: `<p>${words(210, 'nt')}</p><svg><title>Icon title</title></svg>` }),
};
routes['/multi'] = () => `<!doctype html><html lang="en"><head><title>First Title Of A Page With Two Titles</title><title>Second</title>
<meta name="viewport" content="width=device-width"><meta name="description" content="${GOOD_DESC.replace('carefully', 'multi')}"><meta name="description" content="second">
<meta name="robots" content="nofollow"><link rel="canonical" href="${ORIGIN}/multi"><link rel="canonical" href="${ORIGIN}/about">
<link rel="alternate" hreflang="fr" href="${ORIGIN}/about"></head><body><h1>Multi</h1><p>${words(210, 'multi')}</p><a href="/deep/1">Deep</a>
<a href="/${'very-long-url-segment-'.repeat(6)}end">Long</a> <a href="/big">Big</a> <a href="/huge">Huge</a></body></html>`;
for (let i = 1; i <= 6; i++) routes[`/deep/${i}`] = () => page({ title: `Deep Page Number ${i} In A Long Chain Of Pages`, desc: GOOD_DESC.replace('carefully', `deep${i}`), canonical: `${ORIGIN}/deep/${i}`, body: `<p>${words(210, `deep${i}x`)}</p><a href="/deep/${i + 1}">Next</a>` });
routes[`/${'very-long-url-segment-'.repeat(6)}end`] = () => page({ title: 'A Page With A Very Long URL Indeed Today', desc: GOOD_DESC.replace('carefully', 'long'), canonical: `${ORIGIN}/${'very-long-url-segment-'.repeat(6)}end`, body: `<p>${words(210, 'long')}</p>` });
routes['/big'] = () => page({ title: 'A Page With More Than One Megabyte Of HTML', desc: GOOD_DESC.replace('carefully', 'big'), canonical: `${ORIGIN}/big`, body: `<p>${words(210, 'big')}</p><!-- ${'x'.repeat(1_200_000)} -->` });
routes['/huge'] = () => page({ title: 'A Page With More Than Five Megabytes Of HTML', desc: GOOD_DESC.replace('carefully', 'huge'), canonical: `${ORIGIN}/huge`, body: `<p>${words(210, 'huge')}</p><!-- ${'y'.repeat(5_500_000)} -->` });
// Character-encoding fixtures: the declared (or undeclared) encoding differs per page.
const encHtml = (title, body = '', meta = '') => `<!doctype html><html lang="en"><head>${meta}<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const encFixtures = {
    '/enc/index': { type: 'text/html; charset=utf-8', body: Buffer.from(encHtml('Encoding Index Page For The Fixture Site Tests', '<a href="/enc/header-only">a</a> <a href="/enc/latin1-meta">b</a> <a href="/enc/no-decl-utf8">c</a> <a href="/enc/no-decl-latin1">d</a> <a href="/enc/latin1-header">e</a> <a href="/enc/caf\u00e9-\u65e5\u672c">f</a>'), 'utf8') },
    '/enc/header-only': { type: 'text/html;charset=utf-8', body: Buffer.from(encHtml('Zw\u00f6lf gro\u00dfe Boxk\u00e4mpfer \u2013 \u65e5\u672c\u8a9e', '<a href="/enc/caf\u00e9-\u65e5\u672c">Caf\u00e9</a>'), 'utf8') },
    '/enc/caf\u00e9-\u65e5\u672c': { type: 'text/html; charset=UTF-8', body: Buffer.from(encHtml('Caf\u00e9 \u65e5\u672c target'), 'utf8') },
    '/enc/latin1-meta': { type: 'text/html', body: Buffer.from(encHtml('Caf\u00e9 cr\u00e8me \u00e0 la fran\u00e7aise', '', '<meta charset="iso-8859-1">'), 'latin1') },
    '/enc/no-decl-utf8': { type: 'text/html', body: Buffer.from(encHtml('\u00dcn\u00efc\u00f6d\u00e9 sans d\u00e9claration'), 'utf8') },
    '/enc/no-decl-latin1': { type: 'text/html', body: Buffer.from(encHtml('Caf\u00e9 sans d\u00e9claration'), 'latin1') },
    '/enc/latin1-header': { type: 'text/html; charset=ISO-8859-1', body: Buffer.from(encHtml('Se\u00f1or M\u00fcller'), 'latin1') },
};
const redirects = { '/old': [301, '/about'], '/chain1': [301, '/chain2'], '/chain2': [302, '/about'], '/temp': [302, '/about'], '/loop-a': [301, '/loop-b'], '/loop-b': [301, '/loop-a'] };

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, ORIGIN);
    const path = u.pathname;
    globalThis.hits = (globalThis.hits || 0) + 1;
    if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`User-agent: *\nDisallow: /private/\n\nUser-agent: Googlebot\nDisallow: /no-google/\n\nSitemap: ${ORIGIN}/sitemap.xml\n${process.env.SLOW_SITEMAPS ? `Sitemap: ${ORIGIN}/slow-sitemap-1.xml\nSitemap: ${ORIGIN}/slow-sitemap-2.xml\nSitemap: ${ORIGIN}/slow-sitemap-3.xml\nSitemap: ${ORIGIN}/slow-sitemap-4.xml\nSitemap: ${ORIGIN}/slow-sitemap-5.xml\nSitemap: ${ORIGIN}/slow-sitemap-6.xml\n` : ''}`);
    }
    if (path.startsWith('/slow-sitemap-')) {
        await new Promise((r) => setTimeout(r, 6000));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`);
    }
    if (path === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        const urls = ['/', '/about', '/orphan', '/noindex-page', '/gone', '/old', '/dup-a'];
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`);
    }
    if (redirects[path]) {
        res.writeHead(redirects[path][0], { location: redirects[path][1] });
        return res.end();
    }
    if (path === '/gone') {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html><head><title>Not found</title></head><body>404</body></html>');
    }
    if (path === '/error500') {
        res.writeHead(500, { 'content-type': 'text/html' });
        return res.end('<html><body>boom</body></html>');
    }
    if (path === '/download') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.alloc(2048));
    }
    if (path.startsWith('/enc/')) {
        const enc = encFixtures[decodeURIComponent(path)];
        if (enc) {
            res.writeHead(200, { 'content-type': enc.type });
            return res.end(enc.body);
        }
    }
    if (path === '/blocked') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html><body>Forbidden</body></html>');
    }
    const route = routes[path];
    if (!route) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html><body>404</body></html>');
    }
    const html = route();
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (path === '/xrobots') headers['x-robots-tag'] = 'noindex';
    if (path === '/slow') await new Promise((r) => setTimeout(r, 1800));
    if (path === '/gzip') {
        headers['content-encoding'] = 'gzip';
        res.writeHead(200, headers);
        return res.end(gzipSync(html));
    }
    res.writeHead(200, headers);
    return res.end(html);
});
server.listen(PORT, () => console.log(`fixture on ${ORIGIN}`));
