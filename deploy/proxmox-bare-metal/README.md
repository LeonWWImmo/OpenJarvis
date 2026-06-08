# Bare-metal LXC deployment (remote brain)

Runs OpenJarvis server + Ollama + Edge-TTS directly in an unprivileged Proxmox
LXC with NVIDIA GPU passthrough; clients reach it over a Tailscale tunnel.

Components in the container:
- ollama (systemd) — GPU inference, model qwen2.5:7b
- openjarvis (systemd) — `jarvis serve --host 0.0.0.0 --port 8000 --engine ollama --model qwen2.5:7b --agent simple`, OPENJARVIS_CONFIG=/data/openjarvis/config/config.toml, OPENJARVIS_OLLAMA_NUM_GPU=99
- piper-tts (systemd) — FastAPI on :5001, Edge-TTS voice en-IE-EmilyNeural (see piper-tts-server.py)
- caddy — :8088 serves the built web UI at / and proxies /v1*,/api*,/health,/ws*,/tts to the backend (injects the API key)
- tailscale serve — https://<node>.ts.net -> caddy:8088

Data (NOT in git): /data/openjarvis/{config,brain,logs}, memory.db, Obsidian vault.
API key lives in /etc/openjarvis/env (OPENJARVIS_API_KEY), never committed.
Memory backend needs the Rust extension: build rust/crates/openjarvis-python with maturin.
