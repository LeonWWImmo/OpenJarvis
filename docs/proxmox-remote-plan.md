# Proxmox Remote Brain Plan

## Goal

Run model inference, memory, and server-side tools on Proxmox. Keep the UI,
microphone, wake word, audio playback, and local PC control on the client.

## Server Components

- OpenJarvis FastAPI server
- Ollama model runtime
- Persistent memory database
- Obsidian-compatible brain folder
- Reverse proxy for client access
- Server-safe tools such as web search and memory search

## Client Components

- Browser/PWA UI
- Desktop Tauri shell
- Local wake word
- Local "Yes Sir" acknowledgement
- Local TTS playback
- Local device bridge for PC actions

## Required Client Cleanup

- Add a remote mode in Desktop settings.
- Make `get_api_base` read the configured remote API URL.
- Stop auto-starting local Ollama/API in remote mode.
- Replace hardcoded `127.0.0.1` voice and Ollama URLs with settings.
- Route model list, pull, delete, and preload through OpenJarvis API.
- Extend Tauri CSP for the configured remote origin.
- Keep local-only tools behind a future device bridge.

## Security

- Never expose Ollama directly.
- Never expose unrestricted shell or file tools from the server.
- Prefer Tailscale or WireGuard.
- Use a non-empty `OPENJARVIS_API_KEY`.
- Put public internet exposure behind stronger auth such as OIDC or Cloudflare Access.
