# OpenJarvis Proxmox Deployment

This branch runs the OpenJarvis brain on a Proxmox VM while desktop, browser,
and mobile clients stay thin clients.

## Target Layout

```text
Desktop app / browser / mobile PWA
        |
        | HTTP(S), SSE streaming
        v
Caddy reverse proxy
        |
        v
OpenJarvis API container
        |
        +--> Ollama container
        +--> /data/openjarvis/brain
        +--> /data/openjarvis/config
```

Ollama is not exposed to the network. Only Caddy is exposed.

## Recommended Proxmox VM

Use a VM, not LXC, especially if GPU passthrough is planned.

CPU-only test:

- 4 vCPU
- 8 GB RAM
- 80 GB disk
- Debian 12 or Ubuntu Server 24.04

Recommended with local models:

- 8+ vCPU
- 16-32 GB RAM
- NVIDIA GPU passthrough if available
- 200+ GB disk for models and backups

## First Install

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker

git clone -b server/proxmox-deployment https://github.com/LeonWWImmo/OpenJarvis.git
cd OpenJarvis/deploy/proxmox

cp env.example .env
nano .env

./scripts/init-data.sh
docker compose --env-file .env -f compose.yml up -d --build
./scripts/pull-model.sh qwen3.5:4b
./scripts/healthcheck.sh
```

For NVIDIA GPU:

```bash
docker compose --env-file .env -f compose.yml -f compose.gpu.nvidia.yml up -d --build
```

## Configure `.env`

Required:

- `JARVIS_HOSTNAME`: hostname clients use.
- `OPENJARVIS_API_KEY`: generate with `openssl rand -base64 48`.
- `OPENJARVIS_MODEL`: default Ollama model.

Optional:

- `CADDY_HTTP_PORT`: default `8088`.
- `CADDY_HTTPS_PORT`: default `8443`.
- `OPENJARVIS_NUM_CTX`: Ollama context window.
- `OPENJARVIS_OLLAMA_KEEP_ALIVE`: model keep-alive duration.

## Connect Clients

First browser/PWA test:

```text
http://SERVER_IP:8088
```

With public DNS and TLS configured:

```text
https://JARVIS_HOSTNAME:8443
```

For a private Tailscale deployment, HTTP over the encrypted tailnet is enough
for the first test. Tailscale Serve can be added later for a trusted HTTPS URL.

Desktop remote mode still needs the client cleanup described in
`docs/proxmox-remote-plan.md`. Use the browser/PWA against this server first.

## Data Paths

```text
/data/openjarvis/config/config.toml
/data/openjarvis/brain/memory.db
/data/openjarvis/brain/obsidian/
/data/openjarvis/logs/
/data/ollama/
```

Back up `/data/openjarvis`, `/data/ollama`, and the deployed Git commit.

## Security Rules

- Do not expose Ollama port `11434`.
- Do not expose OpenJarvis API port `8000` directly.
- Keep `OPENJARVIS_API_KEY` only in `.env` on the server.
- Prefer Tailscale/WireGuard before public exposure.
- Do not enable unrestricted `shell_exec` or local file tools on the server.
- Add OIDC, Cloudflare Access, or equivalent before public internet exposure.
