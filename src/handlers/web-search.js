// handlers/web-search.js — GetWebSearchResults + GetWebSearchRedirect handlers
//
// Performs real web searches via DuckDuckGo HTML scraping (no API key needed)
// and handles URL redirects for GetWebSearchRedirect.
//
// Proto schemas (decoded from Go binary file descriptors):
//
//   GetWebSearchResultsRequest {
//     Metadata metadata = 1;
//     string query = 2;
//     uint32 limit = 3;
//     string domain = 4;
//     ThirdPartyWebSearchConfig third_party_config = 5;
//   }
//
//   GetWebSearchResultsResponse {
//     repeated KnowledgeBaseItem results = 1;
//     string web_search_url = 2;
//     string summary = 3;
//   }
//
//   KnowledgeBaseItem {
//     string identifier = 1;
//     ConnectorType connector_type = 2;  // varint enum
//     string url = 3;
//     string title = 4;
//     string description = 5;
//     string content = 6;
//     Timestamp last_crawled_at = 7;
//     string user_name = 8;
//   }
//
//   GetWebSearchRedirectRequest {
//     string original_url = 1;
//   }
//
//   GetWebSearchRedirectResponse {
//     string redirect_url = 1;
//   }

import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import {
  writeStringField, writeVarintField, writeMessageField,
  parseFields, getField,
} from '../proto.js';
import { wrapUnary, unaryHeaders, unwrapRequest } from '../connect.js';

// ─── DuckDuckGo HTML search ───────────────────────────────

function searchDuckDuckGo(query, maxResults = 8) {
  return new Promise((resolve, reject) => {
    const postData = `q=${encodeURIComponent(query)}`;

    const req = https.request({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(postData),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const results = parseDDGResults(body, maxResults);
          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('DDG timeout')); });
    req.end(postData);
  });
}

function parseDDGResults(html, maxResults) {
  const results = [];

  // DuckDuckGo HTML results have class="result results_links results_links_deep web-result"
  // Each contains: <a class="result__a" href="...">Title</a>
  //                <a class="result__snippet" ...>Snippet</a>
  const resultRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  // Collect all title/URL matches
  const titleMatches = [];
  let m;
  while ((m = resultRegex.exec(html)) !== null) {
    titleMatches.push({ url: m[1], rawTitle: m[2] });
  }

  // Collect all snippets
  const snippets = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(m[1]);
  }

  for (let i = 0; i < titleMatches.length && results.length < maxResults; i++) {
    let { url, rawTitle } = titleMatches[i];

    // DDG wraps URLs in redirects — extract actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Strip all HTML tags and decode entities
    const title = stripHtml(rawTitle);
    const snippet = i < snippets.length ? stripHtml(snippets[i]) : '';

    if (url && title && !url.startsWith('/') && url.startsWith('http')) {
      let faviconUrl = '';
      try {
        const parsed = new URL(url);
        faviconUrl = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
      } catch { /* ignore */ }

      results.push({ title, url, snippet, faviconUrl });
    }
  }

  return results;
}

function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── URL redirect resolver ───────────────────────────────

function resolveRedirectUrl(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return resolve(targetUrl);
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, (res) => {
      res.resume(); // drain
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).toString();
        resolveRedirectUrl(next, maxRedirects - 1).then(resolve, reject);
      } else {
        resolve(targetUrl);
      }
    });

    req.on('error', () => resolve(targetUrl)); // on error, return what we have
    req.setTimeout(5000, () => { req.destroy(); resolve(targetUrl); });
    req.end();
  });
}

// ─── URL content fetcher ──────────────────────────────────

function fetchUrlContent(targetUrl, maxBytes = 50000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        res.resume();
        return fetchUrlContent(redirectUrl, maxBytes).then(resolve, reject);
      }

      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', d => {
        bytes += Buffer.byteLength(d);
        if (bytes <= maxBytes) body += d;
      });
      res.on('end', () => {
        // Strip HTML tags, collapse whitespace → plain text
        const text = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30000); // cap at 30k chars
        resolve(text);
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Fetch timeout')); });
    req.end();
  });
}

// ─── Proto builders ───────────────────────────────────────

function buildKnowledgeBaseItem(result) {
  // exa.codeium_common_pb.KnowledgeBaseItem (from chat-client JS proto definition):
  //   string document_id = 1;
  //   string text = 2;         // page content / snippet
  //   string url = 3;
  //   string title = 4;
  //   Timestamp timestamp = 5; // optional
  //   repeated Chunk chunks = 6; // optional
  //   string summary = 7;
  //   Image image = 8; // optional
  //   DomTree dom_tree = 9; // optional
  const parts = [
    writeStringField(1, result.identifier || crypto.randomUUID()),
    writeStringField(2, result.content || result.snippet || ''), // text
    writeStringField(3, result.url),
    writeStringField(4, result.title),
    // skip field 5 (timestamp) — optional
    // skip field 6 (chunks) — optional
    writeStringField(7, result.snippet || ''),  // summary
  ];
  return Buffer.concat(parts);
}

function buildSearchResponse(results, query) {
  // GetWebSearchResultsResponse {
  //   repeated KnowledgeBaseItem results = 1;
  //   string web_search_url = 2;
  //   string summary = 3;
  // }
  const parts = results.map(r => writeMessageField(1, buildKnowledgeBaseItem(r)));
  parts.push(writeStringField(2, `https://duckduckgo.com/?q=${encodeURIComponent(query)}`));
  return Buffer.concat(parts);
}

function buildRedirectResponse(redirectUrl) {
  // GetWebSearchRedirectResponse { string redirect_url = 1 }
  return writeStringField(1, redirectUrl);
}

// ─── Response sender (handles gzip negotiation) ─────────

function sendProtoResponse(req, res, proto) {
  // Use gzip like all other endpoints — the framing is confirmed working
  const respBody = wrapUnary(proto);
  res.writeHead(200, { ...unaryHeaders(), 'content-length': respBody.length });
  res.end(respBody);
}

// ─── Handlers ─────────────────────────────────────────────

export function handleGetWebSearchResults(req, res, body) {
  // Log request headers (compact)
  const hdrs = req.headers;
  console.log(`  🔍 WebSearch headers: accept-enc="${hdrs['accept-encoding'] || ''}" connect-accept-enc="${hdrs['connect-accept-encoding'] || ''}" content-enc="${hdrs['content-encoding'] || ''}"`);

  // Decode request
  let query = '';
  if (body && body.length > 0) {
    try {
      const protoBuf = unwrapRequest(body, hdrs);
      const fields = parseFields(protoBuf);
      const queryField = getField(fields, 2, 2);
      if (queryField) query = queryField.value.toString('utf8');
    } catch (e) {
      console.log(`  🔍 WebSearch parse error: ${e.message}`);
    }
  }

  if (!query) {
    console.log(`  🔍 WebSearch: empty query`);
    return sendProtoResponse(req, res, Buffer.alloc(0));
  }

  console.log(`  🔍 WebSearch: "${query}"`);

  // Perform async search
  searchDuckDuckGo(query)
    .then(async (results) => {
      console.log(`  🔍 WebSearch: ${results.length} results for "${query}"`);

      // Fetch content for top results to populate the 'text' field
      const contentPromises = results.slice(0, 5).map(r =>
        fetchUrlContent(r.url).then(text => { r.content = text; }).catch(() => {})
      );
      await Promise.allSettled(contentPromises);

      const proto = buildSearchResponse(results, query);
      console.log(`  🔍 WebSearch response: ${proto.length}b, ${results.length} results`);
      sendProtoResponse(req, res, proto);
    })
    .catch(err => {
      console.error(`  ❌ WebSearch error: ${err.message}`);
      sendProtoResponse(req, res, Buffer.alloc(0));
    });
}

export function handleGetWebSearchRedirect(req, res, body) {
  let targetUrl = '';
  if (body && body.length > 0) {
    try {
      const protoBuf = unwrapRequest(body, req.headers);
      const fields = parseFields(protoBuf);
      const urlField = getField(fields, 1, 2);
      if (urlField) targetUrl = urlField.value.toString('utf8');
    } catch (e) {
      console.log(`  🔍 WebRedirect parse error: ${e.message}`);
    }
  }

  if (!targetUrl) {
    console.log(`  🔍 WebRedirect: empty URL`);
    return sendProtoResponse(req, res, Buffer.alloc(0));
  }

  console.log(`  🔍 WebRedirect: ${targetUrl}`);

  resolveRedirectUrl(targetUrl)
    .then(finalUrl => {
      console.log(`  🔍 WebRedirect: ${targetUrl} → ${finalUrl}`);
      sendProtoResponse(req, res, buildRedirectResponse(finalUrl));
    })
    .catch(err => {
      console.error(`  ❌ WebRedirect error: ${err.message}`);
      sendProtoResponse(req, res, buildRedirectResponse(targetUrl));
    });
}
