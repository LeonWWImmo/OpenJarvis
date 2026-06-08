import { useEffect, useRef, useState } from 'react';
import { transcribeAudio, getBase, fetchModels } from '../lib/api';

type Msg = { role: 'user' | 'assistant'; content: string };

export function RemoteVoice() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [model, setModel] = useState('qwen2.5:7b');
  const [status, setStatus] = useState('Bereit');
  const [speakOn, setSpeakOn] = useState(true);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchModels().then((m) => { if (m && m[0]) setModel(m[0].id); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, busy]);

  function speak(text: string) {
    if (!speakOn || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    const v = window.speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('de'));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t) return;
    setInput('');
    const next: Msg[] = [...messages, { role: 'user', content: t }];
    setMessages(next);
    setBusy(true);
    setStatus('Denke nach…');
    try {
      const res = await fetch(`${getBase()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: next, stream: false }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(keine Antwort)';
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
      speak(reply);
      setStatus('Bereit');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => [...m, { role: 'assistant', content: 'Fehler: ' + msg }]);
      setStatus('Fehler');
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (recording) { mediaRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRecording(false);
        const mime = mr.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        setBusy(true);
        setStatus('Transkribiere…');
        try {
          const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
          const r = await transcribeAudio(blob, 'recording.' + ext);
          if (r.text && r.text.trim()) { await send(r.text); }
          else { setStatus('Nichts erkannt'); setBusy(false); }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus('STT-Fehler: ' + msg);
          setBusy(false);
        }
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
      setStatus('Höre zu… (nochmal tippen zum Stoppen)');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus('Mikro-Fehler: ' + msg);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 820, margin: '0 auto', padding: 16, boxSizing: 'border-box', color: '#e7e7ea' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>OpenJarvis — Remote</h2>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{model}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{status}</span>
      </div>
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', border: '1px solid #2a2a2e', borderRadius: 10, padding: 12, background: '#161618' }}>
        {messages.length === 0 && <div style={{ opacity: 0.5, fontSize: 14 }}>Tippe eine Nachricht oder nutze das Mikrofon.</div>}
        {messages.map((m, i) => (
          <div key={i} style={{ margin: '8px 0', textAlign: m.role === 'user' ? 'right' : 'left' }}>
            <span style={{ display: 'inline-block', maxWidth: '85%', padding: '8px 12px', borderRadius: 12, whiteSpace: 'pre-wrap', background: m.role === 'user' ? '#2563eb' : '#27272b', color: '#fff' }}>{m.content}</span>
          </div>
        ))}
        {busy && <div style={{ opacity: 0.5, fontSize: 13, margin: '8px 0' }}>…</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button onClick={toggleMic} disabled={busy && !recording} title="Sprechen" style={{ width: 46, height: 46, borderRadius: 23, border: 'none', cursor: 'pointer', background: recording ? '#dc2626' : '#3f3f46', color: '#fff', fontSize: 18 }}>{recording ? '■' : '🎤'}</button>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(input); }} placeholder="Nachricht…" style={{ flex: 1, height: 46, borderRadius: 10, border: '1px solid #2a2a2e', background: '#0f0f10', color: '#e7e7ea', padding: '0 14px', fontSize: 15 }} />
        <button onClick={() => send(input)} disabled={busy || !input.trim()} style={{ height: 46, padding: '0 18px', borderRadius: 10, border: 'none', cursor: 'pointer', background: '#2563eb', color: '#fff', fontSize: 15 }}>Senden</button>
        <button onClick={() => setSpeakOn((s) => !s)} title="Sprachausgabe" style={{ height: 46, padding: '0 12px', borderRadius: 10, border: '1px solid #2a2a2e', cursor: 'pointer', background: speakOn ? '#16a34a' : '#27272b', color: '#fff' }}>{speakOn ? '🔊' : '🔇'}</button>
      </div>
    </div>
  );
}