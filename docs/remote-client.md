# Remote Frontend Client

This branch is the desktop/browser client for an OpenJarvis server running on
Proxmox. It does not auto-start a local OpenJarvis API or local Ollama.

## Start Browser Client

```powershell
.\scripts\start-remote-client.ps1 -ServerUrl http://SERVER-IP:8088
```

Open `http://localhost:5173`.

## Start Desktop Client

```powershell
.\scripts\start-remote-client.ps1 -ServerUrl http://SERVER-IP:8088 -Desktop
```

The script creates `frontend/.env.local`. That file is ignored by Git and may
contain a different server address on each client.

## Responsibilities

Remote server:

- model inference
- OpenJarvis API
- memory and server-side agents
- model downloads and model listing

Local client:

- UI and 3D orb
- microphone
- wake word and acknowledgement
- TTS playback
- desktop shortcuts and local device actions

Direct Ollama calls are disabled in remote mode. The Ollama port must remain
private on the server.
