// handlers/chat.js — GetChatMessage handler (orchestrator)
//
// Parses Windsurf's protobuf request → calls Anthropic Messages API → streams
// back Connect-RPC protobuf using the correct exa.api_server_pb schema.

import https from 'node:https';
import crypto from 'node:crypto';
import { parseGetChatMessageRequest } from './parse-request.js';
import { buildErrorChunk } from './build-response.js';
import { AnthropicStreamProcessor, parseSSEChunk } from './anthropic-stream.js';
import { wrapEnvelope, endOfStreamEnvelope, streamHeaders } from '../connect.js';

// ─── Config ────────────────────────────────────────────────

const API_HOST = process.env.ANTHROPIC_API_HOST || 'api.anthropic.com';
const API_PATH = process.env.ANTHROPIC_API_PATH || '/v1/messages';
const API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL  || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '16384', 10);

// Map Windsurf model IDs → Anthropic model names
const MODEL_MAP = {
  'MODEL_SWE_1_5':           DEFAULT_MODEL,
  'MODEL_SWE_1_5_SLOW':      DEFAULT_MODEL,
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': DEFAULT_MODEL,
  'gpt-5-4-low':             DEFAULT_MODEL,
  'gpt-5-4-high':            DEFAULT_MODEL,
  'MODEL_CHAT_11121':        DEFAULT_MODEL,
  // Windsurf internal models (sub-tasks, summarization)
  'MODEL_GOOGLE_GEMINI_2_5_FLASH': DEFAULT_MODEL,
  'MODEL_GOOGLE_GEMINI_2_5_PRO':   DEFAULT_MODEL,
  'MODEL_GPT_4O':            DEFAULT_MODEL,
  'MODEL_GPT_4O_MINI':       DEFAULT_MODEL,
};

// ─── Main handler ──────────────────────────────────────────

export function handleGetChatMessage(req, res, body) {
  if (!API_KEY) {
    console.error('  ❌ ANTHROPIC_API_KEY not set — cannot forward to API');
    res.writeHead(500);
    res.end('ANTHROPIC_API_KEY not configured');
    return;
  }

  const { systemPrompt, messages, tools, toolChoice, requestedModel, initiator } =
    parseGetChatMessageRequest(body, req.headers);

  const anthropicModel = MODEL_MAP[requestedModel] || DEFAULT_MODEL;
  const messageId = crypto.randomUUID();

  console.log(`  🧠 Model: ${requestedModel} → ${anthropicModel}`);
  console.log(`  📝 System prompt: ${systemPrompt.length} chars`);
  console.log(`  💬 Messages: ${messages.length}`);
  if (tools) console.log(`  🔧 Tools: ${tools.length}`);
  if (toolChoice) console.log(`  🔧 ToolChoice: ${JSON.stringify(toolChoice)}`);

  // Log first/last message roles for debugging
  if (messages.length > 0) {
    const roles = messages.map(m => m.role).join(',');
    console.log(`  💬 Roles: ${roles}`);
    // Warn if consecutive same-role (should never happen after merge)
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === messages[i-1].role) {
        console.warn(`  ⚠️  Consecutive ${messages[i].role} at index ${i-1},${i} — merge failed?`);
      }
    }
    // Check for tool_result messages
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') console.log(`  🔧 ToolResult: id=${b.tool_use_id}, err=${b.is_error || false}, content=${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200)}`);
          if (b.type === 'tool_use') console.log(`  🔧 ToolUse: name=${b.name}, id=${b.id}`);
        }
      }
    }
  }

  // Build Anthropic API request
  const apiPayload = {
    model: anthropicModel,
    system: systemPrompt || undefined,
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
  };

  // Pass through tool definitions if present
  if (tools && tools.length > 0) {
    apiPayload.tools = tools;
    if (toolChoice) apiPayload.tool_choice = toolChoice;
  }

  // Initiator is pre-computed from the ORIGINAL (pre-merge) last message
  // so tool_result-only rounds stay classified as 'agent' (free)
  const lastMsg = messages[messages.length - 1];
  console.log(`  💰 Initiator: ${initiator} (last msg: role=${lastMsg?.role}, blocks=${Array.isArray(lastMsg?.content) ? lastMsg.content.map(b=>b.type).join(',') : 'string'})`);

  const apiBody = JSON.stringify(apiPayload);

  // Write streaming response headers
  res.writeHead(200, streamHeaders());

  // Create stream processor
  const processor = new AnthropicStreamProcessor(messageId, anthropicModel);

  // Call Anthropic API
  const apiReq = https.request({
    hostname: API_HOST,
    port: 443,
    path: API_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'x-api-key': API_KEY,
      'content-length': Buffer.byteLength(apiBody),
    },
  }, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ API returned ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => errBody += d);
      apiRes.on('end', () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 500)}`);
        res.write(wrapEnvelope(buildErrorChunk(messageId, `[API Error ${apiRes.statusCode}]`)));
        res.write(endOfStreamEnvelope());
        res.end();
      });
      return;
    }

    apiRes.setEncoding('utf8');

    function processPart(part) {
      const events = parseSSEChunk(part + '\n\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        console.log(`  ✅ Stream done (stop: ${processor.stopReason})`);
      }
    }

    apiRes.on('data', (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) processPart(part);
    });

    apiRes.on('end', () => {
      if (sseBuffer.trim()) processPart(sseBuffer);
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        console.log(`  ✅ Stream ended`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ API stream error: ${err.message}`);
      if (!res.writableEnded) {
        res.write(wrapEnvelope(buildErrorChunk(messageId, `[Stream Error]`)));
        res.write(endOfStreamEnvelope());
        res.end();
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error(`  ❌ API request error: ${err.message}`);
    if (!res.writableEnded) {
      res.write(wrapEnvelope(buildErrorChunk(messageId, `[Connection Error]`)));
      res.write(endOfStreamEnvelope());
      res.end();
    }
  });

  // Abort upstream API call if client disconnects mid-stream (saves tokens)
  // Use res.on('close') — fires when the RESPONSE socket drops, meaning the
  // client actually disconnected. req.on('close') fires too early (after request
  // body is consumed) and would kill the API request before it even responds.
  res.on('close', () => {
    if (!res.writableEnded && !apiReq.destroyed) {
      console.log(`  🔌 Client disconnected mid-stream, aborting API call`);
      apiReq.destroy();
    }
  });

  apiReq.end(apiBody);
}
