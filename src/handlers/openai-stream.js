// handlers/openai-stream.js — OpenAI Chat Completions SSE → protobuf chunk processor
//
// Processes OpenAI streaming API SSE events and emits raw protobuf
// GetChatMessageResponse buffers (NOT wrapped in Connect-RPC envelope).
//
// OpenAI SSE event sequence:
//   data: {"id":"...","choices":[{"delta":{"role":"assistant"},...}]}
//   data: {"id":"...","choices":[{"delta":{"content":"text"},...}]}
//   ...
//   data: {"id":"...","choices":[{"delta":{},"finish_reason":"stop",...}]}
//   data: [DONE]
//
// Tool calls come as:
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"fn","arguments":""}}]}}]}
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"partial"}}]}}]}
//   ...
//   data: {"choices":[{"finish_reason":"tool_calls",...}]}
//
// Usage:
//   const processor = new OpenAIStreamProcessor(messageId, modelUid);
//   for (const sseEvent of parseOpenAISSEChunk(rawChunk)) {
//     const protoBuffers = processor.processEvent(sseEvent);
//     for (const buf of protoBuffers) res.write(wrapEnvelope(buf));
//   }
//   if (processor.isDone) { res.write(endOfStreamEnvelope()); res.end(); }

import {
  buildTextDelta,
  buildToolCallDelta,
  buildStopChunk,
  STOP_REASON,
} from './build-response.js';

// ─── SSE parser ────────────────────────────────────────────

/**
 * Parse a raw OpenAI SSE text chunk into an array of data objects.
 *
 * OpenAI uses simpler SSE than Anthropic — no `event:` field, just `data:` lines.
 * The final event is `data: [DONE]`.
 *
 * @param {string} text - Raw SSE text (may contain multiple events)
 * @returns {{ done: boolean, data: any }[]}
 */
export function parseOpenAISSEChunk(text) {
  const events = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      events.push({ done: true, data: null });
      continue;
    }
    try {
      events.push({ done: false, data: JSON.parse(payload) });
    } catch {
      // Skip malformed JSON lines
    }
  }

  return events;
}

// ─── Stream processor ──────────────────────────────────────

/**
 * Stateful processor that maps OpenAI Chat Completions SSE events to raw
 * protobuf GetChatMessageResponse buffers.
 *
 * Tool call accumulation:
 *   - OpenAI streams tool calls incrementally by index
 *   - Each index accumulates id, name, and arguments across chunks
 *   - All accumulated tool calls are flushed on finish_reason="tool_calls"
 */
export class OpenAIStreamProcessor {
  /**
   * @param {string} messageId - UUID echoed in every response chunk
   * @param {string} modelUid  - Model name echoed in stop chunk
   */
  constructor(messageId, modelUid) {
    this._messageId = messageId;
    this._modelUid = modelUid;
    this._tokenCount = 0;
    this._done = false;
    this._stopReason = null;

    // Tool call accumulators — keyed by index
    // { [index]: { id, name, arguments } }
    this._toolCalls = {};
  }

  get isDone() { return this._done; }
  get stopReason() { return this._stopReason; }

  /**
   * Process a single parsed SSE event and return proto buffers to send.
   *
   * @param {{ done: boolean, data: any }} event
   * @returns {Buffer[]}
   */
  processEvent(event) {
    if (event.done) {
      return this._onDone();
    }

    const chunks = [];
    const data = event.data;
    if (!data?.choices?.length) return chunks;

    const choice = data.choices[0];
    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    if (delta) {
      // Text content
      if (delta.content) {
        this._tokenCount++;
        chunks.push(buildTextDelta(this._messageId, delta.content, this._tokenCount));
      }

      // Tool calls (incremental by index)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!this._toolCalls[idx]) {
            this._toolCalls[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id) this._toolCalls[idx].id = tc.id;
          if (tc.function?.name) this._toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) this._toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }

    // Capture finish reason
    if (finishReason) {
      this._stopReason = finishReason;
    }

    return chunks;
  }

  // ── Private ─────────────────────────────────────────────

  _onDone() {
    const chunks = [];

    // Flush accumulated tool calls if any
    const toolIndices = Object.keys(this._toolCalls);
    if (toolIndices.length > 0) {
      const calls = toolIndices
        .sort((a, b) => Number(a) - Number(b))
        .map(idx => ({
          id: this._toolCalls[idx].id,
          name: this._toolCalls[idx].name,
          arguments_json: this._toolCalls[idx].arguments,
        }));
      chunks.push(buildToolCallDelta(this._messageId, calls));
    }

    // Emit stop chunk
    const protoStopReason = this._mapStopReason(this._stopReason);
    chunks.push(buildStopChunk(this._messageId, protoStopReason, this._modelUid));
    this._done = true;

    return chunks;
  }

  /**
   * Map OpenAI finish_reason → exa StopReason varint.
   *
   *   "stop"       → STOP_REASON_STOP_PATTERN  (2)
   *   "tool_calls" → STOP_REASON_FUNCTION_CALL (10)
   *   "length"     → STOP_REASON_MAX_TOKENS    (3)
   *   (others)     → STOP_REASON_STOP_PATTERN  (2)
   */
  _mapStopReason(reason) {
    switch (reason) {
      case 'stop':       return STOP_REASON.STOP_PATTERN;
      case 'tool_calls': return STOP_REASON.FUNCTION_CALL;
      case 'length':     return STOP_REASON.MAX_TOKENS;
      default:           return STOP_REASON.STOP_PATTERN;
    }
  }
}
