import base64, os, re
import edge_tts
from fastapi import FastAPI

EDGE_VOICE = os.environ.get("OJ_EDGE_VOICE", "en-IE-EmilyNeural")
EDGE_RATE = os.environ.get("OJ_EDGE_RATE", "+0%")
EDGE_PITCH = os.environ.get("OJ_EDGE_PITCH", "+0Hz")
app = FastAPI()

def clean_for_speech(text: str) -> str:
    t = text or ""
    t = re.sub(r"```.*?```", " ", t, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"https?://\S+", "a link", t)               # urls -> "a link"
    t = re.sub(r"\b[A-Za-z]:\\[^\s'\"]+", "a file path", t) # windows paths
    t = re.sub(r"(?<!\w)/(?:[\w.-]+/){2,}[\w.-]+", "a file path", t)  # unix paths
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*\d+\.\s+", "", t, flags=re.M)
    t = re.sub(r"\b[0-9a-fA-F]{12,}\b", "", t)             # long hex/ids
    t = re.sub(r"[*_#>|~]", "", t)
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿]", "", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{2,}", ". ", t)
    t = re.sub(r"\n", " ", t)
    t = re.sub(r"\s+([.,!?;:])", r"\1", t)
    t = re.sub(r"\.{2,}", ".", t)
    return t.strip()

async def _edge(text: str) -> bytes:
    c = edge_tts.Communicate(text, EDGE_VOICE, rate=EDGE_RATE, pitch=EDGE_PITCH)
    buf = bytearray()
    async for ch in c.stream():
        if ch["type"] == "audio":
            buf += ch["data"]
    return bytes(buf)

@app.get("/health")
def health():
    return {"ok": True, "backend": "edge-tts", "voice": EDGE_VOICE, "rate": EDGE_RATE, "pitch": EDGE_PITCH}

@app.get("/tts")
async def tts(text: str = ""):
    t = clean_for_speech(text)
    if not t:
        return {"ok": False, "reason": "empty"}
    try:
        audio = await _edge(t)
        return {"ok": True, "audio_b64": base64.b64encode(audio).decode(), "mime": "audio/mpeg"}
    except Exception as e:
        return {"ok": False, "reason": str(e)}
