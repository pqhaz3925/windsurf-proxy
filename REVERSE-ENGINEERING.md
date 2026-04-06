# Reverse Engineering Windsurf IDE's Network Protocol

## Overview

This document details the reverse engineering of [Windsurf IDE](https://windsurf.com) v1.108.2, a VS Code fork by Codeium that adds AI coding features (Cascade chat, inline completions, inline AI edit). The goal was to understand the wire protocol between the IDE and Codeium's servers well enough to build a proxy that replaces the LLM backend with any Anthropic-compatible API — while keeping all other Windsurf features (codebase indexing, autocomplete, auth, telemetry) working through the real Codeium infrastructure.

The core discovery: Windsurf's Go binary communicates via **Connect-RPC** (not raw gRPC) using protobuf serialization over HTTP/1.1 and HTTP/2. A webpack-bundled `extension.js` orchestrates everything — spawning the binary, configuring URLs, handling auth. Three surgical patches to this file are enough to redirect all LLM traffic to a local proxy.

## Methodology

The reverse engineering followed six phases, each building on the previous:

### 1. Binary Analysis

The Go binary `language_server_macos_arm` (shipped inside the Windsurf app bundle) is the core intelligence component. Running `strings` on it revealed:

- RPC service and method names: `exa.api_server_pb.ApiServerService/GetChatMessage`, `GetStreamingCompletions`, `GetWebSearchResults`
- Protobuf field names and enum values: `StopReason`, `ChatMessageSource`, `ModelUsageStats`
- Hardcoded URLs: `server.self-serve.windsurf.com`, `inference.codeium.com`
- Command-line flags: `--api_server_url`, `--inference_api_server_url`

### 2. JavaScript Analysis

`extension.js` is webpack-bundled and minified but not obfuscated. Key search patterns:

- **Protobuf class definitions**: `proto3.util.setEnumType` reveals all enum types and their values
- **Field descriptors**: `{no:N, name:"...", kind:"..."}` patterns map every protobuf field number to its name and type
- **URL configuration**: `getApiServerUrlFromContext`, `computeServerInputs`, `INFERENCE_API_SERVER_URL`
- **Auth flow**: `WindsurfAuthProvider.handleSecretChange` → `restart(storedUrl)`

### 3. Traffic Capture

Built an HTTP/2 proxy (Node.js `http2` module) to intercept Connect-RPC traffic between the Go binary and Codeium servers. The proxy:

- Terminates TLS using locally-trusted certificates (via `mkcert`)
- Dumps raw request/response bodies to disk as binary files
- Logs all HTTP/2 headers, frame types, and content metadata
- Decompresses gzip payloads for inspection

### 4. Protobuf Schema Extraction

With raw binary dumps in hand, wrote a custom parser that walks protobuf wire format:

```javascript
function decodeVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, offset];
    shift += 7;
  }
  return [result, offset];
}
```

Each field is encoded as a varint tag (field number + wire type), followed by the value. By recursively parsing length-delimited fields as nested messages, the full schema emerges — field numbers, nesting depth, string vs. numeric vs. submessage types.

### 5. Protocol Identification

The most time-consuming discovery: the Go binary uses **Connect-RPC**, not raw gRPC.

| Property | gRPC | Connect-RPC (what Windsurf uses) |
|---|---|---|
| Content-Type | `application/grpc` | `application/connect+proto` |
| Framing | 5-byte prefix per message | 5-byte prefix per message |
| Trailers | HTTP/2 trailers | In-stream trailer frame (flags=0x02) |
| Error format | `grpc-status` header | JSON error body |
| Transport | HTTP/2 required | HTTP/1.1 or HTTP/2 |

This distinction is critical. Responding with `content-type: application/grpc` causes the Go binary to **silently reject** the response — no error in extension logs, features just stop working. This cost several hours of debugging.

### 6. Extension Patching

Identified three injection points in `extension.js` where URL configuration could be overridden. See [Extension Patching](#extension-patching) below.

## Architecture Discovery

```
Windsurf Extension (extension.js)
    │
    │  spawns with --api_server_url and --inference_api_server_url
    ▼
Go Binary (language_server_macos_arm / language_server_linux_x64)
    │
    ├── --api_server_url (default: server.self-serve.windsurf.com)
    │   ├── GetChatMessage         (Cascade chat)
    │   ├── Ping                   (heartbeat)
    │   ├── GetModelStatuses       (model availability)
    │   ├── Analytics/telemetry    (usage data)
    │   └── GetWebSearchResults    (web search tool)
    │
    └── --inference_api_server_url (default: inference.codeium.com)
        ├── GetChatMessage         (inline AI edit)
        ├── GetStreamingCompletions (inline autocomplete)
        └── Other inference RPCs
```

Key findings:

- The Go binary is launched by the extension with both URL flags as command-line arguments
- `getApiServerUrlFromContext()` in extension.js determines `--api_server_url`
- `computeServerInputs()` determines `--inference_api_server_url` by reading `w.Config.INFERENCE_API_SERVER_URL`
- After authentication, `WindsurfAuthProvider.handleSecretChange` calls `restart(storedUrl)`, which overwrites `--api_server_url` with whatever URL the auth server returned
- The VS Code setting `codeium.inferenceApiServerUrl` is read by the extension but the value is **never passed** to the Go binary's command-line flag — it must be patched directly in extension.js

## Connect-RPC Wire Format

Every request and response uses the Connect protocol envelope:

```
┌─────────┬──────────────────┬─────────────────────┐
│ Byte 0  │ Bytes 1-4        │ Remaining bytes      │
│ Flags   │ Payload length   │ Payload (protobuf)   │
│ (uint8) │ (uint32 BE)      │ (gzip if flag set)   │
└─────────┴──────────────────┴─────────────────────┘
```

**Flags byte:**
- Bit 0 (0x01): Payload is gzip-compressed
- Bit 1 (0x02): End-of-stream trailer frame

**Request headers:**
```
:method: POST
:path: /exa.api_server_pb.ApiServerService/GetChatMessage
content-type: application/connect+proto
connect-protocol-version: 1
connect-content-encoding: gzip
connect-accept-encoding: gzip
user-agent: connect-go/1.18.1 (go1.26.0)
```

**Streaming response:** Multiple envelope frames concatenated. Each frame contains one gzip-compressed protobuf message. The final frame has flags=0x02 and payload `{}` (JSON trailer indicating success).

**Error response:** A single frame with a JSON body:
```json
{"code": "invalid_argument", "message": "description of error"}
```

## Extension Patching

The extension is webpack-bundled and minified into a single `extension.js` (roughly 10MB). Despite minification, the code is not obfuscated — all string literals, protobuf field names, and function names are preserved. This makes surgical patching practical with `sed`.

### Injection point 1: `getApiServerUrlFromContext`

This function determines the `--api_server_url` flag passed to the Go binary on startup. The original implementation reads from VS Code settings and global state, falling back to a hardcoded default. Replacing the entire function body with a constant return is the simplest override:

```javascript
// Original (minified, ~200 chars of config lookup logic)
e.getApiServerUrlFromContext=A=>{if((0,g.getConfig)(g.Config.API_SERVER_URL)!==...}

// Patched
e.getApiServerUrlFromContext=A=>{return"http://localhost:3000"}
```

### Injection point 2: `restart()`

`WindsurfAuthProvider.handleSecretChange` fires after a successful login. It reads the `apiServerUrl` secret stored by the auth server and calls `this.restart(storedUrl)`, which reassigns `this.apiServerUrl` and relaunches the Go binary. Without this patch, every login overwrites the URL back to Codeium's server:

```javascript
// Original
async restart(A){this.apiServerUrl=A,this.inputs.apiServerUrl=A,...

// Patched — force the argument to localhost before assignment
async restart(A){A="http://localhost:3000",this.apiServerUrl=A,this.inputs.apiServerUrl=A,...
```

### Injection point 3: `computeServerInputs`

This function builds the full set of command-line arguments for the Go binary. The inference URL is read from a config constant and assigned to a local variable `i`. The VS Code setting `codeium.inferenceApiServerUrl` exists and is read by the extension, but the value is **never assigned to this variable** — a bug or intentional omission that means the only way to override the inference URL is to patch this line:

```javascript
// Original
const i=(0,w.getConfig)(w.Config.INFERENCE_API_SERVER_URL)

// Patched
const i="http://localhost:3001"
```

### Post-patch signing (macOS)

macOS Gatekeeper checks code signatures on launch. After modifying `extension.js`, the app's signature is invalidated. Ad-hoc re-signing restores a valid (but untrusted) signature that satisfies Gatekeeper:

```bash
codesign --force --deep --sign - "/Applications/Windsurf.app"
```

Using `codesign --remove-signature` leaves the binary in an unsigned state that modern macOS (Ventura+) rejects entirely. The `--force --deep --sign -` approach is the only one that works reliably.

## Reconstructed Protobuf Schemas

These were extracted by combining: (1) field descriptors from `extension.js` (`{no:N, name:"...", kind:"..."}`), (2) enum values from `proto3.util.setEnumType` calls, and (3) recursive parsing of captured binary request/response bodies.

### GetChatMessageRequest (top-level)

```protobuf
message GetChatMessageRequest {
  Metadata metadata = 1;
  string prompt = 2;                                   // system prompt
  repeated ChatMessagePrompt chat_message_prompts = 3; // conversation history
  repeated ChatToolDefinition tools = 10;              // tool definitions
  ChatToolChoice tool_choice = 12;                     // tool choice policy
  string chat_model_uid = 21;                          // model ID string
}
```

### ChatMessagePrompt

```protobuf
message ChatMessagePrompt {
  string message_id = 1;
  ChatMessageSource source = 2;          // varint enum
  string prompt = 3;                     // message text
  uint32 num_tokens = 4;
  repeated ChatToolCall tool_calls = 6;  // assistant tool use
  string tool_call_id = 7;              // for tool result messages
  bool tool_result_is_error = 9;
  repeated ImageData images = 10;        // attached screenshots
  string thinking = 11;                  // extended thinking content
  string signature = 12;                 // thinking signature
}
```

### ChatMessageSource (enum)

```protobuf
enum ChatMessageSource {
  UNSPECIFIED = 0;
  USER = 1;          // → Anthropic "user" role
  SYSTEM = 2;        // → Anthropic "assistant" role
  UNKNOWN = 3;       // → Anthropic "assistant" role
  TOOL = 4;          // → Anthropic "user" role with tool_result content block
  SYSTEM_PROMPT = 5; // → folded into top-level system prompt, not a message
}
```

The `SYSTEM` (2) and `UNKNOWN` (3) sources both map to assistant. This was confirmed by observing that assistant responses with tool calls come back as `SYSTEM` source, while assistant text responses use `UNKNOWN`.

### ImageData

```protobuf
message ImageData {
  string base64_data = 1;
  string mime_type = 2;    // "image/png", "image/jpeg"
  string caption = 3;
}
```

### ChatToolCall / ChatToolDefinition / ChatToolChoice

```protobuf
message ChatToolCall {
  string id = 1;
  string name = 2;
  string arguments_json = 3;
}

message ChatToolDefinition {
  string name = 1;
  string description = 2;
  string json_schema_string = 3;  // JSON-encoded input schema
  bool strict = 4;
}

message ChatToolChoice {
  string option_name = 1;   // "auto" | "any" | "none"
  string tool_name = 2;     // specific tool name
}
```

## Traffic Routing Discovery

One of the more time-consuming discoveries: the Go binary splits traffic across **two separate URLs**, not one. `GetChatMessage` appears on both:

| RPC Method | URL Flag | Default Upstream | Feature |
|---|---|---|---|
| `GetChatMessage` | `api_server_url` | `server.self-serve.windsurf.com` | Cascade chat |
| `GetChatMessage` | `inference_api_server_url` | `inference.codeium.com` | Inline AI edit |
| `GetStreamingCompletions` | `inference_api_server_url` | `inference.codeium.com` | Inline autocomplete |
| `Ping`, analytics, telemetry | `api_server_url` | `server.self-serve.windsurf.com` | Heartbeat/metrics |

The inline AI edit using the same RPC method as chat — but routed through a different URL — was initially missed because port 3001 logs were empty. The cause turned out to be a missing patch: the remote SSH server's `extension.js` had Patches 1+2 but not Patch 3, so inference traffic was still going directly to Codeium.

`GetStreamingCompletions` uses a completely different protobuf schema from `GetChatMessage`. It carries cursor position, document content, language ID, relative file path, and stop tokens — a fill-in-the-middle (FIM) protocol, not a chat protocol. Attempting to return a `GetChatMessageResponse`-format protobuf for a completions request produces `invalid wire-format data` errors.

## Lessons Learned

**Connect-RPC ≠ gRPC.** The most expensive mistake was responding with `content-type: application/grpc` instead of `application/connect+proto`. The Go binary silently rejects responses with the wrong content type — no error logs, no exceptions, features just stop working. This cost ~6 hours of debugging before the content-type header was identified as the culprit.

**VS Code settings don't always reach the binary.** The `codeium.inferenceApiServerUrl` setting exists in the extension's schema and is read by `extension.js`, but the value is never passed to `computeServerInputs()` as the inference URL flag. This is either a bug or a deliberate decision to prevent user override. Either way, direct patching of `extension.js` is the only reliable method.

**Auth overwrites URL configuration.** Even after patching the initial URL, the `WindsurfAuthProvider.handleSecretChange` handler restores the Codeium-provided URL after every successful login. Without Patch 2, the proxy works exactly once — until the first auth refresh.

**The 5-byte envelope is not gRPC framing.** While both gRPC and Connect-RPC use a 5-byte prefix (1 byte flags + 4 bytes length), their semantics differ. In Connect-RPC, the flags byte can indicate gzip compression (0x01) or end-of-stream trailers (0x02). The trailer frame carries a JSON body (`{}`), not protobuf — another departure from gRPC that took time to discover.

**Streaming responses are chunked envelopes.** Each Connect-RPC streaming response is a sequence of independent 5-byte-prefixed messages concatenated on the wire. The final frame has flags=0x02 (or 0x03 if compressed) and carries JSON trailers. Missing or malforming this trailer frame causes the client to hang indefinitely.

**"Windsurf Fast" has a hard ~2s timeout.** The inline AI edit feature branded as "Windsurf Fast" sends a request, waits approximately 2 seconds for first token, then aborts and retries. This produces 20-30 rapid-fire `GetChatMessage` requests with `resource_exhausted` errors. The "SWE-1.5" model selector uses a longer timeout and works reliably with external APIs.

## Disclaimer

This document is intended for educational purposes — understanding how modern IDE extensions communicate with their backends via Connect-RPC and protobuf. The techniques described (traffic capture, binary string extraction, minified JavaScript analysis) are standard reverse engineering methodology applicable to any similar system.

Use responsibly and in compliance with all applicable terms of service.
