// capture-proxy.js — Transparent capture proxy for Windsurf ↔ Codeium traffic
//
// Forwards ALL requests to real Codeium servers while logging full protobuf
// request/response bodies. Saves raw bytes for later analysis.
//
// Usage: node src/capture-proxy.js
//   Then sign into Windsurf with real Pro account, trigger searches, etc.
//   All traffic is captured to ./captures/

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFields, writeStringField, writeBytesField, writeVarintField } from './proto.js';
import { tryGunzip, wrapUnary } from './connect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = path.join(__dirname, '..', 'captures');
const PORT = 3000;

// Real Codeium servers
const REAL_API_HOST = 'server.codeium.com';
const REAL_WEBSITE = 'windsurf.com';
const REAL_REGISTER_HOST = 'register.windsurf.com';
const REAL_UNLEASH_HOST = 'unleash.codeium.com';

let captureId = 0;

// ─── Protobuf decoder (recursive, 3 levels deep) ────────────

function decodeProtoFields(buf, depth = 0, maxDepth = 3) {
  if (!buf || buf.length === 0 || depth >= maxDepth) return [];
  try {
    const fields = parseFields(buf);
    return fields.map(f => {
      const entry = { field: f.field, wireType: f.wireType };
      if (f.wireType === 0) {
        entry.value = f.value;
        entry.display = `${f.value}`;
      } else if (f.wireType === 2) {
        const str = f.value.toString('utf8');
        const isPrintable = str.length > 0 && str.length < 500 && /^[\x20-\x7e\n\r\t]+$/.test(str);
        if (isPrintable) {
          entry.value = str;
          entry.display = str.length > 120 ? str.slice(0, 120) + '...' : str;
          entry.type = 'string';
        } else {
          entry.type = 'bytes';
          entry.length = f.value.length;
          entry.hex = f.value.toString('hex').slice(0, 80);
          // Try as nested message
          const nested = decodeProtoFields(f.value, depth + 1, maxDepth);
          if (nested.length > 0 && nested.length < 50) {
            entry.nested = nested;
          }
        }
      } else if (f.wireType === 5) {
        entry.value = f.value.toString('hex');
        entry.type = 'fixed32';
        // Try as float32
        entry.float = f.value.readFloatLE(0);
      } else if (f.wireType === 1) {
        entry.value = f.value.toString('hex');
        entry.type = 'fixed64';
      }
      return entry;
    });
  } catch {
    return [];
  }
}

function formatProtoTree(fields, indent = '    ') {
  const lines = [];
  for (const f of fields) {
    if (f.wireType === 0) {
      lines.push(`${indent}field ${f.field} (varint): ${f.value}`);
    } else if (f.wireType === 2) {
      if (f.type === 'string') {
        lines.push(`${indent}field ${f.field} (string/${f.value.length}b): ${f.display}`);
      } else {
        lines.push(`${indent}field ${f.field} (bytes/${f.length}b): ${f.hex}`);
        if (f.nested) {
          lines.push(`${indent}  [nested ${f.nested.length} fields]`);
          lines.push(...formatProtoTree(f.nested, indent + '    '));
        }
      }
    } else if (f.wireType === 5) {
      lines.push(`${indent}field ${f.field} (fixed32): 0x${f.value} (float: ${f.float})`);
    } else if (f.wireType === 1) {
      lines.push(`${indent}field ${f.field} (fixed64): 0x${f.value}`);
    }
  }
  return lines;
}

// ─── Unwrap protobuf from Connect-RPC body ────────────────

function unwrapBody(body, headers) {
  const contentEncoding = headers?.['connect-content-encoding'] || headers?.['content-encoding'] || '';
  let buf = body;

  // HTTP-level gzip
  if (contentEncoding.includes('gzip')) {
    const d = tryGunzip(buf);
    if (d) buf = d;
  }

  // Connect-RPC envelope
  if (buf.length > 5) {
    const flags = buf[0];
    const msgLen = buf.readUInt32BE(1);
    if (msgLen === buf.length - 5 && flags <= 1) {
      let payload = buf.slice(5);
      if (flags === 1) {
        const d = tryGunzip(payload);
        if (d) payload = d;
      }
      return payload;
    }
  }

  return buf;
}

// ─── Unwrap streaming response (multiple envelopes) ────────

function unwrapStreamEnvelopes(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + len > buf.length) break;
    let payload = buf.slice(offset, offset + len);
    offset += len;

    if (flags === 2 || flags === 3) {
      // End-of-stream (JSON trailers)
      if (flags === 3) {
        const d = tryGunzip(payload);
        if (d) payload = d;
      }
      messages.push({ type: 'eos', flags, data: payload.toString('utf8') });
    } else {
      if (flags === 1) {
        const d = tryGunzip(payload);
        if (d) payload = d;
      }
      messages.push({ type: 'message', flags, data: payload });
    }
  }
  return messages;
}

// ─── Rewrite RegisterUser response ─────────────────────────
// Replace api_server_url (field 3) so extension keeps talking to us

function rewriteRegisterUser(protoBuf) {
  try {
    const fields = parseFields(protoBuf);
    // Rebuild: keep field 1 (api_key), field 2 (name), rewrite field 3 (api_server_url)
    const parts = [];
    for (const f of fields) {
      if (f.field === 3 && f.wireType === 2) {
        // Replace server URL with our proxy
        const origUrl = f.value.toString('utf8');
        console.log(`  🔄 REWRITE RegisterUser field 3: ${origUrl} → http://localhost:${PORT}`);
        parts.push(writeStringField(3, `http://localhost:${PORT}`));
      } else if (f.wireType === 0) {
        parts.push(Buffer.concat([
          Buffer.from([(f.field << 3) | 0]),
          encodeVarintBuf(f.value),
        ]));
      } else if (f.wireType === 2) {
        parts.push(writeBytesField(f.field, f.value));
      } else if (f.wireType === 1) {
        const tag = Buffer.from([(f.field << 3) | 1]);
        parts.push(Buffer.concat([tag, f.value]));
      } else if (f.wireType === 5) {
        const tag = Buffer.from([(f.field << 3) | 5]);
        parts.push(Buffer.concat([tag, f.value]));
      }
    }
    return Buffer.concat(parts);
  } catch (e) {
    console.error(`  ❌ RegisterUser rewrite failed: ${e.message}`);
    return protoBuf;
  }
}

function encodeVarintBuf(value) {
  const bytes = [];
  let v = BigInt(value);
  if (v < 0n) v = v + (1n << 64n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

// ─── Get RPC method name from URL ──────────────────────────

function getRpcMethod(url) {
  const parts = url.split('/');
  return parts[parts.length - 1] || '';
}

// ─── Route to correct upstream host ────────────────────────

function getUpstreamHost(url) {
  if (url.includes('unleash') || url.includes('experiment_config')) {
    return REAL_UNLEASH_HOST;
  }
  // Auth and seat management RPCs may need register server
  // But try API server first — real Codeium routes everything through one host
  return REAL_API_HOST;
}

// ─── Strip /_route/api_server prefix ───────────────────────
// Windsurf Secure adds this prefix when serviceUrl is set,
// but real server.codeium.com doesn't use it.

function getUpstreamPath(url) {
  return url.replace(/^\/_route\/api_server/, '');
}

// ─── Save capture to disk ──────────────────────────────────

function saveCapture(id, method, data) {
  const dir = path.join(CAPTURES_DIR, `${String(id).padStart(4, '0')}_${method}`);
  fs.mkdirSync(dir, { recursive: true });

  if (data.reqRaw) fs.writeFileSync(path.join(dir, 'request.bin'), data.reqRaw);
  if (data.reqProto) fs.writeFileSync(path.join(dir, 'request.proto.bin'), data.reqProto);
  if (data.resRaw) fs.writeFileSync(path.join(dir, 'response.bin'), data.resRaw);
  if (data.resProto) fs.writeFileSync(path.join(dir, 'response.proto.bin'), data.resProto);
  if (data.resStreamMessages) {
    data.resStreamMessages.forEach((msg, i) => {
      if (msg.type === 'message') {
        fs.writeFileSync(path.join(dir, `stream_${i}.proto.bin`), msg.data);
      }
    });
  }

  // Save human-readable log
  fs.writeFileSync(path.join(dir, 'log.txt'), data.log || '');
}

// ─── Main request handler ──────────────────────────────────

function handleRequest(req, res) {
  const id = ++captureId;
  const ts = new Date().toISOString().slice(11, 23);
  const method = getRpcMethod(req.url);
  const upstream = getUpstreamHost(req.url);
  let logLines = [];

  const log = (msg) => {
    const line = `[${ts}] #${id} ${msg}`;
    console.log(line);
    logLines.push(line);
  };

  // Handle web page requests — redirect to real windsurf.com
  if (req.url.startsWith('/profile') || req.url.startsWith('/login') ||
      req.url.startsWith('/signup') || req.url.startsWith('/redirect/') ||
      req.url.startsWith('/changelog') || req.url === '/favicon.ico') {
    log(`🔗 WEB REDIRECT → https://${REAL_WEBSITE}${req.url}`);
    res.writeHead(302, { location: `https://${REAL_WEBSITE}${req.url}` });
    res.end();
    return;
  }

  // OAuth intercept → redirect to real register server
  if (req.url.includes('prompt=login') || req.url.includes('scope=openid') ||
      req.url.includes('authorize') || req.url.includes('client_id=codeium')) {
    log(`🔑 OAUTH REDIRECT → https://${REAL_REGISTER_HOST}${req.url}`);
    res.writeHead(302, { location: `https://${REAL_REGISTER_HOST}${req.url}` });
    res.end();
    return;
  }

  // Update checks — forward to real server
  if (req.url.includes('/api/update/')) {
    log(`📦 UPDATE CHECK → forwarding`);
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upPath = getUpstreamPath(req.url);
    log(`→ ${req.method} ${upPath.slice(0, 120)} (${body.length}b) → ${upstream}`);

    // Decode request protobuf
    let reqProto = null;
    if (body.length > 0) {
      try {
        reqProto = unwrapBody(body, req.headers);
        const fields = decodeProtoFields(reqProto);
        if (fields.length > 0) {
          log(`  📤 REQUEST proto (${reqProto.length}b):`);
          formatProtoTree(fields).forEach(l => log(l));
        }
      } catch (e) {
        log(`  📤 REQUEST decode error: ${e.message}`);
      }
    }

    // Forward headers (strip host, add real host)
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders.host;
    delete fwdHeaders.connection;
    fwdHeaders.host = upstream;

    // Determine if this is a streaming RPC
    const STREAMING_METHODS = new Set([
      'GetChatMessage', 'GetStreamingCompletions',
      'GetStreamingExternalChatCompletions',
    ]);
    const isStreamingRpc = STREAMING_METHODS.has(method);

    // Forward to real server (strip /_route/api_server prefix)
    const upstreamPath = getUpstreamPath(req.url);
    const proxyReq = https.request({
      hostname: upstream,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers: fwdHeaders,
    }, (proxyRes) => {

      if (isStreamingRpc) {
        // ── Streaming: pipe through to client in real-time, capture in background ──
        log(`  ← ${proxyRes.statusCode} (STREAMING)`);
        const resHeaders = { ...proxyRes.headers };
        res.writeHead(proxyRes.statusCode, resHeaders);

        const streamChunks = [];
        proxyRes.on('data', (chunk) => {
          streamChunks.push(Buffer.from(chunk));
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          res.end();
          // Decode captured stream after it's done
          const fullRes = Buffer.concat(streamChunks);
          const streamMessages = unwrapStreamEnvelopes(fullRes);
          log(`  📥 STREAM COMPLETE: ${streamMessages.length} envelopes, ${fullRes.length}b total`);
          streamMessages.forEach((msg, i) => {
            if (msg.type === 'eos') {
              log(`    [${i}] EOS: ${msg.data.slice(0, 200)}`);
            } else {
              const fields = decodeProtoFields(msg.data);
              if (fields.length > 0) {
                log(`    [${i}] proto (${msg.data.length}b):`);
                formatProtoTree(fields, '      ').forEach(l => log(l));
              }
            }
          });
          saveCapture(id, method, {
            reqRaw: body, reqProto, resRaw: fullRes,
            resStreamMessages: streamMessages,
            log: logLines.join('\n'),
          });
          log(`  ✅ Stream captured`);
        });

        proxyRes.on('error', (err) => {
          log(`  ❌ Stream error: ${err.message}`);
          if (!res.writableEnded) res.end();
        });

      } else {
        // ── Unary: buffer full response, decode, forward ──
        const resChunks = [];
        proxyRes.on('data', c => resChunks.push(c));
        proxyRes.on('end', () => {
          const resBody = Buffer.concat(resChunks);
          log(`  ← ${proxyRes.statusCode} (${resBody.length}b)`);

          // Decode response
          let resProto = null;

          if (resBody.length > 0) {
            try {
              let decoded = resBody;
              const resEnc = proxyRes.headers['content-encoding'] || '';
              if (resEnc.includes('gzip')) {
                const d = tryGunzip(decoded);
                if (d) decoded = d;
              }
              resProto = decoded;
              const fields = decodeProtoFields(decoded);
              if (fields.length > 0) {
                log(`  📥 RESPONSE proto (${decoded.length}b):`);
                formatProtoTree(fields).forEach(l => log(l));
              } else if (decoded.length > 0) {
                const text = decoded.toString('utf8');
                if (text.length < 1000) {
                  log(`  📥 RESPONSE text: ${text}`);
                }
              }
            } catch (e) {
              log(`  📥 RESPONSE decode error: ${e.message}`);
            }
          }

          saveCapture(id, method, {
            reqRaw: body, reqProto,
            resRaw: resBody, resProto,
            log: logLines.join('\n'),
          });

          // Forward response to Windsurf (rewrite RegisterUser if needed)
          let finalBody = resBody;
          if (method === 'RegisterUser' && proxyRes.statusCode === 200 && resBody.length > 5) {
            try {
              // Unwrap Connect envelope, rewrite proto, re-wrap
              const flags = resBody[0];
              const msgLen = resBody.readUInt32BE(1);
              if (msgLen === resBody.length - 5 && flags <= 1) {
                let payload = resBody.slice(5);
                if (flags === 1) {
                  const d = tryGunzip(payload);
                  if (d) payload = d;
                }
                const rewritten = rewriteRegisterUser(payload);
                // Re-wrap in Connect envelope (uncompressed)
                const envelope = Buffer.alloc(5 + rewritten.length);
                envelope[0] = 0; // no compression
                envelope.writeUInt32BE(rewritten.length, 1);
                rewritten.copy(envelope, 5);
                finalBody = envelope;
                log(`  🔄 RegisterUser response rewritten (${resBody.length}b → ${finalBody.length}b)`);
              }
            } catch (e) {
              log(`  ❌ RegisterUser rewrite error: ${e.message}`);
            }
          }
          const resHeaders = { ...proxyRes.headers };
          delete resHeaders['content-length']; // recalc
          resHeaders['content-length'] = finalBody.length;
          res.writeHead(proxyRes.statusCode, resHeaders);
          res.end(finalBody);
        });

        proxyRes.on('error', (err) => {
          log(`  ❌ Upstream response error: ${err.message}`);
          if (!res.headersSent) res.writeHead(502);
          if (!res.writableEnded) res.end(`Upstream error: ${err.message}`);
        });
      }
    });

    proxyReq.on('error', (err) => {
      log(`  ❌ Upstream connection error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end(`Connection error: ${err.message}`);
    });

    proxyReq.end(body);
  });
}

// ─── Server ────────────────────────────────────────────────

fs.mkdirSync(CAPTURES_DIR, { recursive: true });

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n🔮 Windsurf CAPTURE PROXY on http://localhost:${PORT}`);
  console.log(`   Forwarding to:`);
  console.log(`     API     → https://${REAL_API_HOST}`);
  console.log(`     Auth    → https://${REAL_REGISTER_HOST}`);
  console.log(`     Flags   → https://${REAL_UNLEASH_HOST}`);
  console.log(`\n   Captures saved to: ${CAPTURES_DIR}/`);
  console.log(`\n   Instructions:`);
  console.log(`     1. Sign into Windsurf with Pro account`);
  console.log(`     2. Open a workspace with code`);
  console.log(`     3. Use codebase_search in Cascade`);
  console.log(`     4. Check captures/ for all traffic\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use. Kill existing process first.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
