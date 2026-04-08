# windsurf-proxy

A MITM proxy that replaces Windsurf IDE's LLM backend with your own Anthropic API key — while keeping autocomplete, codebase indexing, auth, and all other features working through a free Codeium account.

Zero npm dependencies. Pure Node.js.

**Tested on:** Windsurf 1.108.x · Node.js 20+ · macOS (ARM/Intel) · Linux (remote SSH)

---

## How it works

Windsurf's Go binary (`language_server_macos_arm`) talks to two Codeium servers:

- `--api_server_url` → `server.self-serve.windsurf.com` (Cascade chat, telemetry, auth)
- `--inference_api_server_url` → `inference.codeium.com` (inline AI edit, autocomplete)

Three patches to `extension.js` redirect both URLs to your local proxy. The proxy intercepts `GetChatMessage` RPCs (chat and inline AI edit) and bridges them to the Anthropic Messages API. Everything else passes through to real Codeium servers.

```
Windsurf Extension (extension.js)
    │  spawns Go binary with patched URLs
    ▼
Go Binary
    ├── api_server_url → Port 3000 (hybrid-server.js)
    │   ├── GetChatMessage         → Your Anthropic API ✦
    │   ├── CONNECT tunnels        → blind TCP pipe (auth, telemetry)
    │   └── Everything else        → real Codeium
    │
    └── inference_api_server_url → Port 3001 (inference-proxy.js)
        ├── GetChatMessage         → Your Anthropic API ✦ (inline AI edit)
        └── GetStreamingCompletions → real Codeium (autocomplete)
```

---

## Quick start

### 1. Clone

```bash
git clone https://github.com/pqhaz/windsurf-proxy.git
cd windsurf-proxy
# Zero npm deps — nothing to install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_HOST=api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

For GPT model support, add OpenAI credentials:

```env
OPENAI_API_HOST=api.openai.com
OPENAI_API_KEY=sk-xxxxx
```

> **Unified endpoint?** If your API serves both Anthropic and OpenAI formats (e.g. `codex.example.com`), set both `*_API_HOST` vars to the same host and use the same key for both `*_API_KEY` vars.

Optional:

```env
# ANTHROPIC_API_PATH=/v1/messages       # custom Anthropic endpoint path
# OPENAI_API_PATH=/v1/responses         # custom OpenAI endpoint path
# DEFAULT_MODEL=claude-sonnet-4-6       # fallback model for unknown IDs
# MAX_TOKENS=16384                      # max output tokens
```

### 3. Generate MITM certificates

The proxy terminates TLS for `server.codeium.com` to inspect Connect-RPC traffic. [mkcert](https://github.com/FiloSottile/mkcert) creates locally-trusted certs:

```bash
brew install mkcert        # or your package manager
mkcert -install            # adds CA to system trust store
cd certs
mkcert server.codeium.com  # creates .pem + -key.pem
cd ..
```

This puts `server.codeium.com.pem` and `server.codeium.com-key.pem` in `certs/`.

### 4. Patch extension.js

Find the Windsurf extension file:

```bash
# macOS — app bundle
EXTENSION="/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js"

# macOS — user extensions (alternative location)
# EXTENSION="$HOME/Library/Application Support/Windsurf/extensions/windsurf-1.*/dist/extension.js"

# Linux (remote SSH server)
# EXTENSION="$HOME/.windsurf-server/bin/*/extensions/windsurf/dist/extension.js"
```

Apply three patches:

**Patch 1 — Redirect `getApiServerUrlFromContext` to localhost.**

Forces `--api_server_url http://localhost:3000` on binary launch.

```bash
sed -i '' \
  's|e.getApiServerUrlFromContext=A=>{if((0,g.getConfig)(g.Config.API_SERVER_URL)!==n.DEFAULT_API_SERVER_URL)return(0,g.getConfig)(g.Config.API_SERVER_URL);const t=(0,e.isStaging)((0,g.getConfig)(g.Config.API_SERVER_URL))?"apiServerUrl.staging":"apiServerUrl",i=A.globalState.get(t);return void 0===i||(0,e.isStaging)(i)?(0,g.getConfig)(g.Config.API_SERVER_URL):i}|e.getApiServerUrlFromContext=A=>{return"http://localhost:3000"}|' \
  "$EXTENSION"
```

**Patch 2 — Lock `restart()` to localhost.**

Prevents the auth handler from overwriting your URL after login.

```bash
sed -i '' \
  's|async restart(A){this.apiServerUrl=A,this.inputs.apiServerUrl=A,|async restart(A){A="http://localhost:3000",this.apiServerUrl=A,this.inputs.apiServerUrl=A,|' \
  "$EXTENSION"
```

**Patch 3 — Override inference URL.**

Routes `--inference_api_server_url` to your port 3001 proxy. The VS Code setting `codeium.inferenceApiServerUrl` is **silently ignored** by the Go binary — this patch is the only way.

```bash
sed -i '' \
  's|const i=(0,w.getConfig)(w.Config.INFERENCE_API_SERVER_URL)|const i="http://localhost:3001"|' \
  "$EXTENSION"
```

> **Linux note:** Use `sed -i` (no `''`) on Linux. For remote servers, replace `localhost:3000` / `localhost:3001` with your server's public URLs.

**Re-sign the app (macOS only):**

```bash
codesign --force --deep --sign - "/Applications/Windsurf.app"
```

> Do **not** use `--remove-signature` — the app won't launch on modern macOS.

**Verify patches:**

```bash
grep -c 'localhost:300[01]' "$EXTENSION"   # should print 3
```

### 5. Configure Windsurf settings

Open `settings.json` (`Cmd+Shift+P` → "Open User Settings JSON"):

```json
{
  "http.proxy": "http://localhost:3000",
  "http.proxyStrictSSL": false
}
```

### 6. Start the proxy

```bash
# Cascade chat only (port 3000)
npm start

# Both chat + inline AI edit (ports 3000 + 3001)
npm run start:both
```

### 7. Verify

Launch Windsurf and check the Go binary's process args:

```bash
ps aux | grep language_server | grep api_server_url
```

You should see:
- `--api_server_url http://localhost:3000`
- `--inference_api_server_url http://localhost:3001`

Open Cascade chat, send a message. The proxy terminal should show:

```
⚡ GetChatMessage → Anthropic API
  🧠 Model: claude-sonnet-4-6-thinking → claude-sonnet-4-6
  💬 Messages: 3
  ✅ Stream done (stop: end_turn)
```

---

## Model mapping

Windsurf sends internal model IDs. The proxy detects the provider and routes to the correct API:

| Windsurf sends | Provider | Actual model |
|---|---|---|
| `claude-sonnet-4-6-thinking` | Anthropic | `claude-sonnet-4-6` |
| `claude-opus-4-6-thinking` | Anthropic | `claude-opus-4-6` |
| `MODEL_SWE_1_5` / `MODEL_SWE_1_5_SLOW` | Anthropic | `claude-sonnet-4-6` |
| `gpt-5-4-low` / `gpt-5-4-high` | **OpenAI** | `gpt-5.4` |
| `MODEL_GPT_4O` | **OpenAI** | `gpt-4o` |
| `MODEL_GPT_4O_MINI` | **OpenAI** | `gpt-4o-mini` |
| `MODEL_GOOGLE_GEMINI_*` | Anthropic | `claude-sonnet-4-6` |
| Everything else | Anthropic | `DEFAULT_MODEL` env var |

Edit `MODEL_MAP` and `OPENAI_MODELS` in `src/handlers/chat.js` to customize routing.

---

## Remote SSH setup

When using Windsurf's remote SSH feature, the Go binary runs on the remote server and needs to reach your proxy over the network.

### Deploy the proxy

1. Run both `hybrid-server.js` (port 3000) and `inference-proxy.js` (port 3001) on your server
2. Put them behind nginx with SSL:

**Port 3000 — API server proxy (HTTP/1.1):**

```nginx
server {
    listen 443 ssl;
    server_name proxy.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

**Port 3001 — Inference proxy (HTTP/2 + gRPC):**

```nginx
server {
    listen 443 ssl http2;
    server_name grpc-proxy.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        grpc_pass grpc://127.0.0.1:3001;
        grpc_read_timeout 300s;
        grpc_send_timeout 300s;
    }
}
```

### Patch the remote extension.js

The remote server has its own `extension.js` at:

```
~/.windsurf-server/bin/<hash>/extensions/windsurf/dist/extension.js
```

Apply the same three patches, but use your server URLs instead of localhost:

```bash
EXTENSION="$HOME/.windsurf-server/bin/*/extensions/windsurf/dist/extension.js"

# Patch 1
sed -i "s|e.getApiServerUrlFromContext=A=>{if.*?:i}|e.getApiServerUrlFromContext=A=>{return\"https://proxy.example.com\"}|" $EXTENSION

# Patch 2
sed -i 's|async restart(A){this.apiServerUrl=A,|async restart(A){A="https://proxy.example.com",this.apiServerUrl=A,|' $EXTENSION

# Patch 3
sed -i 's|const i=(0,w.getConfig)(w.Config.INFERENCE_API_SERVER_URL)|const i="https://grpc-proxy.example.com"|' $EXTENSION
```

### Pre-patch the server tarball (optional)

To avoid re-patching after every Windsurf update, serve a pre-patched tarball:

```json
{
  "remote.windsurfSSH.experimental.serverDownloadUrlTemplate": "https://your-server.example.com/windsurf-reh-${version}.tar.gz",
  "remote.windsurfSSH.experimental.disableServerChecksum": true
}
```

---

## File structure

```
src/
├── hybrid-server.js          # Port 3000 — HTTP proxy + MITM TLS + CONNECT tunneling
├── inference-proxy.js        # Port 3001 — HTTP/2 proxy for inference traffic
├── proto.js                  # Protobuf wire format encoder/decoder
├── connect.js                # Connect-RPC envelope framing (5-byte prefix + gzip)
└── handlers/
    ├── chat.js               # GetChatMessage → Anthropic Messages API bridge
    ├── parse-request.js      # Protobuf request → Anthropic message format converter
    ├── build-response.js     # Anthropic response → protobuf frame builder
    └── anthropic-stream.js   # SSE stream processor (Anthropic → Connect-RPC chunks)
```

---

## Troubleshooting

**Go binary still uses real Codeium URL**

All three patches are required. Patch 2 prevents the auth handler from overwriting your URL after login. Verify:

```bash
grep -c 'localhost:300[01]' "$EXTENSION"   # must print 3
ps aux | grep language_server | grep api_server_url
```

**Windsurf won't launch after patching (macOS)**

You must re-sign: `codesign --force --deep --sign - "/Applications/Windsurf.app"`. Never use `--remove-signature`.

**Inline AI edit not routing through proxy**

Check `--inference_api_server_url` in process args. If missing, Patch 3 didn't apply. The VS Code setting `codeium.inferenceApiServerUrl` does nothing — the Go binary ignores it.

**"resource_exhausted" with Windsurf Fast**

"Windsurf Fast" inline edit has a ~2 second timeout. If your API's time-to-first-token exceeds this, it fails silently and retries in a loop. Use the "SWE-1.5" model selector instead — it has a longer timeout.

**Auth fails / "not signed in"**

The proxy must be running before Windsurf starts. The Go binary contacts localhost:3000 immediately on launch.

**TLS errors in proxy logs**

Run `mkcert -install` (installs the CA), not just `mkcert`. Check that cert files are in `certs/` with exact names: `server.codeium.com.pem`, `server.codeium.com-key.pem`.

---

## Limitations

- **Autocomplete** still uses Codeium's models — `GetStreamingCompletions` is forwarded to `inference.codeium.com`. Routing it through your own API requires reverse-engineering the FIM (fill-in-middle) response protobuf schema.
- **Web search** (`GetWebSearchResults`) is forwarded to Codeium. Can be intercepted to use your own search API — the handler slot is marked with a TODO in `hybrid-server.js`.
- **"Windsurf Fast"** inline edit has a ~2s timeout that's too aggressive for most API endpoints.
- **Windsurf updates** will overwrite `extension.js` — you'll need to re-patch after each update.

---

## How it was built

See [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) for the full methodology: binary analysis, JavaScript deobfuscation, traffic capture, protobuf schema extraction, and the Connect-RPC vs gRPC discovery that cost several hours.

## License

MIT
