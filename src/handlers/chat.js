// handlers/chat.js — GetChatMessage handler (orchestrator)
//
// Parses Windsurf's protobuf request → calls Anthropic Messages API → streams
// back Connect-RPC protobuf using the correct exa.api_server_pb schema.

import https from 'node:https';
import crypto from 'node:crypto';
import { parseGetChatMessageRequest } from './parse-request.js';
import { buildErrorChunk } from './build-response.js';
import { AnthropicStreamProcessor, parseSSEChunk } from './anthropic-stream.js';
import { OpenAIStreamProcessor, parseOpenAISSEChunk } from './openai-stream.js';
import { wrapEnvelope, endOfStreamEnvelope, streamHeaders } from '../connect.js';

// ─── Config ────────────────────────────────────────────────

const API_HOST = process.env.ANTHROPIC_API_HOST || 'api.anthropic.com';
const API_PATH = process.env.ANTHROPIC_API_PATH || '/v1/messages';
const API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL  || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '16384', 10);

// OpenAI Responses API config (prompt cache, reasoning, 2h session keep-alive)
const OPENAI_API_HOST = process.env.OPENAI_API_HOST || API_HOST;
const OPENAI_API_PATH = process.env.OPENAI_API_PATH || '/v1/responses';
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY  || API_KEY;

// ─── Provider detection ────────────────────────────────────

// Models that should route through OpenAI Chat Completions API
// Uses prefix matching — any model starting with 'gpt-' or 'MODEL_GPT' goes to OpenAI
const OPENAI_PREFIXES = ['gpt-', 'MODEL_GPT'];

// Map Windsurf model IDs → actual model names
// GPT models go through OpenAI endpoint, Claude models through Anthropic
const MODEL_MAP = {
  // Claude models → Anthropic
  'MODEL_SWE_1_5':           DEFAULT_MODEL,
  'MODEL_SWE_1_5_SLOW':      DEFAULT_MODEL,
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': DEFAULT_MODEL,
  'MODEL_CHAT_11121':        DEFAULT_MODEL,
  'MODEL_GOOGLE_GEMINI_2_5_FLASH': DEFAULT_MODEL,
  'MODEL_GOOGLE_GEMINI_2_5_PRO':   DEFAULT_MODEL,
  // GPT models → OpenAI
  'gpt-5-4-low':             'gpt-5.4',
  'gpt-5-4-high':            'gpt-5.4',
  'gpt-5-4-xhigh':           'gpt-5.4',
  'MODEL_GPT_4O':            'gpt-4o',
  'MODEL_GPT_4O_MINI':       'gpt-4o-mini',
};

function isOpenAIModel(requestedModel) {
  if (!requestedModel) return false;
  return OPENAI_PREFIXES.some(p => requestedModel.startsWith(p));
}

// ─── Main handler ──────────────────────────────────────────

export function handleGetChatMessage(req, res, body) {
  const apiKey = isOpenAIModel(/* peek model before full parse */null) ? OPENAI_API_KEY : API_KEY;
  if (!API_KEY && !OPENAI_API_KEY) {
    console.error('  ❌ No API key set — cannot forward to API');
    res.writeHead(500);
    res.end('No API key configured');
    return;
  }

  let { systemPrompt, messages, tools, toolChoice, requestedModel, initiator } =
    parseGetChatMessageRequest(body, req.headers);

  const useOpenAI = isOpenAIModel(requestedModel);
  const resolvedModel = MODEL_MAP[requestedModel] || DEFAULT_MODEL;
  const messageId = crypto.randomUUID();

  // Inject model identity so the model knows what it is
  const provider = useOpenAI ? 'OpenAI' : 'Anthropic';
  systemPrompt += `\n\nYou are powered by ${resolvedModel} (${provider}).`;

  console.log(`  🧠 Model: ${requestedModel} → ${resolvedModel} (${provider})`);
  console.log(`  📝 System prompt: ${systemPrompt.length} chars`);
  console.log(`  💬 Messages: ${messages.length}`);
  if (tools) console.log(`  🔧 Tools: ${tools.length}`);
  if (toolChoice) console.log(`  🔧 ToolChoice: ${JSON.stringify(toolChoice)}`);

  if (messages.length > 0) {
    const roles = messages.map(m => m.role).join(',');
    console.log(`  💬 Roles: ${roles}`);
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === messages[i-1].role) {
        console.warn(`  ⚠️  Consecutive ${messages[i].role} at index ${i-1},${i} — merge failed?`);
      }
    }
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') console.log(`  🔧 ToolResult: id=${b.tool_use_id}, err=${b.is_error || false}, content=${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200)}`);
          if (b.type === 'tool_use') console.log(`  🔧 ToolUse: name=${b.name}, id=${b.id}`);
        }
      }
    }
  }

  const lastMsg = messages[messages.length - 1];
  console.log(`  💰 Initiator: ${initiator} (last msg: role=${lastMsg?.role}, blocks=${Array.isArray(lastMsg?.content) ? lastMsg.content.map(b=>b.type).join(',') : 'string'})`);

  if (useOpenAI) {
    streamOpenAI(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId });
  } else {
    streamAnthropic(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId });
  }
}

// ─── Anthropic streaming ────────────────────────────────────

function streamAnthropic(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId }) {
  const apiPayload = {
    model: resolvedModel,
    system: systemPrompt || undefined,
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) {
    apiPayload.tools = tools;
    if (toolChoice) apiPayload.tool_choice = toolChoice;
  }

  const apiBody = JSON.stringify(apiPayload);
  res.writeHead(200, streamHeaders());
  const processor = new AnthropicStreamProcessor(messageId, resolvedModel);

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
      console.error(`  ❌ Anthropic API returned ${apiRes.statusCode}`);
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
      console.error(`  ❌ Anthropic stream error: ${err.message}`);
      if (!res.writableEnded) {
        res.write(wrapEnvelope(buildErrorChunk(messageId, `[Stream Error]`)));
        res.write(endOfStreamEnvelope());
        res.end();
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error(`  ❌ Anthropic request error: ${err.message}`);
    if (!res.writableEnded) {
      res.write(wrapEnvelope(buildErrorChunk(messageId, `[Connection Error]`)));
      res.write(endOfStreamEnvelope());
      res.end();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded && !apiReq.destroyed) {
      console.log(`  🔌 Client disconnected mid-stream, aborting Anthropic call`);
      apiReq.destroy();
    }
  });

  apiReq.end(apiBody);
}

// ─── OpenAI Responses API streaming ─────────────────────────

function streamOpenAI(req, res, { systemPrompt, messages, tools, toolChoice, resolvedModel, messageId }) {
  // Convert Anthropic-format messages to OpenAI format
  const openaiMessages = toOpenAIMessages(systemPrompt, messages);

  // Responses API payload — uses `input` instead of `messages`
  const apiPayload = {
    model: resolvedModel,
    input: openaiMessages,
    stream: true,
    reasoning: { effort: 'high', summary: 'auto' },
  };
  if (tools && tools.length > 0) {
    apiPayload.tools = tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: typeof t.input_schema === 'string' ? JSON.parse(t.input_schema) : t.input_schema,
    }));
    if (toolChoice) {
      if (toolChoice.type === 'auto') apiPayload.tool_choice = 'auto';
      else if (toolChoice.type === 'any') apiPayload.tool_choice = 'required';
      else if (toolChoice.type === 'tool') apiPayload.tool_choice = { type: 'function', name: toolChoice.name };
    }
  }

  const apiBody = JSON.stringify(apiPayload);
  res.writeHead(200, streamHeaders());
  const processor = new OpenAIStreamProcessor(messageId, resolvedModel);

  const apiReq = https.request({
    hostname: OPENAI_API_HOST,
    port: 443,
    path: OPENAI_API_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'authorization': `Bearer ${OPENAI_API_KEY}`,
      'content-length': Buffer.byteLength(apiBody),
    },
  }, (apiRes) => {
    let sseBuffer = '';

    if (apiRes.statusCode !== 200) {
      console.error(`  ❌ OpenAI API returned ${apiRes.statusCode}`);
      let errBody = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', d => errBody += d);
      apiRes.on('end', () => {
        console.error(`  ❌ Body: ${errBody.slice(0, 500)}`);
        res.write(wrapEnvelope(buildErrorChunk(messageId, `[OpenAI Error ${apiRes.statusCode}]`)));
        res.write(endOfStreamEnvelope());
        res.end();
      });
      return;
    }

    apiRes.setEncoding('utf8');

    function processPart(part) {
      const events = parseOpenAISSEChunk(part + '\n');
      for (const evt of events) {
        const protoChunks = processor.processEvent(evt);
        for (const chunk of protoChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (processor.isDone && !res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        console.log(`  ✅ OpenAI stream done (stop: ${processor.stopReason})`);
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
      // Force stop chunk if stream ended without response.completed
      if (!processor.isDone && !res.writableEnded) {
        console.log(`  ⚠️  OpenAI stream ended without response.completed — forcing stop`);
        const finalChunks = processor.processEvent({ done: true, type: 'done', data: null });
        for (const chunk of finalChunks) {
          res.write(wrapEnvelope(chunk));
        }
      }
      if (!res.writableEnded) {
        res.write(endOfStreamEnvelope());
        res.end();
        console.log(`  ✅ OpenAI stream ended (stop: ${processor.stopReason})`);
      }
    });

    apiRes.on('error', (err) => {
      console.error(`  ❌ OpenAI stream error: ${err.message}`);
      if (!res.writableEnded) {
        res.write(wrapEnvelope(buildErrorChunk(messageId, `[Stream Error]`)));
        res.write(endOfStreamEnvelope());
        res.end();
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error(`  ❌ OpenAI request error: ${err.message}`);
    if (!res.writableEnded) {
      res.write(wrapEnvelope(buildErrorChunk(messageId, `[Connection Error]`)));
      res.write(endOfStreamEnvelope());
      res.end();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded && !apiReq.destroyed) {
      console.log(`  🔌 Client disconnected mid-stream, aborting OpenAI call`);
      apiReq.destroy();
    }
  });

  apiReq.end(apiBody);
}

// ─── Anthropic → OpenAI Responses API input converter ───────
//
// Responses API uses a flat array of typed items instead of messages:
//   { role: "user"|"assistant"|"system"|"developer", content: "..." }
//   { type: "function_call", call_id, name, arguments }
//   { type: "function_call_output", call_id, output }

function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [];

  // System prompt → developer message (Responses API prefers "developer" over "system")
  if (systemPrompt) {
    result.push({ role: 'developer', content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      // Text content → assistant message
      let textContent = '';
      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
      if (textContent) {
        result.push({ role: 'assistant', content: textContent });
      }

      // Tool calls → function_call items (Responses API format)
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          result.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          });
        }
      }

    } else if (msg.role === 'user') {
      const contentParts = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          contentParts.push(block.text);
        } else if (block.type === 'image') {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}`,
          });
        } else if (block.type === 'tool_result') {
          // Tool results → function_call_output items (Responses API format)
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }

      if (contentParts.length > 0) {
        const hasMedia = contentParts.some(p => typeof p !== 'string');
        if (hasMedia) {
          result.push({
            role: 'user',
            content: contentParts.map(p =>
              typeof p === 'string' ? { type: 'input_text', text: p } : p
            ),
          });
        } else {
          result.push({ role: 'user', content: contentParts.join('\n') });
        }
      }
    }
  }

  return result;
}
