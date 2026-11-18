# Technical SEO Audit & Site Crawler

> **Run it on Apify:** [apify.com/sitegauge/seo-audit-crawler](https://apify.com/sitegauge/seo-audit-crawler). Nothing to install, and you pay per result. This repository holds the Actor's full source code under the MIT licence.

Crawl a website and get a technical and on-page SEO audit of every URL: **57 checks**, cross-page analysis, a 0 to 100 score per page, and a shareable HTML report.

Point it at a homepage and it follows internal links and XML sitemaps, then tells you what is broken, what is duplicated and what search engines cannot index, with a plain-English fix for each issue.

## Who it is for

- **SEO agencies and freelancers** who need a fast first-pass audit for a pitch or a monthly health check.
- **Developers and site owners** who want to catch broken links, redirect chains and accidental `noindex` tags before or after a release.
- **AI agents and automations** that need structured audit data (JSON, CSV, Excel) instead of a PDF.

## What you get

1. **One dataset row per URL** with status code, indexability, title, description, headings, canonical, hreflang, word count, response time, link counts, structured data types, a score, and a list of issues with severity and how to fix each one.
2. **A site summary** (`OUTPUT` in the key-value store): overall score, status code counts, every issue with counts and example URLs, robots.txt and sitemap findings.
3. **An HTML report** (`REPORT` in the key-value store) you can open in a browser, print to PDF or send to a client.

## What it checks

| Area | Checks |
|---|---|
| **Crawlability** | 4xx and 5xx pages, failed requests, redirect chains and loops, temporary redirects, URLs blocked for Googlebot in robots.txt, slow responses, missing compression, oversized HTML |
| **Indexability** | `noindex` in meta tags and `X-Robots-Tag`, canonical missing, conflicting, pointing elsewhere or pointing at a broken URL, `nofollow` directives |
| **Internal links** | Links to broken pages, links to redirecting URLs, orphan pages, click depth, links without anchor text |
| **Sitemaps** | Non-200 URLs in the sitemap, `noindex` pages in the sitemap, indexable pages missing from it, missing sitemap or robots.txt |
| **Titles and descriptions** | Missing, too long, too short, multiple, duplicated across pages |
| **Headings and content** | Missing or multiple H1, skipped heading levels, thin content, identical page text, images without alt |
| **International** | Invalid hreflang codes, missing return links, missing self-reference, missing `lang` attribute |
| **Markup** | Invalid JSON-LD, missing structured data, missing viewport, missing charset, mixed content, Open Graph and Twitter card tags |
| **URLs** | HTTP instead of HTTPS, very long URLs, uppercase letters, underscores, query parameters on indexable pages |

Cross-page checks (duplicates, broken internal links, redirect chains, orphan pages, hreflang return links, canonical targets) are calculated after the crawl, using every URL audited in the run.

## How to use it

1. Enter one or more **Start URLs**, usually the homepage.
2. Set **Maximum URLs to audit**. Start with 100 to get a feel for the output.
3. Run the Actor. Open the **Output** tab for the table, or the key-value store for the `REPORT` and `OUTPUT` records.

### Input options

| Field | What it does | Default |
|---|---|---|
| `startUrls` | Where the audit starts | required |
| `maxPages` | Stop after this many URLs | 100 |
| `crawlScope` | `hostname`, `domain` (include subdomains), `path` (stay in the start folder) or `listOnly` (audit only the URLs given) | `hostname` |
| `useSitemap` | Read sitemaps from robots.txt and `/sitemap.xml` | `true` |
| `respectRobotsTxt` | Skip disallowed URLs and honour `Crawl-delay` | `true` |
| `maxDepth` | Maximum clicks from a start URL | 20 |
| `maxConcurrency` | Pages fetched in parallel | 5 |
| `includeUrlPatterns` / `excludeUrlPatterns` | Text or `*` wildcard filters | none |
| `userAgent` | Custom User-Agent string | SiteAuditBot |

### Example input

```json
{
    "startUrls": [{ "url": "https://www.example.com/" }],
    "maxPages": 500,
    "excludeUrlPatterns": ["*/tag/*", "?replytocom="]
}
```

## Example output (one row, shortened)

```json
{
    "url": "https://www.example.com/pricing",
    "statusCode": 200,
    "indexable": true,
    "score": 79,
    "errorsCount": 1,
    "warningsCount": 1,
    "noticesCount": 1,
    "issueCodes": ["duplicate_title", "meta_description_missing", "og_missing"],
    "issues": [
        {
            "code": "duplicate_title",
            "severity": "error",
            "message": "Title is duplicated on other indexable pages",
            "howToFix": "Give each indexable page its own title, or canonicalise true duplicates."
        }
    ],
    "title": "Pricing",
    "titleLength": 7,
    "metaDescription": null,
    "h1": ["Simple pricing"],
    "canonical": "https://www.example.com/pricing",
    "canonicalType": "self",
    "wordCount": 412,
    "responseTimeMs": 184,
    "depth": 1,
    "inlinksCount": 37,
    "inSitemap": true,
    "duplicateTitleUrls": ["https://www.example.com/pricing/"],
    "brokenInternalLinks": null
}
```

## Pricing

You pay per result: **$5 per 1,000 URLs audited**, plus Apify's small Actor start fee. Customers on Apify's Starter, Scale and Business plans pay $4.75, $4.50 and $4.00 per 1,000. There is no monthly rental and you do not pay for platform compute separately.

Every URL the crawler fetches produces one result, including redirects and error pages, because each one is checked and reported. Set **Maximum URLs to audit**, or a maximum cost per run in Apify Console, to cap your spend. The Actor never audits more URLs than your limit can pay for.

| Site size | Approximate cost |
|---|---|
| 100 URLs | $0.50 |
| 1,000 URLs | $5 |
| 10,000 URLs | $50 |

## How scores work

Each HTML page starts at 100 and loses 15 points per error, 5 per warning and 1 per notice. The site score is the average of the page scores. Scores are a guide for prioritising work, not a prediction of rankings.

## Good to know

- **HTML is analysed as the server sends it.** Content that JavaScript adds after the page loads is not seen, so single-page apps without server-side rendering will show little content.
- **The crawler is polite.** It identifies itself as `SiteAuditBot`, respects robots.txt by default, honours `Crawl-delay` up to 3 seconds and sends at most about 10 requests per second to one host.
- **If your firewall blocks it,** allowlist the `SiteAuditBot` user agent or set a custom User-Agent that your firewall accepts.
- **Limits:** up to 20,000 URLs per run and 5 MB of HTML per page. For crawls above 5,000 URLs, give the run 2 GB of memory or more.
- **Run timeout:** a run stops at the timeout set in its run options (one hour by default) and saves everything audited up to that point. Raise the timeout for very large or slow sites.
- **Only audit sites you own or are authorised to audit** if you turn off robots.txt handling.
- This is an independent tool. It is not affiliated with or endorsed by any search engine.

## FAQ

**The run finished with errors and warnings in its status. Did something go wrong?**
No. Those numbers are the issues found on the website you audited. A run that completed shows the status Succeeded.

**Can I audit a list of URLs without crawling?**
Yes. Put the URLs in Start URLs and set Crawl scope to "Only the URLs I list".

**Why is a page marked as not indexable?**
See `indexabilityReason`: a non-200 status, a `noindex` directive, or a canonical that points to a different URL.

**Why are some pages flagged as orphans?**
They are listed in the XML sitemap but no audited page links to them. The check only runs when the crawl finishes without hitting the URL limit.

**Does it check external links?**
No. This Actor audits internal URLs. External links are counted but not fetched.

**Can I schedule it?**
Yes. Use Apify schedules to run a weekly or monthly audit and compare the summaries.

## Related tools

- [Broken Link Checker & Bulk URL Status Checker](https://apify.com/sitegauge/broken-link-checker): checks every link on a site, or a list of URLs, and reports the broken ones with the pages that link to them.
- [Website Technology & Tech Stack Detector](https://apify.com/sitegauge/website-technology-detector): finds the CMS, e-commerce platform, analytics, frameworks and other technologies that a list of websites use.

## Feedback

Found a false positive or want a check added? Open an issue on the Issues tab and it will be looked at.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"startUrls": [{"url": "https://crawlee.dev/"}], "maxPages": 25}' > storage/key_value_stores/default/INPUT.json
APIFY_LOCAL_STORAGE_DIR=./storage npm start
```

The rows are written to `storage/datasets/default`, and the report and summary to `storage/key_value_stores/default`.

### Run it against the test fixture

```bash
node test/fixture-server.mjs &
echo '{"startUrls": [{"url": "http://localhost:8089/"}], "maxPages": 200}' > storage/key_value_stores/default/INPUT.json
APIFY_LOCAL_STORAGE_DIR=./storage npm start
```

The fixture is a small site with one page for each kind of problem the audit looks for.

## Licence

MIT. See [LICENSE](LICENSE).
