import { useEffect, useState, useRef, useCallback } from 'react';
import { Mic, Send, Square, Settings as SettingsIcon, History as HistoryIcon, X, Bell, Clock, Camera, Brain, HelpCircle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { JarvisWebGLOrb, type OrbMood } from '../components/Chat/JarvisWebGLOrb';
import { isRemoteClient, getBase, fetchModels, transcribeAudio } from '../lib/api';

const VOICE_LOOP_URL = 'http://127.0.0.1:8770';
const RESOLVER_URL = 'http://127.0.0.1:8771';

type Health = {
  ok: boolean;
  whisper_ready: boolean;
  kokoro_ready: boolean;
  pipeline_busy: boolean;
};

type TimerItem = {
  id: number;
  fire_at: number;
  message: string;
};

type ClientTimer = {
  id: string;       // uuid-ish
  name: string;
  fire_at: number;  // epoch seconds
  fired: boolean;
};

type Hardware = {
  cpu_percent?: number;
  ram_used_gb?: number;
  ram_total_gb?: number;
  ram_percent?: number;
  gpu_name?: string;
  gpu_percent?: number;
  vram_used_gb?: number;
  vram_total_gb?: number;
  vram_percent?: number;
  gpu_temp_c?: number;
  gpu_processes?: { pid: number; name: string; vram_mb: number }[];
  voice_loop_runtime?: { llm: string; stt: string; tts: string };
};

type ChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

type QAPair = {
  user: ChatMessage;
  assistant?: ChatMessage;
};

function pairUp(messages: ChatMessage[]): QAPair[] {
  const out: QAPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      const next = messages[i + 1];
      out.push({ user: m, assistant: next?.role === 'assistant' ? next : undefined });
      if (next?.role === 'assistant') i++;
    }
  }
  return out;
}

/**
 * JARVIS-Home — fullscreen 3D-Orb mit Glassmorph-History-Sidebar links.
 */
function intentUrl(t: string): string | null {
  const x = (t || '').trim().toLowerCase();
  const clean = (v: string) => v.replace(/[?.!,]+$/, '').trim();
  const q = (v: string) => encodeURIComponent(clean(v));
  let m: RegExpMatchArray | null;
  if ((m = x.match(/(?:open (?:a |the )?maps? of|maps? of|directions to|navigate to|where is)\s+(.+)/))) return 'https://www.google.com/maps/search/' + q(m[1]);
  if (/\b(?:open|go to) youtube\b/.test(x)) return 'https://www.youtube.com';
  if ((m = x.match(/(?:play|search(?: for)?|find)\s+(.+?)\s+on youtube/))) return 'https://www.youtube.com/results?search_query=' + q(m[1]);
  if ((m = x.match(/youtube (?:search (?:for )?|for )?(.+)/))) return 'https://www.youtube.com/results?search_query=' + q(m[1]);
  if ((m = x.match(/^play\s+(.+?)(?:\s+on (?:youtube )?music)?$/))) return 'https://music.youtube.com/search?q=' + q(m[1]);
  if (/\bopen spotify\b/.test(x)) return 'https://open.spotify.com';
  if ((m = x.match(/(?:on )?spotify\s+(?:play |search (?:for )?)?(.+)/))) return 'https://open.spotify.com/search/' + q(m[1]);
  if ((m = x.match(/search github (?:for )?(.+)/))) return 'https://github.com/search?q=' + q(m[1]) + '&type=repositories';
  if ((m = x.match(/(?:wikipedia|wiki)(?: page)?(?: (?:of|for|about|on))?\s+(.+)/))) return 'https://en.wikipedia.org/w/index.php?search=' + q(m[1]);
  if ((m = x.match(/translate\s+(.+?)\s+(?:in)?to\s+(.+)/))) return 'https://www.google.com/search?q=' + q('translate ' + m[1] + ' to ' + m[2]);
  if ((m = x.match(/(?:weather)(?:\s+(?:in|for|at)\s+(.+))?/))) return 'https://www.google.com/search?q=' + q('weather ' + (m[1] || ''));
  if ((m = x.match(/(?:search amazon for|on amazon|buy|order)\s+(.+)/))) return 'https://www.amazon.com/s?k=' + q(m[1]);
  if ((m = x.match(/open\s+(https?:\/\/\S+)/))) return clean(m[1]);
  if ((m = x.match(/(?:open|go to)\s+([a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/))) return 'https://' + clean(m[1]);
  if ((m = x.match(/(?:google|search(?: for)?|look up|web search)\s+(.+)/))) return 'https://www.google.com/search?q=' + q(m[1]);
  return null;
}

export function JarvisHome() {
  const navigate = useNavigate();
  const [health, setHealth] = useState<Health | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [reminders, setReminders] = useState<TimerItem[]>([]);
  const [clientTimers, setClientTimers] = useState<ClientTimer[]>(() => {
    try {
      const raw = localStorage.getItem('jarvis_client_timers');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [nowTick, setNowTick] = useState<number>(Date.now() / 1000);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [clientMessages, setClientMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem('jarvis_client_messages');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const REMOTE = isRemoteClient();
  const [remoteModel, setRemoteModel] = useState('qwen2.5:7b');
  const [remoteRecording, setRemoteRecording] = useState(false);
  const remoteRecRef = useRef<MediaRecorder | null>(null);
  const remoteChunksRef = useRef<Blob[]>([]);
  const remoteChatRef = useRef<(t: string) => void>(() => {});
  const toggleRemoteMicRef = useRef<() => void>(() => {});
  const [wakeOn, setWakeOn] = useState(false);
  const [wakeStatus, setWakeStatus] = useState('');
  const [deepMode, setDeepMode] = useState(() => { try { return localStorage.getItem('jarvis_deep') === 'on'; } catch { return false; } });
  const [srvTimers, setSrvTimers] = useState<{ id: number; fire: number; label: string; kind: string }[]>([]);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  const [srvNotes, setSrvNotes] = useState<{ id: number; text: string }[]>([]);
  const [timerInput, setTimerInput] = useState('');
  const [weatherCard, setWeatherCard] = useState<any>(null);
  const wxDismissed = useRef(0);
  const [briefingCard, setBriefingCard] = useState<any>(null);
  const brDismissed = useRef(0);
  const [news, setNews] = useState<any[]>([]);
  const [healthCard, setHealthCard] = useState<any>(null);
  const hcDismissed = useRef(0);
  const [financeCard, setFinanceCard] = useState<any>(null);
  const fcDismissed = useRef(0);
  const [fileMatches, setFileMatches] = useState<any>(null);
  const fmDismissed = useRef(0);
  const [srvStatus, setSrvStatus] = useState<any>({ state: 'idle', level: 0, heard: '', playing: '' });
  const [srvMemory, setSrvMemory] = useState<{ id: number; text: string }[]>([]);
  const [noteInput, setNoteInput] = useState('');
  const [memInput, setMemInput] = useState('');
  const [showCheats, setShowCheats] = useState(false);
  const [showMem, setShowMem] = useState(false);
  const [boot, setBoot] = useState(() => { try { return !sessionStorage.getItem('jarvis_booted'); } catch { return true; } });
  const [srvSys, setSrvSys] = useState<any>(null);
  const [hudPos, setHudPos] = useState(() => { try { return JSON.parse(localStorage.getItem('jarvis_hudpos') || '') || { x: 14, y: 14 }; } catch { return { x: 14, y: 14 }; } });
  const sendUi = (cmd: string) => { fetch(getBase() + '/uicommand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) }).catch(() => {}); };
  const stColor = (st: string) => st === 'listening' ? '#16a34a' : st === 'thinking' ? '#eab308' : st === 'speaking' ? 'rgba(34, 211, 238, 0.85)' : '#6b7280';
  const stLabel = (st: string) => st === 'listening' ? 'Listening' : st === 'thinking' ? 'Thinking' : st === 'speaking' ? 'Speaking' : 'Idle';
  const qBtn: any = { width: 40, height: 40, borderRadius: 12, border: '1px solid rgba(125, 249, 255, 0.18)', background: 'rgba(10, 25, 47, 0.62)', color: 'rgba(220, 240, 255, 0.95)', cursor: 'pointer', fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const inStyle: any = { padding: '7px 10px', borderRadius: 10, border: '1px solid rgba(125, 249, 255, 0.18)', background: 'rgba(10, 25, 47, 0.62)', color: 'rgba(220, 240, 255, 0.95)', fontSize: 13, outline: 'none' };
  const wxEmoji = (c: number) => {
    if (c === 0) return '☀️';
    if (c <= 2) return '🌤️';
    if (c === 3) return '☁️';
    if (c <= 48) return '🌫️';
    if (c <= 57) return '🌦️';
    if (c <= 67) return '🌧️';
    if (c <= 77) return '❄️';
    if (c <= 82) return '🌧️';
    if (c <= 86) return '❄️';
    return '⛈️';
  };
  const wxGradient = (c: number) => {
    if (c === 0 || c <= 2) return 'linear-gradient(135deg,#2980b9,#6dd5fa)';
    if (c === 3 || c <= 48) return 'linear-gradient(135deg,#485563,#29323c)';
    if (c <= 67 || (c >= 80 && c <= 82)) return 'linear-gradient(135deg,#3a6073,#16222a)';
    if ((c >= 71 && c <= 77) || c >= 85) return 'linear-gradient(135deg,#83a4d4,#b6fbff)';
    return 'linear-gradient(135deg,#373b44,#4286f4)';
  };
  const briefRing = (value: number, label: string, max = 21) => {
    const r = 26, circ = 2 * Math.PI * r, pct = Math.max(0, Math.min(1, value / max)), off = circ * (1 - pct);
    const col = pct > 0.66 ? '#ff7a59' : pct > 0.4 ? '#7df9ff' : '#34d399';
    return (
      <div style={{ textAlign: 'center', width: 74 }}>
        <svg width="62" height="62" viewBox="0 0 62 62">
          <circle cx="31" cy="31" r="26" fill="none" stroke="rgba(125,249,255,0.12)" strokeWidth="5" />
          <circle cx="31" cy="31" r="26" fill="none" stroke={col} strokeWidth="5" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} transform="rotate(-90 31 31)" style={{ filter: `drop-shadow(0 0 5px ${col})`, transition: 'stroke-dashoffset 1.1s cubic-bezier(.2,.9,.3,1)' }} />
          <text x="31" y="33" textAnchor="middle" dominantBaseline="middle" fill="#eaffff" fontSize="15" fontWeight="700" fontFamily="ui-monospace, monospace">{value}</text>
        </svg>
        <div style={{ fontSize: 9, opacity: 0.72, fontFamily: 'ui-monospace, monospace', letterSpacing: 0.5, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      </div>
    );
  };
  const hudLabel = (txt: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 2, opacity: 0.68, marginBottom: 10 }}><span style={{ width: 12, height: 1, background: 'rgba(125,249,255,0.7)' }} />{txt}<span style={{ flex: 1, height: 1, background: 'rgba(125,249,255,0.12)' }} /></div>
  );
  const panelStyle: any = { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(125,249,255,0.12)', borderRadius: 16, padding: '14px 15px' };
  const metricTile = (value: any, label: string, unit = '', accent = '#7df9ff') => (
    <div style={{ textAlign: 'center', minWidth: 58 }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 22, fontWeight: 300, lineHeight: 1, color: (value === null || value === undefined) ? 'rgba(255,255,255,0.32)' : accent }}>{(value === null || value === undefined) ? '--' : value}<span style={{ fontSize: 11, opacity: 0.7 }}>{unit}</span></div>
      <div style={{ fontSize: 9, opacity: 0.6, fontFamily: 'ui-monospace, monospace', letterSpacing: 1, marginTop: 4 }}>{label}</div>
    </div>
  );
  const glanceTile = (value: any, label: string, accent = '#c6f6ff') => (
    <div style={{ flex: '1 1 88px', minWidth: 88, padding: '12px 10px', borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(125,249,255,0.12)', textAlign: 'center', animation: 'hudCascade .5s ease both' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent, lineHeight: 1, textShadow: '0 0 14px rgba(34,211,238,0.4)' }}>{value}</div>
      <div style={{ fontSize: 9, opacity: 0.6, fontFamily: 'ui-monospace, monospace', letterSpacing: 1.5, marginTop: 5, textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
  const recoveryRing = (pct: any) => {
    const has = pct !== null && pct !== undefined;
    const v = has ? Math.max(0, Math.min(100, pct)) : 0;
    const r = 40, circ = 2 * Math.PI * r, off = circ * (1 - v / 100);
    const col = !has ? 'rgba(125,249,255,0.3)' : v >= 67 ? '#34d399' : v >= 34 ? '#fbbf24' : '#ff6b6b';
    return (
      <svg width="96" height="96" viewBox="0 0 96 96" style={{ flexShrink: 0 }}>
        <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(125,249,255,0.1)" strokeWidth="7" />
        <circle cx="48" cy="48" r="40" fill="none" stroke={col} strokeWidth="7" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={has ? off : circ} transform="rotate(-90 48 48)" style={{ filter: `drop-shadow(0 0 6px ${col})`, transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.9,.3,1)' }} />
        <text x="48" y="46" textAnchor="middle" fill="#eaffff" fontSize="23" fontWeight="700" fontFamily="ui-monospace, monospace">{has ? v : '--'}</text>
        <text x="48" y="62" textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="8.5" fontFamily="ui-monospace, monospace" letterSpacing="1">RECOVERY</text>
      </svg>
    );
  };
  const wakeWsRef = useRef<WebSocket | null>(null);
  const wakeCtxRef = useRef<AudioContext | null>(null);
  const wakeStreamRef = useRef<MediaStream | null>(null);
  const wakeNodeRef = useRef<AudioWorkletNode | null>(null);
  const wakeBusyRef = useRef(false);
  const wakeToggleRef = useRef<() => void>(() => {});
  const [pendingLink, setPendingLink] = useState<{ url: string; label: string } | null>(null);
  const justOpenedRef = useRef('');
  useEffect(() => {
    if (!REMOTE) return;
    fetchModels().then((m) => { if (m && m[0]) setRemoteModel(m[0].id); }).catch(() => {});
    setClientMessages([]);
    const _bt = setTimeout(() => { setBoot(false); try { sessionStorage.setItem('jarvis_booted', '1'); } catch { /* */ } }, 2300);
    void _bt;
    try { localStorage.removeItem('jarvis_client_messages'); } catch { /* ignore */ }
  }, [REMOTE]);

  useEffect(() => {
    if (!REMOTE) return;
    const loadNews = async () => {
      try { const r = await fetch(`${getBase()}/news`); const d = await r.json(); if (d && d.items) setNews(d.items); } catch { /* */ }
    };
    loadNews();
    const _ni = setInterval(loadNews, 1800000);
    return () => clearInterval(_ni);
  }, [REMOTE]);

  useEffect(() => {
    if (!REMOTE) return;
    const fetchTimers = async () => {
      try {
        const r = await fetch(`${getBase()}/timers`);
        const d = await r.json();
        setSrvTimers(d.timers || []);
        const rn = await fetch(`${getBase()}/notes`);
        const dn = await rn.json();
        setSrvNotes(dn.notes || []);
        const rw = await fetch(`${getBase()}/weather`);
        const dw = await rw.json();
        if (dw && dw.ts && dw.ts > Date.now() / 1000 - 25 && dw.ts !== wxDismissed.current) {
          setWeatherCard(dw);
        } else if (!dw || !dw.ts || dw.ts <= Date.now() / 1000 - 25) {
          setWeatherCard(null);
        }
        const rb = await fetch(`${getBase()}/briefing`);
        const db = await rb.json();
        if (db && db.ts && db.ts > Date.now() / 1000 - 30 && db.ts !== brDismissed.current) {
          setBriefingCard(db);
        }
        const rh = await fetch(`${getBase()}/healthdash`);
        const dh = await rh.json();
        if (dh && dh.ts && dh.ts > Date.now() / 1000 - 30 && dh.ts !== hcDismissed.current) {
          setHealthCard(dh);
        }
        const rf2 = await fetch(`${getBase()}/finance`);
        const df2 = await rf2.json();
        if (df2 && df2.ts && df2.ts > Date.now() / 1000 - 30 && df2.ts !== fcDismissed.current) {
          setFinanceCard(df2);
        }
        const rf = await fetch(`${getBase()}/filematches`);
        const df = await rf.json();
        if (df && df.matches && df.matches.length > 0 && df.ts > Date.now() / 1000 - 180 && df.ts !== fmDismissed.current) {
          setFileMatches(df);
        } else if (!df || !df.matches || df.matches.length === 0) {
          setFileMatches(null);
        }
        const rmem = await fetch(`${getBase()}/memory`);
        setSrvMemory((await rmem.json()).items || []);
        const rss = await fetch(`${getBase()}/sysstats`);
        setSrvSys(await rss.json());
      } catch { /* ignore */ }
    };
    fetchTimers();
    const id = setInterval(() => { setNowSec(Date.now() / 1000); fetchTimers(); }, 1000);
    const sid = setInterval(async () => { try { const rs = await fetch(`${getBase()}/status`); setSrvStatus(await rs.json()); } catch { /* */ } }, 350);
    return () => { clearInterval(id); clearInterval(sid); };
  }, [REMOTE]);

  const refresh = useCallback(async () => {
    if (REMOTE) {
      try {
        const r = await fetch(`${getBase()}/health`);
        setReachable(r.ok);
        setHealth({ ok: true, whisper_ready: true, kokoro_ready: true, pipeline_busy: false });
        const cr = await fetch(`${getBase()}/chat_log?after=0`);
        const cd = await cr.json();
        setMessages((cd.messages || []).map((mm: { id: number; role: string; content: string; timestamp: number }) => ({ id: mm.id, role: mm.role as 'user' | 'assistant', content: mm.content, timestamp: mm.timestamp })));
      } catch { setReachable(false); }
      return;
    }
    try {
      const [hr, cr] = await Promise.all([
        fetch(`${VOICE_LOOP_URL}/health`),
        fetch(`${VOICE_LOOP_URL}/chat_log?after=0`),
      ]);
      setHealth(await hr.json());
      const c = await cr.json();
      setMessages(c.messages ?? []);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, [REMOTE]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 700);
    return () => clearInterval(id);
  }, [refresh]);

  // Hardware-Stats — separater Poll (alle 2s reicht)
  useEffect(() => {
    let cancelled = false;
    const fetchHw = async () => {
      if (REMOTE) return;
      try {
        const r = await fetch(`${VOICE_LOOP_URL}/hardware`);
        if (!cancelled) setHardware(await r.json());
      } catch { /* ignore */ }
    };
    fetchHw();
    const id = setInterval(fetchHw, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ============ #3 Wake-Acknowledgement ============
  // Pollt /events alle 700ms; bei einem NEUEN Wake-Event (id steigt) sofort
  // ein zufaelliges kurzes Ack via /say sprechen, waehrend Voice-Loop noch denkt.
  const lastWakeIdRef = useRef<number>(0);
  useEffect(() => {
    let cancelled = false;
    const ackPhrases = [
      'Yes, sir?',
      'One moment.',
      'Right away.',
      'Listening.',
      'Yes?',
    ];
    const check = async () => {
      if (REMOTE) return;
      try {
        const r = await fetch(`${VOICE_LOOP_URL}/health`);
        if (!r.ok) return;
        const h = await r.json();
        const newest = h.last_wake_event_id ?? 0;
        if (newest > 0 && newest !== lastWakeIdRef.current) {
          // Bei initialem load NICHT triggern
          if (lastWakeIdRef.current !== 0) {
            const phrase = ackPhrases[Math.floor(Math.random() * ackPhrases.length)];
            speakViaResolver(phrase);
          }
          lastWakeIdRef.current = newest;
        }
      } catch { /* ignore */ }
      if (!cancelled) setTimeout(check, 700);
    };
    check();
    return () => { cancelled = true; };
  }, []);

  // ============ #7 Reminder Pre-Warning (60s vorher) ============
  const warnedReminderIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const t = nowTick;
    for (const r of reminders) {
      if (warnedReminderIdsRef.current.has(r.id)) continue;
      const secsUntil = r.fire_at - t;
      // Warnung im Fenster 50..70s vor Fire
      if (secsUntil <= 65 && secsUntil >= 50) {
        warnedReminderIdsRef.current.add(r.id);
        const msg = `In one minute, sir: ${r.message}.`;
        speakViaResolver(msg);
        try {
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('JARVIS Reminder (1 min)', { body: r.message, tag: `rem-pre-${r.id}` });
          }
        } catch { /* ignore */ }
      }
    }
  }, [nowTick, reminders]);

  // ============ #9 Idle / Hardware-Awareness ============
  // Alle 60s checkt Resolver /hardware_warn. Resolver hat Anti-Spam (10min cooldown).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${RESOLVER_URL}/hardware_warn`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.warn && !cancelled) {
          speakViaResolver(d.warn);
        }
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 60_000);
    // initial check nach 30s (nicht direkt bei mount)
    const initial = setTimeout(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); clearTimeout(initial); };
  }, []);

  // Timers / Reminders — poll alle 2s
  useEffect(() => {
    let cancelled = false;
    const fetchTimers = async () => {
      try {
        const r = await fetch(`${VOICE_LOOP_URL}/timers`);
        const d = await r.json();
        if (!cancelled) {
          setTimers(d.timers ?? []);
          setReminders(d.reminders ?? []);
        }
      } catch { /* ignore */ }
    };
    fetchTimers();
    const id = setInterval(fetchTimers, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Live-Countdown-Tick — jede Sekunde
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  // ClientTimer persist + Fire-Check
  useEffect(() => {
    try { localStorage.setItem('jarvis_client_timers', JSON.stringify(clientTimers)); }
    catch { /* ignore */ }
  }, [clientTimers]);

  // Pruefen welche Timer gerade gefired sind: 3s Alarm-Sound + TTS via /say
  useEffect(() => {
    const due = clientTimers.filter((t) => !t.fired && t.fire_at <= nowTick);
    if (due.length === 0) return;
    flashMood('success', 5000); // Orb leuchtet grün beim Fire
    for (const t of due) {
      playAlarmBeep(3.0);
      const msg = t.name && t.name.trim()
        ? `Sir, your ${t.name} timer is up.`
        : 'Sir, your timer is up.';
      setTimeout(() => { speakViaResolver(msg); }, 3200); // nach dem Beep
      // Browser-Notification falls Tab nicht aktiv
      try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('JARVIS Timer', {
            body: msg,
            tag: `timer-${t.id}`,
            requireInteraction: true,
          });
        }
      } catch { /* ignore */ }
    }
    setClientTimers((prev) => prev.map((t) =>
      due.find((d) => d.id === t.id) ? { ...t, fired: true } : t
    ));
    // gefirede Timer nach 8s automatisch wegraeumen
    setTimeout(() => {
      setClientTimers((prev) => prev.filter((t) => !due.find((d) => d.id === t.id)));
    }, 8000);
  }, [nowTick, clientTimers]);

  const playAlarmBeep = (durationSec: number) => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      // Drei kurze 800Hz Tones — Siri-Style
      for (let i = 0; i < 6; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = i % 2 === 0 ? 880 : 660;
        gain.gain.setValueAtTime(0, now + i * 0.45);
        gain.gain.linearRampToValueAtTime(0.3, now + i * 0.45 + 0.02);
        gain.gain.linearRampToValueAtTime(0, now + i * 0.45 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.45);
        osc.stop(now + i * 0.45 + 0.3);
      }
      setTimeout(() => ctx.close().catch(() => {}), durationSec * 1000 + 500);
    } catch (e) { console.warn('alarm sound failed', e); }
  };

  const dismissTimer = async (id: number) => {
    // voice-loop reminder via Resolver-Proxy (Voice-Loop CORS blockt DELETE direkt)
    await fetch(`${RESOLVER_URL}/proxy_voiceloop_delete_timer/${id}`).catch(() => {});
    setTimers((prev) => prev.filter((t) => t.id !== id));
    setReminders((prev) => prev.filter((r) => r.id !== id));
  };

  const dismissClientTimer = (id: string) => {
    setClientTimers((prev) => prev.filter((t) => t.id !== id));
  };

  // Auto-scroll History zum neuesten
  useEffect(() => {
    if (historyScrollRef.current) {
      historyScrollRef.current.scrollTop = historyScrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const triggerWake = async () => {
    if (REMOTE) { toggleRemoteMicRef.current(); return; }
    setSubmitting(true);
    try { await fetch(`${VOICE_LOOP_URL}/trigger`, { method: 'POST' }); }
    finally { setSubmitting(false); }
  };

  // Erkennt aus einer Jarvis-Antwort die zugehoerige URL.
  // Wird genutzt weil der Voice-Loop in Windows Session 0 lebt und keinen
  // Browser-Tab im User-Desktop oeffnen kann — also macht das Frontend
  // window.open() selbst (im User-Gesture-Kontext nach Enter-Press).
  // ============ Mic-Barge-In: WebRTC mit Echo-Cancellation ============
  // Wenn der User waehrend laufender TTS spricht, brechen wir die TTS ab.
  // Browser-getUserMedia mit echoCancellation:true entfernt unser eigenes
  // TTS-Audio aus dem Mic-Signal — kein false-trigger durch Self-Audio.
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const ensureMicForBargeIn = useCallback(async (audioCtx: AudioContext): Promise<void> => {
    if (micAnalyserRef.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      micAnalyserRef.current = analyser;
    } catch (err) {
      console.warn('mic for bargein denied/failed', err);
    }
  }, []);

  // ============ Frontend-TTS: Resolver /tts + Web-Audio-Visualizer + Subtitles ============
  // Anstatt Voice-Loop /say (server-side sd.play, kein audio access) gehen wir
  // ueber Resolver /tts → bekommen mp3-bytes + word boundaries → spielen im Browser →
  // analysieren Amplitude live → pulsen den Orb (event "openjarvis-speech-level")
  // → zeigen Subtitles synchron mit word-timings.
  const [subtitle, setSubtitle] = useState<string>('');
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsCtxRef = useRef<AudioContext | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsRafRef = useRef<number>(0);
  const ttsSubTimersRef = useRef<number[]>([]);

  const speakViaResolver = useCallback(async (text: string) => {
    const clean = (text || '').trim();
    if (!clean) return;
    try {
      // vorherige TTS abbrechen
      if (ttsAudioRef.current) {
        try { ttsAudioRef.current.pause(); } catch { /* ignore */ }
        ttsAudioRef.current = null;
      }
      if (ttsRafRef.current) cancelAnimationFrame(ttsRafRef.current);
      ttsSubTimersRef.current.forEach((t) => clearTimeout(t));
      ttsSubTimersRef.current = [];
      setSubtitle('');

      const r = await fetch(`${(REMOTE ? getBase() : RESOLVER_URL)}/tts?text=${encodeURIComponent(clean)}`);
      if (!r.ok) throw new Error('tts http ' + r.status);
      const d = await r.json();
      if (!d.ok || !d.audio_b64) throw new Error(d.reason || 'tts failed');

      // Base64 -> Uint8Array -> Blob -> ObjectURL
      const raw = atob(d.audio_b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: d.mime || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous';
      ttsAudioRef.current = audio;

      // AudioContext + Analyser einrichten
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!ttsCtxRef.current || ttsCtxRef.current.state === 'closed') {
        ttsCtxRef.current = new Ctx();
      }
      const ctx = ttsCtxRef.current;
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* ignore */ }
      }
      const src = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      ttsAnalyserRef.current = analyser;

      // Mic-Setup fuer Barge-In (einmalig, async, kein await — non-blocking)
      ensureMicForBargeIn(ctx);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const micBuf = new Uint8Array(256);
      let sustainedLoud = 0;
      const BARGE_THRESHOLD = 70; // 0..255, etwa "Sprech-laut"
      const BARGE_FRAMES = 12;    // ~200ms sustained
      const tick = () => {
        if (!ttsAnalyserRef.current || !ttsAudioRef.current || ttsAudioRef.current.paused) return;
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i];
        const avg = sum / buf.length / 255; // 0..1
        window.dispatchEvent(new CustomEvent('openjarvis-speech-level', { detail: { level: avg } }));

        // Mic-Barge-In check — nur wenn mic verfuegbar und TTS gerade aktiv
        if (micAnalyserRef.current) {
          micAnalyserRef.current.getByteFrequencyData(micBuf);
          let micSum = 0;
          for (let i = 0; i < micBuf.length; i += 1) micSum += micBuf[i];
          const micAvg = micSum / micBuf.length;
          if (micAvg > BARGE_THRESHOLD) {
            sustainedLoud += 1;
            if (sustainedLoud >= BARGE_FRAMES) {
              // Barge-In!
              try { ttsAudioRef.current.pause(); } catch { /* ignore */ }
              ttsSubTimersRef.current.forEach((t) => clearTimeout(t));
              ttsSubTimersRef.current = [];
              setSubtitle('');
              window.dispatchEvent(new CustomEvent('openjarvis-bargein'));
              if (ttsRafRef.current) cancelAnimationFrame(ttsRafRef.current);
              return;
            }
          } else {
            sustainedLoud = Math.max(0, sustainedLoud - 1);
          }
        }
        ttsRafRef.current = requestAnimationFrame(tick);
      };

      // Subtitle-Stream: pro word ein setTimeout
      const words: { offset_ms: number; duration_ms: number; text: string }[] = d.words || [];
      let buffer = '';
      for (const w of words) {
        const t = window.setTimeout(() => {
          buffer = (buffer + ' ' + w.text).trim().slice(-120);
          setSubtitle(buffer);
        }, w.offset_ms);
        ttsSubTimersRef.current.push(t);
      }
      // Subtitle nach 4s Ende clearen
      const totalMs = words.length ? words[words.length - 1].offset_ms + words[words.length - 1].duration_ms + 500 : 4000;
      const clearT = window.setTimeout(() => setSubtitle(''), totalMs + 2500);
      ttsSubTimersRef.current.push(clearT);

      audio.addEventListener('play', () => {
        ttsRafRef.current = requestAnimationFrame(tick);
      });
      audio.addEventListener('ended', () => {
        if (ttsRafRef.current) cancelAnimationFrame(ttsRafRef.current);
        URL.revokeObjectURL(url);
        ttsAudioRef.current = null;
      });
      audio.addEventListener('error', () => {
        if (ttsRafRef.current) cancelAnimationFrame(ttsRafRef.current);
        URL.revokeObjectURL(url);
      });

      try { await audio.play(); } catch (err) { console.warn('audio.play failed', err); }
    } catch (err) {
      console.warn('speakViaResolver failed', err);
    }
  }, []);

  // Frontend-Skills die der gelockte Voice-Loop NICHT kennt. Ruft Resolver,
  // formuliert Antwort, persistiert lokal, sagt via /say. Returnt true wenn
  // skill gegriffen hat.
  const tryFrontendSkill = async (input: string): Promise<boolean> => {
    const t = input.trim();
    const tl = t.toLowerCase();
    let reply: string | null = null;
    let m: RegExpMatchArray | null;

    try {
      // ============ MUSIC-STEUERUNG (YouTube Music + Media Keys) ============
      // Reihenfolge: spezifische Patterns vor generischen ("play X on music" vor "play X")
      const playMusicMatch =
        t.match(/^play\s+(.+?)\s+on\s+(?:youtube\s+)?music\.?$/i) ||
        t.match(/^play\s+music\s+(.+?)\.?$/i) ||
        t.match(/^play\s+(?!.+ on youtube)(.+?)\.?$/i);  // "play X" -> music (außer "on youtube" Suffix)
      if (playMusicMatch) {
        const q = playMusicMatch[1].trim();
        // pre-tab im User-Gesture (Enter) — Browser blockt window.open nach async fetch
        let preTab: Window | null = null;
        try { preTab = window.open('about:blank', '_blank'); } catch { preTab = null; }
        try {
          const r = await (await fetch(`${RESOLVER_URL}/resolve_youtube_music?q=${encodeURIComponent(q)}`)).json();
          const url = r.ok ? r.url : r.fallback_url;
          if (url) {
            if (preTab && !preTab.closed) {
              try { preTab.location.href = url; } catch { window.open(url, '_blank'); }
            } else { window.open(url, '_blank'); }
            reply = r.ok ? `Playing ${r.title}, sir.` : `Sir, opening music search for ${q}.`;
          } else {
            if (preTab && !preTab.closed) try { preTab.close(); } catch {}
            reply = `Sir, I couldn't find music for "${q}".`;
          }
        } catch {
          if (preTab && !preTab.closed) try { preTab.close(); } catch {}
          reply = "Sir, the music service is unavailable.";
        }
      } else if (/^(pause|pause (?:the )?(?:music|song|track|video)|stop (?:the )?(?:music|song|playback))\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=play_pause`).catch(() => {});
        reply = 'Paused.';
      } else if (/^(resume|continue(?: (?:the )?(?:music|playback))?|unpause|play(?: (?:the )?(?:music|song|track))?)\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=play_pause`).catch(() => {});
        reply = 'Resumed.';
      } else if (/^(next|next (?:song|track)|skip(?: (?:this|the) (?:song|track))?|skip ahead)\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=next`).catch(() => {});
        reply = 'Skipping ahead, sir.';
      } else if (/^(previous|previous (?:song|track)|back(?: (?:a )?(?:song|track))?|go back|play (?:the )?previous)\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=prev`).catch(() => {});
        reply = 'Going back, sir.';
      } else if ((m = t.match(/^(?:volume up|louder|turn (?:it |the volume )?up|crank it up)(?:\s+(?:a lot|a bit|more|by (\d+)))?\.?$/i))) {
        const count = m[1] ? Math.min(20, parseInt(m[1], 10)) : 5;
        await fetch(`${RESOLVER_URL}/media_key?key=vol_up&count=${count}`).catch(() => {});
        reply = 'Louder, sir.';
      } else if ((m = t.match(/^(?:volume down|softer|quieter|turn (?:it |the volume )?down|lower the volume)(?:\s+(?:a lot|a bit|more|by (\d+)))?\.?$/i))) {
        const count = m[1] ? Math.min(20, parseInt(m[1], 10)) : 5;
        await fetch(`${RESOLVER_URL}/media_key?key=vol_down&count=${count}`).catch(() => {});
        reply = 'Quieter, sir.';
      } else if (/^(mute|silence|shut up|be quiet)\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=mute`).catch(() => {});
        reply = 'Muted.';
      } else if (/^(unmute|sound on)\.?$/i.test(t)) {
        await fetch(`${RESOLVER_URL}/media_key?key=mute`).catch(() => {});
        reply = 'Sound on.';
      } else if ((m = t.match(/^(?:set (?:the )?volume (?:to |at ))?(\d{1,3})\s*(?:%|percent)\.?$/i))) {
        const level = Math.max(0, Math.min(100, parseInt(m[1], 10)));
        await fetch(`${RESOLVER_URL}/system_volume_set?level=${level}`).catch(() => {});
        reply = `Volume at ${level} percent, sir.`;
      } else if (/^(flip (?:a |the )?coin|heads or tails|coin flip)\b/.test(tl)) {
        const r = await (await fetch(`${RESOLVER_URL}/coin_flip`)).json();
        if (r.ok) reply = `Sir, ${r.result}.`;
      } else if ((m = tl.match(/^roll(?: an?| the)? (?:(\d+)[\s-]?sided )?(?:di(?:c)?e|dice)(?: (\d+) times)?/))) {
        const sides = m[1] ? parseInt(m[1], 10) : 6;
        const count = m[2] ? parseInt(m[2], 10) : 1;
        const r = await (await fetch(`${RESOLVER_URL}/roll_dice?sides=${sides}&count=${count}`)).json();
        if (r.ok) reply = count > 1
          ? `Sir, rolled ${r.rolls.join(', ')} — total ${r.total}.`
          : `Sir, you rolled a ${r.rolls[0]}.`;
      } else if ((m = tl.match(/^(?:random number|give me a number)(?: between (\d+) and (\d+))?/))) {
        const lo = m[1] ? parseInt(m[1], 10) : 1;
        const hi = m[2] ? parseInt(m[2], 10) : 100;
        const r = await (await fetch(`${RESOLVER_URL}/random_number?min=${lo}&max=${hi}`)).json();
        if (r.ok) reply = `Sir, ${r.value}.`;
      } else if (/^(tell me a joke|joke please|make me laugh)/.test(tl)) {
        const r = await (await fetch(`${RESOLVER_URL}/joke`)).json();
        if (r.ok) reply = r.joke;
      } else if (/^(tell me a (?:fun )?fact|fun fact|random fact)/.test(tl)) {
        const r = await (await fetch(`${RESOLVER_URL}/fact`)).json();
        if (r.ok) reply = r.fact;
      } else if (/^(give me a quote|inspire me|quote please)/.test(tl)) {
        const r = await (await fetch(`${RESOLVER_URL}/quote`)).json();
        if (r.ok) reply = `"${r.content}" — ${r.author}`;
      } else if ((m = t.match(/^(?:define|what does)\s+([a-zA-Z][a-zA-Z\s-]*?)\s*(?:mean)?\??$/i))) {
        const word = m[1].trim();
        const r = await (await fetch(`${RESOLVER_URL}/define?q=${encodeURIComponent(word)}`)).json();
        if (r.ok) reply = `${r.word} (${r.part_of_speech}): ${r.definition}`;
        else reply = `Sir, I couldn't find a definition for "${word}".`;
      } else if ((m = t.match(/^(?:search (?:for |the web for )|web search (?:for )?|look up |find (?:out )?(?:about )?|tell me what (?:is |was )?(?:happening|going on)(?:\s+with)?\s+|what's (?:new |the latest )?(?:about|with|on)\s+)(.+?)\??\.?$/i))) {
        const q = m[1].trim();
        try {
          const r = await (await fetch(`${RESOLVER_URL}/web_search?q=${encodeURIComponent(q)}`)).json();
          if (r.ok && r.answer) {
            // Top-Sätze sprechen (max 2)
            const sentences = r.answer.split('. ').slice(0, 2).join('. ').trim();
            reply = sentences.endsWith('.') ? sentences : sentences + '.';
          } else if (r.fallback_url) {
            try { window.open(r.fallback_url, '_blank'); } catch { /* ignore */ }
            reply = `Sir, I couldn't find a direct answer — opening a search for "${q}".`;
          } else reply = `Sir, no clear answer on "${q}".`;
        } catch { reply = "Sir, the search service is unavailable."; }
      } else if (/^(explain (?:this |my )?(?:code|clipboard|text)|what does (?:this|my clipboard) (?:do|mean|say)|read (?:my )?clipboard)\.?$/i.test(t)) {
        try {
          const cb = await (await fetch(`${RESOLVER_URL}/clipboard`)).json();
          if (!cb.ok || !cb.text) {
            reply = "Sir, the clipboard appears to be empty.";
          } else {
            const ex = await (await fetch(`${RESOLVER_URL}/explain`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: cb.text, mode: 'auto' }),
            })).json();
            reply = ex.ok ? ex.explanation : "Sir, I couldn't explain that.";
          }
        } catch { reply = "Sir, the analysis service is unavailable."; }
      } else if ((m = t.match(/^(?:translate|say) (?:["']?(.+?)["']?) (?:to|in|into) ([a-zA-Z]+)\.?$/i))) {
        const text2translate = m[1].trim();
        const targetLang = m[2].trim();
        try {
          const r = await (await fetch(`${RESOLVER_URL}/translate?text=${encodeURIComponent(text2translate)}&to=${encodeURIComponent(targetLang)}`)).json();
          reply = r.ok ? r.translation : `Sir, translation failed.`;
        } catch { reply = "Sir, the translation service is unavailable."; }
      } else if ((m = t.match(/^(?:how (?:do|would) (?:you|i) say) ["']?(.+?)["']? in ([a-zA-Z]+)\??$/i))) {
        const text2translate = m[1].trim();
        const targetLang = m[2].trim();
        try {
          const r = await (await fetch(`${RESOLVER_URL}/translate?text=${encodeURIComponent(text2translate)}&to=${encodeURIComponent(targetLang)}`)).json();
          reply = r.ok ? `In ${targetLang}: ${r.translation}` : `Sir, translation failed.`;
        } catch { reply = "Sir, the translation service is unavailable."; }
      } else if (/^(good morning|good afternoon|good evening|good day|morning briefing|evening briefing|daily briefing|brief me|what's on today)\b/i.test(tl)) {
        sendUi('good morning');
        try {
          const r = await (await fetch(`${RESOLVER_URL}/morning_briefing`)).json();
          if (r.ok) reply = r.briefing;
        } catch { reply = 'Sir, the briefing service is unavailable.'; }
      } else if (/^(what'?s? the weather|how'?s the weather|weather (today|now)|is it (going to|gonna) rain)/i.test(tl)) {
        try {
          const r = await (await fetch(`${RESOLVER_URL}/weather`)).json();
          if (r.ok) {
            const cur = Math.round(r.current_temp_c);
            const cond = r.current_condition;
            const tmax = Math.round(r.today_max_c);
            const tmin = Math.round(r.today_min_c);
            const precip = r.today_precip_prob;
            reply = `Currently ${cur} degrees and ${cond}, sir. Today's range: ${tmin} to ${tmax} degrees${precip > 30 ? `, with a ${precip}% chance of precipitation` : ''}.`;
          } else reply = "Sir, I couldn't fetch the weather.";
        } catch { reply = "Sir, the weather service is unavailable."; }
      } else if ((m = t.match(/^(?:remember that |please remember |note that )?(?:i |my |the )?(.+)$/i)) && /^(remember that|please remember|note that|jot down|make a note)\b/i.test(t)) {
        // strict: nur wenn EXPLIZIT "remember that ..." am Anfang
        const factMatch = t.match(/^(?:remember that |please remember (?:that )?|note that |jot down |make a note (?:that )?)\s*(.+?)\.?$/i);
        if (factMatch) {
          const fact = factMatch[1].trim();
          try {
            const r = await (await fetch(`${RESOLVER_URL}/user_profile/remember`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fact }),
            })).json();
            reply = r.ok && !r.noop
              ? `Noted, sir. Filed under your profile.`
              : r.noop
                ? `Already remembered, sir.`
                : `Sir, I couldn't save that.`;
          } catch { reply = `Sir, the profile service is unavailable.`; }
        }
      } else if ((m = t.match(/^(?:tell me about|who is|what is|who was|what was|wikipedia)\s+(.+?)\??$/i))) {
        const topic = m[1].trim().replace(/^the\s+/i, '');
        const r = await (await fetch(`${RESOLVER_URL}/wiki?q=${encodeURIComponent(topic)}`)).json();
        if (r.ok) {
          const sentence = (r.extract || '').split('. ')[0];
          reply = `Sir, ${r.title}: ${sentence}.`;
        } else {
          reply = `Sir, I couldn't find anything about "${topic}".`;
        }
      } else if ((m = t.match(/^search youtube (?:for )?(.+?)\.?$/i)) ||
                 (m = t.match(/^youtube search (?:for )?(.+?)\.?$/i))) {
        const q = m[1].trim();
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        try { window.open(url, '_blank'); } catch { /* ignore */ }
        reply = `Sir, searching YouTube for ${q}.`;
      } else if ((() => {
        // Filler entfernen: "for me/myself/us" am Ende; "me/us/you" nach Verb
        let stripped = t
          .replace(/\s+for (?:me|myself|us)\.?\??$/i, '')
          .replace(/\.?\??$/, '');
        // "make me a X" -> "make a X"; "give me a X" -> "give a X"
        stripped = stripped.replace(
          /^((?:please |can you |could you |would you |would you please )?(?:set|create|make|give|start|begin|put on))\s+(?:me|us|you)\s+(?=an?\s)/i,
          '$1 '
        );
        const prefix = '(?:please |can you |could you |would you |would you please )?';
        const verb = '(?:set|create|make|start|begin|put on)';
        const verbOpt = '(?:(?:set|create|make|start|begin|put on)\\s+)?';
        const article = '(?:\\s+an?)?';
        const unit = '(seconds?|minutes?|hours?|mins?|hrs?|s|m|h)';
        // 1) "set a timer for 30 seconds called pizza"
        let mm = stripped.match(new RegExp(`^${prefix}${verb}${article}\\s+timer\\s+(?:for |of )?(\\d+)\\s*${unit}\\s+(?:called|named|for)\\s+(.+)$`, 'i'));
        if (mm) { m = mm; (m as RegExpMatchArray & { _kind: string })._kind = 'D_then_N'; return true; }
        // 2) "set a PIZZA timer for 30 seconds" — Name min 3 chars, kein Artikel/Pronomen
        const nameToken = '(?!(?:an?|me|us|you|him|her|them|the)\\s)([a-zA-Z][a-zA-Z\\s-]{2,}?)';
        mm = stripped.match(new RegExp(`^${prefix}${verb}${article}\\s+${nameToken}\\s+timer\\s+(?:for |of )?(\\d+)\\s*${unit}$`, 'i'));
        if (mm) { m = mm; (m as RegExpMatchArray & { _kind: string })._kind = 'N_then_D'; return true; }
        // 3) "30 seconds timer called pizza"
        mm = stripped.match(new RegExp(`^${prefix}${verbOpt}(?:an?\\s+)?(\\d+)\\s*${unit}\\s+timer\\s+(?:called |named |for )(.+)$`, 'i'));
        if (mm) { m = mm; (m as RegExpMatchArray & { _kind: string })._kind = 'D_then_N'; return true; }
        // 4) "set a timer for 30 seconds" — kein Name
        mm = stripped.match(new RegExp(`^${prefix}${verb}${article}\\s+timer\\s+(?:for |of )?(\\d+)\\s*${unit}$`, 'i'));
        if (mm) { m = mm; (m as RegExpMatchArray & { _kind: string })._kind = 'D'; return true; }
        // 5) "5 minute timer"
        mm = stripped.match(new RegExp(`^${prefix}${verbOpt}(?:an?\\s+)?(\\d+)\\s*${unit}\\s+timer$`, 'i'));
        if (mm) { m = mm; (m as RegExpMatchArray & { _kind: string })._kind = 'D'; return true; }
        return false;
      })()) {
        const kind = (m as RegExpMatchArray & { _kind?: string })._kind || 'D';
        let amount = 0, unit = '', name = '';
        const groups = m!.slice(1).filter((g): g is string => typeof g === 'string');
        if (kind === 'N_then_D') {
          // groups: [name, amount, unit]
          name = groups[0]; amount = parseInt(groups[1], 10); unit = groups[2];
        } else if (kind === 'D_then_N') {
          // groups: [amount, unit, name]
          amount = parseInt(groups[0], 10); unit = groups[1]; name = groups[2];
        } else {
          // 'D': groups: [amount, unit]
          amount = parseInt(groups[0], 10); unit = groups[1];
        }
        const unitL = unit.toLowerCase().replace(/s$/, '').replace(/^min$/, 'min').replace(/^hr$/, 'h');
        const unitSec: Record<string, number> = {
          s: 1, sec: 1, second: 1,
          m: 60, min: 60, minute: 60,
          h: 3600, hour: 3600,
        };
        const totalSec = amount * (unitSec[unitL] ?? 60);
        const fireAt = Date.now() / 1000 + totalSec;
        const newTimer: ClientTimer = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: name.trim(),
          fire_at: fireAt,
          fired: false,
        };
        setClientTimers((prev) => [...prev, newTimer]);
        const nameLabel = name ? ` "${name}"` : '';
        reply = `Sir, timer${nameLabel} set for ${amount} ${unit}.`;
      } else if (/^(?:please |can you |could you |would you )?(?:set|create|make|start|begin|put on)(?: an?)? timer\b/i.test(t)) {
        // "set a timer" ohne Dauer — Rueckfrage statt LLM-Fallback
        reply = 'Sir, how long should the timer run? Try "set a timer for 5 minutes" or "set a pizza timer for 30 seconds".';
      }
    } catch (err) {
      console.warn('frontend skill error', err);
      return false;
    }

    if (reply === null) return false;

    // Skill matched -> kurz 'success' Mood-Flash am Orb
    flashMood('success', 1200);

    const now = Date.now() / 1000;
    const baseId = Date.now();
    const userMsg: ChatMessage = { id: -baseId, role: 'user', content: t, timestamp: now };
    const asstMsg: ChatMessage = { id: -baseId - 1, role: 'assistant', content: reply, timestamp: now + 0.001 };
    setClientMessages((prev) => {
      const next = [...prev, userMsg, asstMsg].slice(-200);
      try { localStorage.setItem('jarvis_client_messages', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    speakViaResolver(reply);
    return true;
  };

  // Entscheidet ob die User-Eingabe wahrscheinlich einen Browser-Tab oeffnen
  // soll. Nur dann darf pre-tab (about:blank im User-Gesture) geoeffnet werden,
  // sonst sieht der User unnoetig einen leeren Tab fuer 1-6s.
  const isUrlIntent = (input: string): boolean => {
    const t = input.toLowerCase();
    return /\b(navigate (me )?to|directions to|how do i get to|show (me )?(a |the )?maps? (of |for |to )?|open (a |the )?maps? (of |for |to )?|maps? (of |for )|where is\b)/.test(t)
      || /\bfind\s+.+?\s+on (?:the )?maps?\b/.test(t)
      || /\b(play .+? on youtube|search youtube|search .+? on youtube|open youtube|go to youtube|youtube search)\b/.test(t)
      || /\b(google|search google|search for|web search|look up)\b/.test(t)
      || /\b(open spotify|play .+? on spotify|spotify search)\b/.test(t)
      || /\bopen (https?:\/\/|the browser|duckduckgo|github)/.test(t)
      || /\bsearch github\b/.test(t)
      || /\bopen (the )?(jarvis|frontend|obsidian)/.test(t);
  };

  const urlFromReply = (reply: string): string | null => {
    const r = reply.trim();
    let m;
    if ((m = r.match(/^Sir, opening map of (.+?)\.?$/i))) {
      return `https://www.google.com/maps/search/${encodeURIComponent(m[1])}`;
    }
    if ((m = r.match(/^Sir, searching YouTube for (.+?)\.?$/i))) {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}`;
    }
    // "Sir, playing TITLE." — yt-dlp hat den Track aufgeloest, Backend kann die
    // konkrete URL aber nicht mitliefern (Session-0-Architektur). Wir nehmen
    // den aufgeloesten Titel und oeffnen die YouTube-Suche — Treffer ist meist #1.
    if ((m = r.match(/^Sir, playing (.+?)\.?$/i))) {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}`;
    }
    if ((m = r.match(/^Sir, here's the YouTube search for (.+?)\.?$/i))) {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}`;
    }
    if (/^Sir, opening YouTube\.?$/i.test(r)) return 'https://www.youtube.com';
    if ((m = r.match(/^Sir, searching GitHub for (.+?)\.?$/i))) {
      return `https://github.com/search?q=${encodeURIComponent(m[1])}&type=repositories`;
    }
    if ((m = r.match(/^Sir, searching(?: Google)? for (.+?)\.?$/i))) {
      return `https://www.google.com/search?q=${encodeURIComponent(m[1])}`;
    }
    if ((m = r.match(/^Sir, opening Spotify search for (.+?)\.?$/i))) {
      return `https://open.spotify.com/search/${encodeURIComponent(m[1])}`;
    }
    if ((m = r.match(/^Sir, opening (https?:\/\/\S+?)\.?$/i))) return m[1];
    if (/^Sir, opening the browser\.?$/i.test(r)) return 'https://duckduckgo.com';
    if (/^Sir, opening the Jarvis frontend\.?$/i.test(r)) return 'http://127.0.0.1:5173';
    return null;
  };

  const sendText = async () => {
    if (REMOTE) { const q = text.trim(); if (!q || submitting) return; setText(''); if (/^(good morning|good afternoon|good evening|good day|morning briefing|evening briefing|daily briefing|brief me)\b/i.test(q)) sendUi('good morning'); if (/^(health|health dashboard|my health|recovery|biometrics)\b/i.test(q)) sendUi('health'); if (/\b(finance|finances|spending|expenses|ausgaben|finanzen|budget)\b/i.test(q)) sendUi('finance'); const _u = intentUrl(q); if (_u) { window.open(_u, '_blank'); justOpenedRef.current = _u; } remoteChatRef.current(q); inputRef.current?.focus(); return; }
    if (!text.trim() || submitting) return;
    // Beim ersten Send: Notification-Permission ASK (User-Gesture)
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch { /* ignore */ }
    setSubmitting(true);
    const t = text.trim();
    setText('');
    // Zuerst Frontend-Skill probieren (coin, dice, joke, define, ...)
    // — die laufen direkt am Resolver vorbei am gelockten Voice-Loop.
    const handled = await tryFrontendSkill(t);
    if (handled) {
      setSubmitting(false);
      inputRef.current?.focus();
      return;
    }
    // Pre-Open Tab im User-Gesture (Enter-Click). Async window.open spaeter
    // wuerde Chrome als Popup blocken. NUR oeffnen wenn Eingabe url-aehnlich
    // ist — sonst sieht der User unnoetig ein about:blank fuer 1-6s.
    let preTab: Window | null = null;
    if (isUrlIntent(t)) {
      try { preTab = window.open('about:blank', '_blank'); } catch { preTab = null; }
    }
    const lastSeenId = messages.length > 0 ? messages[messages.length - 1].id : 0;
    try {
      await fetch(`${VOICE_LOOP_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      });
      // bis zu 6s lang auf neue assistant-Message warten, dann URL extrahieren
      const deadline = Date.now() + 6000;
      let applied = false;
      while (Date.now() < deadline && !applied) {
        try {
          // Erst: saubere /actions Architektur (wird aktiv nach Voice-Loop-Restart)
          const ar = await fetch(`${VOICE_LOOP_URL}/actions`);
          if (ar.ok) {
            const ad = await ar.json();
            const actions: { type: string; url: string }[] = ad.actions ?? [];
            for (const a of actions) {
              if (a.type !== 'open_url') continue;
              if (!applied && preTab && !preTab.closed) {
                try { preTab.location.href = a.url; } catch { window.open(a.url, '_blank'); }
                applied = true;
              } else {
                window.open(a.url, '_blank');
              }
            }
            if (applied) break;
          }
          // Fallback: Pattern-Match auf neueste assistant-Antwort
          const cr = await fetch(`${VOICE_LOOP_URL}/chat_log`);
          const cd = await cr.json();
          const msgs: ChatMessage[] = cd.messages ?? [];
          const newAssistant = msgs
            .filter((m) => m.id > lastSeenId && m.role === 'assistant')
            .pop();
          if (newAssistant) {
            let url = urlFromReply(newAssistant.content);
            // Spezial-Fall "Sir, playing TITLE." — Resolver auf 8771 anfragen
            // um direkten Video-Link statt YouTube-Suche zu bekommen.
            const playMatch = newAssistant.content.match(/^Sir, playing (.+?)\.?$/i);
            if (playMatch) {
              try {
                const rr = await fetch(`${RESOLVER_URL}/resolve_youtube?q=${encodeURIComponent(playMatch[1])}`);
                const rd = await rr.json();
                if (rd.ok && rd.url) url = rd.url;
              } catch { /* fall back to search url from urlFromReply */ }
            }
            if (url) {
              if (preTab && !preTab.closed) {
                try { preTab.location.href = url; } catch { window.open(url, '_blank'); }
              } else {
                window.open(url, '_blank');
              }
              applied = true;
              break;
            } else {
              // Antwort kam aber war keine Browser-Action — preTab zumachen
              break;
            }
          }
        } catch { /* ignore polling errors */ }
        await new Promise((res) => setTimeout(res, 200));
      }
      if (!applied && preTab && !preTab.closed) {
        try { preTab.close(); } catch { /* ignore */ }
      }
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  };

  const interrupt = async () => {
    await fetch(`${VOICE_LOOP_URL}/interrupt`, { method: 'POST' });
  };

  const resetChat = async () => {
    // Loescht NUR den Chat-Log (Frontend-Anzeige). Conversation-Memory (LLM-Kontext)
    // bleibt bestehen, separat resetbar.
    await fetch(`${VOICE_LOOP_URL}/chat_log/clear`, { method: 'POST' });
    setClientMessages([]);
    try { localStorage.removeItem('jarvis_client_messages'); } catch { /* ignore */ }
    refresh();
  };

  const busy = health?.pipeline_busy ?? false;
  const ready = !!(health?.kokoro_ready && health?.whisper_ready);

  const activity = !reachable ? 0.15 : busy ? 1.0 : ready ? 0.55 : 0.3;
  const voice = busy ? 0.6 : 0;

  // Mood-Flash State — Skills setzen kurz 'success' / 'error', dann zurueck
  const [moodFlash, setMoodFlash] = useState<{ mood: OrbMood; until: number } | null>(null);
  useEffect(() => {
    if (!moodFlash) return;
    const remaining = moodFlash.until - Date.now();
    if (remaining <= 0) { setMoodFlash(null); return; }
    const tid = setTimeout(() => setMoodFlash(null), remaining);
    return () => clearTimeout(tid);
  }, [moodFlash]);

  const flashMood = useCallback((mood: OrbMood, durationMs = 1500) => {
    setMoodFlash({ mood, until: Date.now() + durationMs });
  }, []);

  // Mood ableiten — Flash hat Vorrang, dann pipeline/connectivity
  const mood: OrbMood = moodFlash
    ? moodFlash.mood
    : !reachable ? 'error'
      : busy ? 'thinking'
      : !ready ? 'sleeping'
      : 'idle';

  const statusText =
    !reachable ? 'OFFLINE'
      : !ready ? 'INITIALIZING'
      : busy ? 'PROCESSING'
      : 'VOICE LINK ACTIVE';

  // Voice-Loop chat_log + lokale client-Skills mergen, nach Zeit sortiert
  const allMessages = [...messages, ...clientMessages].sort((a, b) => a.timestamp - b.timestamp);
  const pairs = pairUp(allMessages);
  const lastPair = pairs[pairs.length - 1];

  const remoteChat = async (t: string) => {
    const q = (t || '').trim();
    if (!q) return;
    {
      const u = intentUrl(q);
      if (u) {
        if (justOpenedRef.current === u) { justOpenedRef.current = ''; }
        else { const w = window.open(u, '_blank'); if (!w) setPendingLink({ url: u, label: q }); }
      }
    }
    // Auto-save: explicit "remember/note/save" intent -> POST /v1/memory/store (fire-and-forget)
    {
      const mm = q.match(/^(?:remember(?:\s+that)?|note(?:\s+that)?|save|keep in mind|merk(?:\s+dir)?|speichere?|store)[:,]?\s+(.+)/i);
      if (mm && mm[1]) {
        fetch(`${getBase()}/v1/memory/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: mm[1].trim(), tags: ['chat'] }),
        }).catch(() => {});
      }
    }
    setSubmitting(true);
    flashMood('thinking', 600);
    try {
      await fetch(`${getBase()}/chat_log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: q, source: 'web' }),
      }).catch(() => {});
      let hist: { role: string; content: string }[] = [];
      try {
        const lr = await fetch(`${getBase()}/chat_log`);
        const ld = await lr.json();
        hist = (ld.messages || []).slice(-12).map((mm: { role: string; content: string }) => ({ role: mm.role, content: mm.content }));
      } catch { /* ignore */ }
      if (!hist.length) hist = [{ role: 'user', content: q }];
      const res = await fetch(`${getBase()}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: deepMode ? 'qwen2.5:14b-instruct-q4_K_M' : 'qwen2.5:7b', messages: hist, stream: false }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(no reply)';
      await fetch(`${getBase()}/chat_log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'assistant', content: reply, source: 'web' }),
      }).catch(() => {});
      flashMood('success', 800);
      speakViaResolver(reply);
    } catch (e: unknown) {
      flashMood('error', 1500);
      const emsg = e instanceof Error ? e.message : String(e);
      speakViaResolver('Error: ' + emsg);
    } finally {
      setSubmitting(false);
    }
  };
  remoteChatRef.current = remoteChat;
  const toggleRemoteMic = async () => {
    if (remoteRecRef.current && remoteRecording) { remoteRecRef.current.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      remoteChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) remoteChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRemoteRecording(false);
        const mime = mr.mimeType || 'audio/webm';
        const blob = new Blob(remoteChunksRef.current, { type: mime });
        try {
          const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
          const r = await transcribeAudio(blob, 'rec.' + ext);
          if (r.text && r.text.trim()) await remoteChat(r.text);
        } catch { /* ignore */ }
      };
      mr.start();
      remoteRecRef.current = mr;
      setRemoteRecording(true);
    } catch { /* ignore */ }
  };
  toggleRemoteMicRef.current = toggleRemoteMic;

  // ===== Wake word: "hey jarvis" via server openWakeWord over WebSocket =====
  const captureCommand = async () => {
    setWakeStatus('Listening...');
    let stream: MediaStream | null = null;
    let actx: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      actx = new AudioContext();
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const tdata = new Uint8Array(an.fftSize);
      const SIL_END_MS = 2000;     // trailing silence (after speech) to finish
      const MAX_MS = 30000;        // hard cap
      const NOSPEECH_MS = 8000;    // give up if user never speaks
      const MIN_SPEECH_MS = 250;
      const startT = Date.now();
      let noiseFloor = 0, calibN = 0;
      let speaking = false, speechStart = 0, lastVoice = startT;
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        mr.start();
        const tick = () => {
          an.getByteTimeDomainData(tdata);
          let sum = 0;
          for (let i = 0; i < tdata.length; i++) { const d = (tdata[i] - 128) / 128; sum += d * d; }
          const rms = Math.sqrt(sum / tdata.length);
          const now = Date.now();
          const el = now - startT;
          if (el < 400) { noiseFloor = (noiseFloor * calibN + rms) / (calibN + 1); calibN++; setTimeout(tick, 50); return; }
          const thr = Math.max(0.015, noiseFloor * 2.2 + 0.008);
          if (rms > thr) { lastVoice = now; if (!speaking) { speaking = true; speechStart = now; setWakeStatus('Listening...'); } }
          const trailing = now - lastVoice;
          const spoke = speaking && (now - speechStart > MIN_SPEECH_MS);
          if (el > MAX_MS || (!speaking && el > NOSPEECH_MS) || (spoke && trailing > SIL_END_MS)) { try { mr.stop(); } catch { /* */ } return; }
          setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
      });
      const mime = mr.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      setWakeStatus('Thinking...');
      const ext = mime.includes('ogg') ? 'ogg' : 'webm';
      const r = await transcribeAudio(blob, 'cmd.' + ext);
      if (r.text && r.text.trim()) await remoteChat(r.text);
    } catch { /* */ } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (actx) { try { await actx.close(); } catch { /* */ } }
      setWakeStatus(wakeOn ? 'Say "Hey Jarvis"' : '');
    }
  };

  const onWakeDetected = async () => {
    if (wakeBusyRef.current) return;
    wakeBusyRef.current = true;
    flashMood('success', 600);
    setWakeStatus('Yes, sir?');
    try { await captureCommand(); } catch { /* */ }
    wakeBusyRef.current = false;
  };

  const startWake = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      wakeStreamRef.current = stream;
      const ACtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const actx = new ACtx({ sampleRate: 16000 });
      wakeCtxRef.current = actx;
      const code = [
        'class PCMW extends AudioWorkletProcessor {',
        '  process(inputs){ const ch=inputs[0][0]; if(ch){ const b=new Int16Array(ch.length); for(let i=0;i<ch.length;i++){ let s=Math.max(-1,Math.min(1,ch[i])); b[i]= s<0? s*0x8000 : s*0x7FFF; } this.port.postMessage(b,[b.buffer]); } return true; }',
        '}',
        'registerProcessor("pcmw", PCMW);'
      ].join('\n');
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await actx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(actx, 'pcmw');
      wakeNodeRef.current = node;
      const wsUrl = getBase().replace(/^http/, 'ws') + '/wake';
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wakeWsRef.current = ws;
      ws.onmessage = (ev) => {
        try { const m = JSON.parse(ev.data); if (m && m.wake) onWakeDetected(); } catch { /* */ }
      };
      node.port.onmessage = (e) => {
        const speaking = !!(ttsAudioRef.current && !ttsAudioRef.current.paused && !ttsAudioRef.current.ended);
        if (ws.readyState === 1 && !wakeBusyRef.current && !speaking) { ws.send(e.data); }
      };
      const msrc = actx.createMediaStreamSource(stream);
      msrc.connect(node);
      node.connect(actx.destination);
      setWakeOn(true);
      setWakeStatus('Say "Hey Jarvis"');
    } catch { setWakeStatus('Mic error'); }
  };

  const stopWake = () => {
    try { wakeWsRef.current?.close(); } catch { /* */ }
    try { wakeNodeRef.current?.disconnect(); } catch { /* */ }
    try { wakeStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { wakeCtxRef.current?.close(); } catch { /* */ }
    wakeWsRef.current = null; wakeNodeRef.current = null; wakeStreamRef.current = null; wakeCtxRef.current = null;
    setWakeOn(false); setWakeStatus('');
  };

  wakeToggleRef.current = () => { if (wakeOn) { try { localStorage.setItem('jarvis_wake', 'off'); } catch { /* */ } stopWake(); } else { try { localStorage.setItem('jarvis_wake', 'on'); } catch { /* */ } startWake(); } };

  useEffect(() => {
    if (!REMOTE) return;
    try { if (localStorage.getItem('jarvis_wake') === 'off') return; } catch { /* */ }
    let done = false;
    const tryStart = () => { if (done) return; done = true; document.removeEventListener('pointerdown', tryStart); startWake(); };
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then((s) => { s.getTracks().forEach((t) => t.stop()); tryStart(); })
      .catch(() => { document.addEventListener('pointerdown', tryStart, { once: true }); });
    return () => document.removeEventListener('pointerdown', tryStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="jarvis-home-root">
      <style>{homeStyles}</style>
      {REMOTE && boot && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#05080f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, overflow: 'hidden', animation: 'jbootFade 2.3s ease forwards' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'linear-gradient(90deg, transparent, rgba(34,211,238,0.18), transparent)', animation: 'jbootSweep 1.7s ease-out' }} />
          <div style={{ position: 'absolute', width: 320, height: 320, borderRadius: '50%', border: '1px solid rgba(34,211,238,0.5)', animation: 'jbootRing 1.8s ease-out' }} />
          <div style={{ fontSize: 'clamp(30px, 8vw, 68px)', fontWeight: 800, color: 'rgba(125,249,255,0.96)', letterSpacing: '0.3em', textShadow: '0 0 34px rgba(34,211,238,0.65)', animation: 'jbootText 1.5s ease forwards' }}>JARVIS</div>
          <div style={{ fontSize: 13, color: 'rgba(125,249,255,0.6)', letterSpacing: '0.45em' }}>ONLINE</div>
        </div>
      )}
      {REMOTE && (
        <button onClick={() => wakeToggleRef.current()} title="Wake word"
          style={{ position: 'absolute', top: 64, right: 16, zIndex: 50, padding: '6px 12px', borderRadius: 20, border: '1px solid rgba(125, 249, 255, 0.3)', cursor: 'pointer', background: wakeOn ? 'rgba(34, 211, 238, 0.28)' : 'rgba(15, 35, 70, 0.45)', color: 'rgba(220, 240, 255, 0.95)', fontSize: 12, whiteSpace: 'nowrap', backdropFilter: 'blur(6px)' }}>
          {wakeOn ? 'Hey Jarvis: ON' : 'Wake: OFF'}{wakeStatus ? ' - ' + wakeStatus : ''}
        </button>
      )}
      {REMOTE && (
        <button onClick={() => { const nv = !deepMode; setDeepMode(nv); try { localStorage.setItem('jarvis_deep', nv ? 'on' : 'off'); } catch { /* */ } }}
          title="Deep mode: 14B model (smarter, slower)"
          style={{ position: 'absolute', top: 100, right: 16, zIndex: 50, padding: '6px 12px', borderRadius: 20, border: '1px solid rgba(125, 249, 255, 0.3)', cursor: 'pointer', background: deepMode ? 'rgba(168, 85, 247, 0.32)' : 'rgba(15, 35, 70, 0.45)', color: 'rgba(220, 240, 255, 0.95)', fontSize: 12, whiteSpace: 'nowrap', backdropFilter: 'blur(6px)' }}>
          {deepMode ? 'Deep: 14B' : 'Deep: off'}
        </button>
      )}
      {REMOTE && (
        <div style={{ position: 'absolute', top: 140, right: 16, zIndex: 40, width: 230, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.6, color: 'rgba(220, 240, 255, 0.95)', paddingLeft: 4, letterSpacing: 1 }}>TIMERS</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <input value={timerInput} onChange={(e) => setTimerInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { const m = parseFloat(timerInput); if (m > 0) { fetch(getBase() + '/timers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fire: Date.now() / 1000 + m * 60, label: '', kind: 'timer' }) }).then(() => setTimerInput('')).catch(() => {}); } } }}
              placeholder="min" inputMode="decimal"
              style={{ width: 70, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(125, 249, 255, 0.18)', background: 'rgba(10, 25, 47, 0.62)', color: 'rgba(220, 240, 255, 0.95)', fontSize: 13 }} />
            <button onClick={() => { const m = parseFloat(timerInput); if (m > 0) { fetch(getBase() + '/timers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fire: Date.now() / 1000 + m * 60, label: '', kind: 'timer' }) }).then(() => setTimerInput('')).catch(() => {}); } }}
              style={{ flex: 1, padding: '6px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(34, 211, 238, 0.85)', color: '#fff', fontSize: 12 }}>+ Timer</button>
          </div>
          {srvTimers.map((t) => {
            const rem = Math.max(0, Math.floor(t.fire - nowSec));
            const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60), ss = rem % 60;
            const disp = hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
            const icon = t.kind === 'alarm' ? '⏰' : t.kind === 'reminder' ? '📝' : '⏱️';
            return (
              <div key={t.id} style={{ position: 'relative', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', borderRadius: 12, padding: '8px 12px', color: 'rgba(220, 240, 255, 0.95)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button onClick={() => { fetch(getBase() + '/timers/' + t.id, { method: 'DELETE' }).then(() => setSrvTimers((s) => s.filter((z) => z.id !== t.id))).catch(() => {}); }}
                  title="Delete" style={{ position: 'absolute', top: 4, right: 6, background: 'transparent', border: 'none', color: 'rgba(125, 249, 255, 0.55)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                <div style={{ fontSize: 11, opacity: 0.65, textTransform: 'capitalize', paddingRight: 16 }}>{icon} {t.kind}{t.label ? ' · ' + t.label : ''}</div>
                <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: rem <= 10 ? '#f87171' : '#fff' }}>{disp}</div>
              </div>
            );
          })}
        </div>
      )}
      {REMOTE && (
        <div style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 40, width: 230, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '45vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, opacity: 0.6, color: 'rgba(220, 240, 255, 0.95)', paddingLeft: 4, letterSpacing: 1 }}>NOTES</div>
          <input value={noteInput} onChange={(e) => setNoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && noteInput.trim()) { fetch(getBase() + '/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: noteInput.trim() }) }).then(() => setNoteInput('')).catch(() => {}); } }}
            placeholder="add a note..." style={inStyle} />
          {srvNotes.map((n) => (
            <div key={n.id} style={{ position: 'relative', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', borderRadius: 12, padding: '8px 12px', color: 'rgba(220, 240, 255, 0.95)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
              <button onClick={() => { fetch(getBase() + '/notes/' + n.id, { method: 'DELETE' }).then(() => setSrvNotes((sx) => sx.filter((z) => z.id !== n.id))).catch(() => {}); }}
                title="Delete" style={{ position: 'absolute', top: 4, right: 6, background: 'transparent', border: 'none', color: 'rgba(125, 249, 255, 0.55)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
              <div style={{ fontSize: 13, paddingRight: 16, whiteSpace: 'pre-wrap' }}>{n.text}</div>
            </div>
          ))}
        </div>
      )}
      {REMOTE && weatherCard && weatherCard.current && (
        <div onClick={() => { wxDismissed.current = weatherCard.ts; setWeatherCard(null); }}
          style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}>
          <div style={{ width: 'min(92vw, 560px)', borderRadius: 24, padding: 24, color: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,0.6)', background: wxGradient(weatherCard.current.code) }}>
            <div style={{ fontSize: 13, opacity: 0.85 }}>{weatherCard.location}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
              <div style={{ fontSize: 64, lineHeight: 1 }}>{wxEmoji(weatherCard.current.code)}</div>
              <div>
                <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1 }}>{weatherCard.current.temp}°</div>
                <div style={{ fontSize: 13, opacity: 0.9, textTransform: 'capitalize' }}>{weatherCard.current.desc}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 18, overflowX: 'auto', paddingBottom: 4 }}>
              {(weatherCard.days || []).map((d: any, idx: number) => (
                <div key={idx} style={{ flex: '0 0 auto', minWidth: 86, background: 'rgba(255,255,255,0.15)', borderRadius: 16, padding: '12px 8px', textAlign: 'center' }}>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{d.label || d.weekday}</div>
                  <div style={{ fontSize: 28, margin: '4px 0' }}>{wxEmoji(d.code)}</div>
                  <div style={{ fontSize: 11, textTransform: 'capitalize', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.desc}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{d.max}° / {d.min}°</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>💧 {d.precip ?? 0}%</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, textAlign: 'center', marginTop: 14 }}>tap to close</div>
          </div>
        </div>
      )}
      {REMOTE && briefingCard && briefingCard.greeting && (
        <div className="bd-wrap" onClick={() => { brDismissed.current = briefingCard.ts; setBriefingCard(null); }}>
          <div className="bd-gridbg" />
          <svg className="bd-reactor" viewBox="0 0 400 400">
            <g style={{ transformOrigin: '200px 200px', animation: 'hudSpin 40s linear infinite' }}>
              <circle cx="200" cy="200" r="190" fill="none" stroke="rgba(125,249,255,0.25)" strokeWidth="1" strokeDasharray="2 10" />
              <circle cx="200" cy="200" r="168" fill="none" stroke="rgba(125,249,255,0.4)" strokeWidth="1.5" strokeDasharray="40 16" />
            </g>
            <g style={{ transformOrigin: '200px 200px', animation: 'hudSpinR 28s linear infinite' }}>
              <circle cx="200" cy="200" r="140" fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth="1" strokeDasharray="3 12" />
              <circle cx="200" cy="200" r="118" fill="none" stroke="rgba(125,249,255,0.3)" strokeWidth="1" />
            </g>
            <g style={{ transformOrigin: '200px 200px', animation: 'hudSpin 18s linear infinite' }}>
              {Array.from({ length: 48 }).map((_, k) => (<rect key={k} x="199" y="14" width="2" height={k % 4 === 0 ? 14 : 7} fill="rgba(125,249,255,0.4)" transform={`rotate(${k * 7.5} 200 200)`} />))}
            </g>
            <circle cx="200" cy="200" r="92" fill="none" stroke="rgba(125,249,255,0.18)" strokeWidth="1" />
          </svg>
          <div className="bd-scan" />
          <button className="bd-close" onClick={(e) => { e.stopPropagation(); brDismissed.current = briefingCard.ts; setBriefingCard(null); }}>✕</button>

          <div className="bd-deck" onClick={(e) => e.stopPropagation()}>
            <div className="bd-panel bd-cell" style={{ gridColumn: 3, gridRow: 1, justifyContent: 'center', gap: 6 }}>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, letterSpacing: 3, color: '#7df9ff', textShadow: '0 0 14px rgba(34,211,238,0.5)' }}>J.A.R.V.I.S</div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 1.5, opacity: 0.65 }}>MORNING BRIEFING PROTOCOL</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 10px #22d3ee', animation: 'hudGlow 1.6s ease-in-out infinite' }} />ALL SYSTEMS ONLINE</div>
            </div>

            <div className="bd-cell" style={{ gridColumn: 2, gridRow: 1, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(20px,2.6vw,32px)', fontWeight: 300, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#c6f6ff', textShadow: '0 0 26px rgba(34,211,238,0.65)', animation: 'hudReveal 1s ease both' }}>{briefingCard.greeting}</div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'clamp(40px,7vw,92px)', fontWeight: 700, letterSpacing: 4, lineHeight: 1, marginTop: 8, color: '#eaffff', textShadow: '0 0 34px rgba(34,211,238,0.55)' }}>{new Date((nowSec || Date.now() / 1000) * 1000).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, opacity: 0.75, marginTop: 8, letterSpacing: 2 }}>{briefingCard.date}</div>
            </div>

            <div className="bd-panel bd-cell" style={{ gridColumn: 1, gridRow: 1, justifyContent: 'center', gap: 8 }}>
              {briefingCard.weather ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <div style={{ fontSize: 40, lineHeight: 1, filter: 'drop-shadow(0 0 9px rgba(34,211,238,0.5))' }}>{wxEmoji(briefingCard.weather.code)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 34, fontWeight: 200, lineHeight: 0.9 }}>{briefingCard.weather.temp}°<span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.7, marginLeft: 8 }}>H{briefingCard.weather.max}° L{briefingCard.weather.min}°</span></div>
                      <div style={{ fontSize: 11, opacity: 0.85, textTransform: 'capitalize', marginTop: 2 }}>{briefingCard.weather.desc}</div>
                    </div>
                  </div>
                  {briefingCard.weather.hourly && briefingCard.weather.hourly.length > 1 && (() => {
                    const hrs = briefingCard.weather.hourly.slice(0, 24);
                    const temps = hrs.map((h: any) => h.temp);
                    const mn = Math.min(...temps), mx = Math.max(...temps), span = Math.max(1, mx - mn);
                    const W = 300, H = 42, pad = 4;
                    const X = (i: number) => pad + (i / (hrs.length - 1)) * (W - 2 * pad);
                    const Y = (v: number) => 4 + (1 - (v - mn) / span) * (H - 10);
                    const line = hrs.map((h: any, i: number) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(h.temp).toFixed(1)).join(' ');
                    const area = line + ' L' + X(hrs.length - 1).toFixed(1) + ' ' + H + ' L' + X(0).toFixed(1) + ' ' + H + ' Z';
                    return (
                      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 42, display: 'block' }}>
                        <defs><linearGradient id="wxmini" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgba(125,249,255,0.35)" /><stop offset="100%" stopColor="rgba(125,249,255,0)" /></linearGradient></defs>
                        <path d={area} fill="url(#wxmini)" />
                        <path d={line} fill="none" stroke="#7df9ff" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ filter: 'drop-shadow(0 0 3px rgba(125,249,255,0.7))' }} />
                      </svg>
                    );
                  })()}
                  {briefingCard.weather.hourly && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'ui-monospace, monospace', fontSize: 9.5, opacity: 0.65 }}>
                      {briefingCard.weather.hourly.filter((_: any, i: number) => i % 4 === 0).slice(0, 6).map((h: any, i: number) => (<span key={i}>{h.t}h·{h.temp}°</span>))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: 'ui-monospace, monospace', fontSize: 10, opacity: 0.78 }}>
                    {briefingCard.weather.feels != null && <span>🌡{briefingCard.weather.feels}°</span>}
                    {briefingCard.weather.humidity != null && <span>💧{briefingCard.weather.humidity}%</span>}
                    {briefingCard.weather.wind != null && <span>💨{briefingCard.weather.wind}</span>}
                    {briefingCard.weather.sunrise && <span>🌅{briefingCard.weather.sunrise}</span>}
                    {briefingCard.weather.sunset && <span>🌇{briefingCard.weather.sunset}</span>}
                  </div>
                </>
              ) : <div style={{ opacity: 0.5, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>// NO WEATHER DATA</div>}
            </div>

            <div className="bd-panel bd-cell sc" style={{ gridColumn: 1, gridRow: 2 }}>
              {hudLabel('⚡ WHOOP // BIOMETRICS')}
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>{recoveryRing(briefingCard.whoop_stats ? briefingCard.whoop_stats.recovery : null)}</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 12 }}>
                {(() => { const st = briefingCard.whoop_stats || {}; return (st.strain != null) ? briefRing(st.strain, 'STRAIN') : metricTile(null, 'STRAIN'); })()}
                {metricTile(briefingCard.whoop_stats && briefingCard.whoop_stats.sleep, 'SLEEP', 'h')}
                {metricTile(briefingCard.whoop_stats && briefingCard.whoop_stats.hrv, 'HRV', 'ms')}
                {metricTile(briefingCard.whoop_stats && briefingCard.whoop_stats.rhr, 'RHR', '')}
              </div>
              {briefingCard.whoop_items && briefingCard.whoop_items.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {briefingCard.whoop_items.slice(0, 3).map((w: any, idx: number) => (
                    <div key={idx} style={{ fontSize: 12, opacity: 0.82, padding: '6px 0', borderTop: '1px solid rgba(125,249,255,0.08)', lineHeight: 1.4 }}><b style={{ color: '#c6f6ff' }}>{w.title}</b> <span style={{ opacity: 0.75 }}>{w.text}</span></div>
                  ))}
                </div>
              )}
            </div>

            <div className="bd-cell" style={{ gridColumn: 2, gridRow: 2, justifyContent: 'center', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                {glanceTile((briefingCard.messages && briefingCard.messages.count) || 0, 'Messages')}
                {glanceTile((briefingCard.items && briefingCard.items.length) || 0, 'Events')}
                {glanceTile((briefingCard.whoop_stats && briefingCard.whoop_stats.strain != null) ? briefingCard.whoop_stats.strain : '--', 'Strain', '#fbbf24')}
                {glanceTile((news && news.length) || 0, 'Headlines')}
              </div>
              <div className="bd-panel sc" style={{ maxHeight: '38vh' }}>
                {hudLabel('AGENDA')}
                {(briefingCard.calendar || []).map((c: any, idx: number) => (
                  <div key={'c' + idx} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: idx ? '1px solid rgba(125,249,255,0.07)' : 'none' }}>
                    <span style={{ fontSize: 16 }}>📅</span>
                    <span style={{ fontSize: 14, flex: 1 }}>{c.title}</span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.85 }}>{c.time}</span>
                  </div>
                ))}
                {(briefingCard.items || []).map((it: any, idx: number) => (
                  <div key={'t' + idx} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: (idx || (briefingCard.calendar && briefingCard.calendar.length)) ? '1px solid rgba(125,249,255,0.07)' : 'none' }}>
                    <span style={{ fontSize: 17 }}>{it.kind === 'alarm' ? '⏰' : it.kind === 'reminder' ? '📝' : '⏱️'}</span>
                    <span style={{ fontSize: 14, flex: 1, textTransform: 'capitalize' }}>{it.label || it.kind}</span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.85 }}>{it.when}</span>
                  </div>
                ))}
                {(!(briefingCard.items && briefingCard.items.length) && !(briefingCard.calendar && briefingCard.calendar.length)) && (<div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.5 }}>// CLEAR DAY, SIR</div>)}
                {(!briefingCard.calendar || !briefingCard.calendar.length) && (<div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9.5, opacity: 0.35, marginTop: 8 }}>📅 calendar — not connected yet</div>)}
              </div>
            </div>

            <div className="bd-panel bd-cell sc" style={{ gridColumn: 3, gridRow: 2 }}>
              {hudLabel('MESSAGES // ' + ((briefingCard.messages && briefingCard.messages.count) || 0))}
              {((briefingCard.messages && briefingCard.messages.items) || []).map((m: any, idx: number) => (
                <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: idx ? '1px solid rgba(125,249,255,0.07)' : 'none', animation: 'hudCascade .5s ease both', animationDelay: (idx * 0.06) + 's' }}>
                  <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#04121f', background: m.vip ? 'linear-gradient(145deg,#7df9ff,#22d3ee)' : 'rgba(125,249,255,0.18)', boxShadow: m.vip ? '0 0 10px rgba(125,249,255,0.6)' : 'none' }}>{(m.who || '?').slice(0, 1).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: m.vip ? '#bfefff' : 'inherit' }}>{m.vip ? '★ ' : ''}{m.who}</div>
                    <div style={{ fontSize: 12, opacity: 0.72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.text}</div>
                  </div>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, opacity: 0.5, whiteSpace: 'nowrap' }}>{m.app}</span>
                </div>
              ))}
            </div>

            {news && news.length > 0 && (
              <div className="bd-panel" style={{ gridColumn: '1 / -1', gridRow: 3 }}>
                {hudLabel('INTEL // TAGESSCHAU')}
                <div className="bd-newsrow">
                  {news.slice(0, 8).map((nw: any, idx: number) => (
                    <a key={idx} className="bd-newscard" href={nw.link || '#'} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ animationDelay: (idx * 0.06) + 's' }}>
                      {nw.image && (<div style={{ height: 86, backgroundImage: `linear-gradient(180deg, rgba(3,9,18,0) 45%, rgba(3,9,18,0.6)), url(${nw.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />)}
                      <div style={{ padding: '8px 10px 10px' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 650, lineHeight: 1.25, color: '#eaf6ff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{nw.title}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {REMOTE && healthCard && healthCard.recovery != null && (() => {
        const h = healthCard;
        const rc = h.recovery, rcol = rc >= 67 ? '#34d399' : rc >= 34 ? '#fbbf24' : '#ff6b6b';
        const rword = rc >= 67 ? 'PRIMED' : rc >= 34 ? 'MODERATE' : 'LOW';
        const sp = h.sleep_perf || 0, scol = sp >= 85 ? '#34d399' : sp >= 70 ? '#38bdf8' : '#fbbf24';
        const sword = sp >= 85 ? 'OPTIMAL' : sp >= 70 ? 'GOOD' : 'LOW';
        const stn = h.strain != null ? h.strain : 0, stword = stn >= 18 ? 'ALL OUT' : stn >= 14 ? 'STRENUOUS' : stn >= 10 ? 'MODERATE' : 'LIGHT';
        const recCol = (v: any) => v >= 67 ? '#34d399' : v >= 34 ? '#fbbf24' : '#ff6b6b';
        const ring = (val: any, mx: any, unit: any, color: any, label: any, icon: any, qual: any, size: any) => {
          const r = size / 2 - 9, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(1, (val || 0) / mx)), off = c * (1 - pct), cx = size / 2;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(125,249,255,0.09)" strokeWidth="10" />
                <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform={`rotate(-90 ${cx} ${cx})`} style={{ filter: `drop-shadow(0 0 12px ${color})`, transition: 'stroke-dashoffset 1.4s cubic-bezier(.2,.9,.3,1)' }} />
                <text x={cx} y={cx - 1} textAnchor="middle" fill="#eaffff" fontSize={size * 0.3} fontWeight="700" fontFamily="ui-monospace, monospace">{val == null ? '--' : val}<tspan fontSize={size * 0.13} dy="-4">{unit}</tspan></text>
                <text x={cx} y={cx + size * 0.17} textAnchor="middle" fill={color} fontSize={size * 0.085} fontWeight="700" fontFamily="ui-monospace, monospace" letterSpacing="2">{qual}</text>
              </svg>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'ui-monospace, monospace', fontSize: 13, letterSpacing: 2, color: '#cbe9ff' }}><span style={{ fontSize: 17 }}>{icon}</span>{label}</div>
            </div>
          );
        };
        const ess = (icon: any, val: any, unit: any, label: any) => (
          <div style={{ textAlign: 'center', minWidth: 78 }}>
            <div style={{ fontSize: 18 }}>{icon}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#eaffff', lineHeight: 1.1, fontFamily: 'ui-monospace, monospace' }}>{val == null ? '--' : val}<span style={{ fontSize: 12, opacity: 0.6 }}>{unit}</span></div>
            <div style={{ fontSize: 9.5, opacity: 0.5, fontFamily: 'ui-monospace, monospace', letterSpacing: 1.5 }}>{label}</div>
          </div>
        );
        const tr = h.trend_recovery || [];
        const mxt = Math.max(...tr, 1);
        const dl = (n: any) => { const o = []; for (let i = 0; i < n; i++) { const d = new Date(Date.now() - (n - 1 - i) * 86400000); o.push(i === n - 1 ? 'TODAY' : d.toLocaleDateString('de-CH', { weekday: 'short' }).toUpperCase()); } return o; };
        const days = dl(tr.length);
        return (
          <div className="bd-wrap" onClick={() => { hcDismissed.current = h.ts; setHealthCard(null); }}>
            <div className="bd-gridbg" />
            <svg className="bd-reactor" viewBox="0 0 400 400">
              <g style={{ transformOrigin: '200px 200px', animation: 'hudSpin 44s linear infinite' }}><circle cx="200" cy="200" r="188" fill="none" stroke="rgba(125,249,255,0.18)" strokeWidth="1" strokeDasharray="2 13" /></g>
              <g style={{ transformOrigin: '200px 200px', animation: 'hudSpinR 30s linear infinite' }}><circle cx="200" cy="200" r="152" fill="none" stroke="rgba(34,211,238,0.3)" strokeWidth="1" strokeDasharray="34 16" /></g>
            </svg>
            <div className="bd-scan" />
            <button className="bd-close" onClick={(e) => { e.stopPropagation(); hcDismissed.current = h.ts; setHealthCard(null); }}>✕</button>
            <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(20px,3.5vh,40px)', padding: 'clamp(20px,4vh,50px)', boxSizing: 'border-box', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 'clamp(20px,2.6vw,30px)', fontWeight: 300, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c6f6ff', textShadow: '0 0 26px rgba(34,211,238,0.6)', animation: 'hudReveal 1s ease both' }}>
                &#10084; HEALTH<span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, opacity: 0.55, display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 9px #22d3ee', animation: 'hudGlow 1.6s ease-in-out infinite' }} />WHOOP LIVE</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(16px,4vw,64px)', flexWrap: 'wrap' }}>
                {ring(sp, 100, '%', scol, 'SLEEP ' + (h.sleep != null ? h.sleep + 'h' : ''), '🛌', sword, 178)}
                {ring(rc, 100, '%', rcol, 'RECOVERY', '❤️', rword, 240)}
                {ring(stn, 21, '', '#7df9ff', 'STRAIN', '⚡', stword, 178)}
              </div>

              <div style={{ display: 'flex', gap: 'clamp(18px,4vw,54px)', flexWrap: 'wrap', justifyContent: 'center' }}>
                {ess('💓', h.hrv, 'ms', 'HRV')}
                {ess('❤️', h.rhr, '', 'RESTING HR')}
                {ess('🛌', h.sleep_needed, 'h', 'SLEEP NEED')}
                {ess('🔥', h.calories, '', 'CALORIES')}
              </div>

              {(h.coach || h.readiness) && (
                <div style={{ maxWidth: 680, width: '90%', borderRadius: 18, padding: '18px 22px', background: 'linear-gradient(135deg, rgba(125,249,255,0.08), rgba(34,211,238,0.04))', border: '1px solid rgba(125,249,255,0.2)', boxShadow: '0 0 30px rgba(34,211,238,0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9, flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 2, color: '#7df9ff' }}>&#9670; JARVIS COACH</span>
                    {h.readiness && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: rcol, fontWeight: 700 }}>{h.readiness.toUpperCase()} · TARGET {h.strain_target}{h.bedtime ? ' · BED ' + h.bedtime : ''}</span>}
                  </div>
                  {h.coach && <div style={{ fontSize: 'clamp(14px,1.5vw,17px)', lineHeight: 1.5, color: '#e6f7ff' }}>{h.coach}</div>}
                </div>
              )}

              {tr.length > 1 && (
                <div style={{ width: '90%', maxWidth: 680 }}>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 2, opacity: 0.55, marginBottom: 10, textAlign: 'center' }}>❤ 7-DAY RECOVERY</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'clamp(6px,1.5vw,16px)', height: 80, justifyContent: 'center' }}>
                    {tr.map((v: any, i: number) => { const cc = recCol(v); const today = i === tr.length - 1; return (
                      <div key={i} style={{ flex: 1, maxWidth: 70, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                        <div style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: today ? cc : '#cbe9ff' }}>{v}</div>
                        <div style={{ width: '100%', height: Math.max(6, (v / mxt) * 48), borderRadius: '5px 5px 0 0', background: `linear-gradient(180deg, ${cc}, ${cc}22)`, boxShadow: today ? `0 0 14px ${cc}` : `0 0 6px ${cc}88`, transition: 'height .9s ease' }} />
                        <div style={{ fontSize: 8.5, opacity: today ? 0.9 : 0.4, fontFamily: 'ui-monospace, monospace', fontWeight: today ? 700 : 400 }}>{days[i]}</div>
                      </div>
                    ); })}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {REMOTE && financeCard && financeCard.week != null && (() => {
        const f = financeCard;
        const icon = (c: any) => ({ 'Groceries': '🛒', 'Food & Drink': '🍽️', 'Transport': '🚆', 'Subscriptions': '🔁', 'Shopping': '🛍️', 'Other': '💳' } as any)[c] || '💳';
        const cats = f.by_cat || [], maxc = Math.max(1, ...cats.map((c: any) => c.amt));
        const dy = f.daily || [], maxd = Math.max(1, ...dy.map((d: any) => d.amt));
        return (
          <div className="bd-wrap" onClick={() => { fcDismissed.current = f.ts; setFinanceCard(null); }}>
            <div className="bd-gridbg" />
            <svg className="bd-reactor" viewBox="0 0 400 400">
              <g style={{ transformOrigin: '200px 200px', animation: 'hudSpin 44s linear infinite' }}><circle cx="200" cy="200" r="186" fill="none" stroke="rgba(251,191,36,0.16)" strokeWidth="1" strokeDasharray="2 13" /></g>
              <g style={{ transformOrigin: '200px 200px', animation: 'hudSpinR 30s linear infinite' }}><circle cx="200" cy="200" r="150" fill="none" stroke="rgba(125,249,255,0.28)" strokeWidth="1" strokeDasharray="34 16" /></g>
            </svg>
            <div className="bd-scan" />
            <button className="bd-close" onClick={(e) => { e.stopPropagation(); fcDismissed.current = f.ts; setFinanceCard(null); }}>✕</button>
            <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(18px,3vh,34px)', padding: 'clamp(20px,4vh,48px)', boxSizing: 'border-box', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 'clamp(20px,2.6vw,30px)', fontWeight: 300, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c6f6ff', textShadow: '0 0 26px rgba(34,211,238,0.6)', animation: 'hudReveal 1s ease both' }}>
                &#128179; SPENDING<span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, opacity: 0.55, display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 9px #22d3ee', animation: 'hudGlow 1.6s ease-in-out infinite' }} />LIVE</span>
              </div>

              <div style={{ display: 'flex', gap: 'clamp(20px,5vw,70px)', flexWrap: 'wrap', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, opacity: 0.55 }}>TODAY</div>
                  <div style={{ fontSize: 'clamp(40px,6vw,72px)', fontWeight: 200, color: '#fbbf24', lineHeight: 1, textShadow: '0 0 28px rgba(251,191,36,0.4)' }}><span style={{ fontSize: '0.4em', opacity: 0.7 }}>CHF </span>{f.today}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, opacity: 0.55 }}>THIS WEEK</div>
                  <div style={{ fontSize: 'clamp(40px,6vw,72px)', fontWeight: 200, color: '#eaffff', lineHeight: 1, textShadow: '0 0 28px rgba(34,211,238,0.4)' }}><span style={{ fontSize: '0.4em', opacity: 0.7 }}>CHF </span>{f.week}</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, width: '92%', maxWidth: 860 }}>
                <div className="bd-panel">
                  {hudLabel('CATEGORIES')}
                  {cats.length ? cats.map((c: any, i: number) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                      <span style={{ fontSize: 16, width: 22 }}>{icon(c.cat)}</span>
                      <span style={{ width: 96, fontSize: 12, opacity: 0.85 }}>{c.cat}</span>
                      <div style={{ flex: 1, height: 9, borderRadius: 5, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}><div style={{ width: (c.amt / maxc * 100) + '%', height: '100%', background: 'linear-gradient(90deg,#fbbf24,#fde68a)', boxShadow: '0 0 7px #fbbf24', transition: 'width .9s ease' }} /></div>
                      <span style={{ width: 64, textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#fde68a' }}>{c.amt}</span>
                    </div>
                  )) : <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.5 }}>// no data</div>}
                </div>
                <div className="bd-panel sc" style={{ maxHeight: '34vh' }}>
                  {hudLabel('RECENT')}
                  {(f.tx || []).map((x: any, i: number) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: i ? '1px solid rgba(125,249,255,0.07)' : 'none' }}>
                      <span style={{ fontSize: 15, width: 20 }}>{icon(x.cat)}</span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.merchant}</span>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, opacity: 0.5 }}>{x.time}</span>
                      <span style={{ width: 62, textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 700, color: '#fde68a' }}>{x.amount}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ width: '92%', maxWidth: 860 }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: 2, opacity: 0.55, marginBottom: 10, textAlign: 'center' }}>&#128197; 7-DAY SPENDING</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'clamp(6px,1.5vw,16px)', height: 84, justifyContent: 'center' }}>
                  {dy.map((d: any, i: number) => { const today = i === dy.length - 1; return (
                    <div key={i} style={{ flex: 1, maxWidth: 80, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                      <div style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace', fontWeight: 600, color: today ? '#fbbf24' : '#cbe9ff' }}>{d.amt > 0 ? d.amt : ''}</div>
                      <div style={{ width: '64%', height: Math.max(4, (d.amt / maxd) * 52), borderRadius: '5px 5px 0 0', background: today ? 'linear-gradient(180deg,#fbbf24,#fbbf2422)' : 'linear-gradient(180deg,#7df9ff,#7df9ff22)', boxShadow: today ? '0 0 12px #fbbf24' : '0 0 6px #7df9ff88', transition: 'height .9s ease' }} />
                      <div style={{ fontSize: 8.5, opacity: today ? 0.9 : 0.45, fontFamily: 'ui-monospace, monospace', fontWeight: today ? 700 : 400 }}>{d.d}</div>
                    </div>
                  ); })}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {REMOTE && fileMatches && fileMatches.matches && fileMatches.matches.length > 0 && (
        <div onClick={() => { fmDismissed.current = fileMatches.ts; setFileMatches(null); }}
          style={{ position: 'absolute', inset: 0, zIndex: 82, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(5px)' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(94vw, 560px)', maxHeight: '80vh', overflowY: 'auto', borderRadius: 20, padding: 22, color: 'rgba(220, 240, 255, 0.95)', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Which file?</div>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>Tap to open · {fileMatches.matches.length} matches</div>
            {fileMatches.matches.map((f: any, idx: number) => (
              <div key={idx}
                onClick={() => { fetch(getBase() + '/fileopen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path }) }).catch(() => {}); fmDismissed.current = fileMatches.ts; setFileMatches(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, marginBottom: 6, background: 'rgba(125, 249, 255, 0.12)', cursor: 'pointer', border: '1px solid rgba(125, 249, 255, 0.18)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(37,99,235,0.25)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(125, 249, 255, 0.12)')}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.dir} · {f.modified}</div>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11, opacity: 0.55, textAlign: 'center', marginTop: 10 }}>tap outside to dismiss</div>
          </div>
        </div>
      )}
      {REMOTE && (
        <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 55, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
          {srvStatus.state === 'speaking' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 22 }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <span key={i} className="jbar" style={{ animation: 'jbar 0.7s ease-in-out ' + (i * 0.08) + 's infinite' }} />
              ))}
            </div>
          )}
          {srvStatus.state === 'listening' && (
            <div style={{ width: 130, height: 5, borderRadius: 3, background: 'rgba(125, 249, 255, 0.12)', overflow: 'hidden' }}>
              <div style={{ width: Math.min(100, srvStatus.level || 0) + '%', height: '100%', background: '#16a34a', transition: 'width 0.15s' }} />
            </div>
          )}
          {srvStatus.heard && (srvStatus.state === 'thinking' || srvStatus.state === 'speaking') && (
            <div style={{ maxWidth: 340, fontSize: 12, color: 'rgba(125, 249, 255, 0.55)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{'“' + srvStatus.heard + '”'}</div>
          )}
        </div>
      )}
      {REMOTE && srvStatus.playing && (
        <div style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 45, width: 230, background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', borderRadius: 16, padding: '10px 14px', color: 'rgba(220, 240, 255, 0.95)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>NOW PLAYING</div>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textTransform: 'capitalize' }}>{srvStatus.playing}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => sendUi('previous')} style={qBtn}>{'⏮️'}</button>
            <button onClick={() => sendUi('pause')} style={qBtn}>{'⏯️'}</button>
            <button onClick={() => sendUi('next')} style={qBtn}>{'⏭️'}</button>
          </div>
        </div>
      )}
      {REMOTE && showMem && (
        <div onClick={() => setShowMem(false)} style={{ position: 'absolute', inset: 0, zIndex: 83, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(5px)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(92vw, 460px)', maxHeight: '80vh', overflowY: 'auto', borderRadius: 20, padding: 22, color: 'rgba(220, 240, 255, 0.95)', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>What Jarvis remembers</div>
            <input value={memInput} onChange={(e) => setMemInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && memInput.trim()) { fetch(getBase() + '/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: memInput.trim() }) }).then(() => setMemInput('')).catch(() => {}); } }}
              placeholder="add a fact..." style={{ ...inStyle, width: '100%', boxSizing: 'border-box', marginBottom: 10 }} />
            {srvMemory.length === 0 && <div style={{ fontSize: 13, opacity: 0.6 }}>Nothing yet. Say remember that, or add above.</div>}
            {srvMemory.map((m) => (
              <div key={m.id} style={{ position: 'relative', background: 'rgba(125, 249, 255, 0.12)', border: '1px solid rgba(125, 249, 255, 0.18)', borderRadius: 12, padding: '9px 12px', marginBottom: 6, fontSize: 13 }}>
                <button onClick={() => { fetch(getBase() + '/memory/' + m.id, { method: 'DELETE' }).then(() => setSrvMemory((sm) => sm.filter((z) => z.id !== m.id))).catch(() => {}); }}
                  title="Forget" style={{ position: 'absolute', top: 6, right: 8, background: 'transparent', border: 'none', color: 'rgba(125, 249, 255, 0.55)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}>{'×'}</button>
                <span style={{ paddingRight: 16, display: 'block' }}>{m.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {REMOTE && showCheats && (
        <div onClick={() => setShowCheats(false)} style={{ position: 'absolute', inset: 0, zIndex: 83, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(5px)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(94vw, 600px)', maxHeight: '82vh', overflowY: 'auto', borderRadius: 20, padding: 24, color: 'rgba(220, 240, 255, 0.95)', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Voice commands</div>
            {[['Media', ['play <song>', 'stop / resume', 'next / previous', 'louder / quieter', 'mute']], ['Desktop', ['open <app>', 'lock the pc', 'take a screenshot', 'snap left / right', 'set volume to 30 percent']], ['Files', ['datei suche then the name', 'open the file <name>', 'summarize the file <name>']], ['Time', ['set a timer for 5 minutes', 'wake me at 7', 'remind me to <x> in 10 minutes']], ['Smart', ['remember that <fact>', 'what do you know about me', 'explain this error', 'whats the weather tomorrow', 'start dictation', 'start my morning']], ['Info', ['whats 15 percent of 230', 'convert 100 euro to dollar', 'what time is it in tokyo', 'define <word>', 'whats the news']]].map((grp: any) => (
              <div key={grp[0]} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6, letterSpacing: 1 }}>{grp[0]}</div>
                {grp[1].map((it: string) => (<div key={it} style={{ fontSize: 13, padding: '3px 0', opacity: 0.92 }}>{'· ' + it}</div>))}
              </div>
            ))}
            <div style={{ fontSize: 11, opacity: 0.55, textAlign: 'center', marginTop: 6 }}>tap outside to close</div>
          </div>
        </div>
      )}
      {REMOTE && srvSys && srvSys.ts > 0 && (
        <div
          onMouseDown={(e) => {
            const sx = e.clientX, sy = e.clientY, ox = hudPos.x, oy = hudPos.y;
            let last = { x: ox, y: oy };
            const mv = (ev: MouseEvent) => { last = { x: Math.max(0, ox + ev.clientX - sx), y: Math.max(0, oy + ev.clientY - sy) }; setHudPos(last); };
            const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); try { localStorage.setItem('jarvis_hudpos', JSON.stringify(last)); } catch { /* */ } };
            window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
          }}
          style={{ position: 'absolute', top: hudPos.y, left: hudPos.x, zIndex: 45, width: 154, padding: '8px 11px', background: 'rgba(10, 25, 47, 0.62)', border: '1px solid rgba(125, 249, 255, 0.18)', borderRadius: 12, backdropFilter: 'blur(6px)', color: 'rgba(220, 240, 255, 0.95)', fontSize: 10, cursor: 'move', userSelect: 'none' }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, opacity: 0.6, marginBottom: 6 }}>SYSTEM Â· {srvSys.gpu_temp}Â°C</div>
          {[['CPU', srvSys.cpu], ['RAM', srvSys.ram], ['GPU', srvSys.gpu_mem]].map((row: any) => (
            <div key={row[0]} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ width: 24, opacity: 0.7 }}>{row[0]}</span>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(125, 249, 255, 0.12)', overflow: 'hidden' }}>
                <div style={{ width: row[1] + '%', height: '100%', background: row[1] > 85 ? '#ef4444' : row[1] > 60 ? '#eab308' : 'rgba(34, 211, 238, 0.9)', transition: 'width 0.4s' }} />
              </div>
              <span style={{ width: 26, textAlign: 'right' }}>{row[1]}%</span>
            </div>
          ))}
        </div>
      )}
      {pendingLink && (
        <button onClick={() => { window.open(pendingLink.url, '_blank'); setPendingLink(null); }} title={pendingLink.url}
          style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '8px 18px', borderRadius: 22, border: 'none', cursor: 'pointer', background: 'rgba(34, 211, 238, 0.85)', color: '#fff', fontSize: 13 }}>
          Open link
        </button>
      )}

      {/* Linke History-Sidebar */}
      <aside className={`jarvis-history ${historyOpen ? 'open' : 'closed'}`}>
        <div className="jarvis-history-header">
          <div className="jarvis-history-title">
            <HistoryIcon size={12} /> <span>HISTORY</span>
          </div>
          {messages.length > 0 && (
            <button onClick={resetChat} className="jarvis-history-clear" title="Clear history">
              clear
            </button>
          )}
        </div>
        <div ref={historyScrollRef} className="jarvis-history-list">
          {pairs.length === 0 ? (
            <div className="jarvis-history-empty">
              <span>No conversation yet</span>
            </div>
          ) : (
            pairs.map((p) => (
              <div key={p.user.id} className="jarvis-history-pair">
                <div className="jarvis-history-q">{p.user.content}</div>
                {p.assistant && (
                  <div className="jarvis-history-a">{p.assistant.content}</div>
                )}
                <div className="jarvis-history-time">
                  {new Date(p.user.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Toggle-Button für Sidebar (wenn closed) */}
      {!historyOpen && (
        <button
          onClick={() => setHistoryOpen(true)}
          className="jarvis-history-toggle"
          title="Show history"
        >
          <HistoryIcon size={14} />
        </button>
      )}

      {/* Timer + Reminder Widget oben rechts (unter Settings-Bar) */}
      {(clientTimers.length > 0 || timers.length > 0 || reminders.length > 0) && (
        <div className="jarvis-tw">
          {clientTimers.length > 0 && (
            <>
              <div className="jarvis-tw-section-title"><Clock size={10} /> TIMERS</div>
              {clientTimers
                .slice()
                .sort((a, b) => a.fire_at - b.fire_at)
                .map((t) => {
                  const sec = Math.max(0, Math.round(t.fire_at - nowTick));
                  const mm = Math.floor(sec / 60);
                  const ss = sec % 60;
                  const isFiring = t.fired || sec <= 0;
                  const isLast10 = !isFiring && sec <= 10;
                  return (
                    <div
                      key={t.id}
                      className={`jarvis-tw-item jarvis-tw-timer ${isFiring ? 'fire' : ''} ${isLast10 ? 'warn' : ''}`}
                    >
                      <div className="jarvis-tw-rem">
                        {t.name && <div className="jarvis-tw-rem-msg">{t.name}</div>}
                        <div className="jarvis-tw-time-big">
                          {isFiring ? 'DONE' : `${mm}:${String(ss).padStart(2, '0')}`}
                        </div>
                      </div>
                      <button
                        onClick={() => dismissClientTimer(t.id)}
                        className="jarvis-tw-x"
                        title="Cancel"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
            </>
          )}
          {/* Legacy voice-loop Timer (anders gemanagt — sollten kuenftig leer sein) */}
          {timers.length > 0 && (
            <>
              <div className="jarvis-tw-section-title"><Clock size={10} /> VOICE-LOOP TIMERS</div>
              {timers.map((t) => {
                const sec = Math.max(0, Math.round(t.fire_at - nowTick));
                const mm = Math.floor(sec / 60);
                const ss = sec % 60;
                return (
                  <div key={`t-${t.id}`} className="jarvis-tw-item jarvis-tw-timer">
                    <span className="jarvis-tw-time">{mm}:{String(ss).padStart(2, '0')}</span>
                    <button onClick={() => dismissTimer(t.id)} className="jarvis-tw-x" title="Cancel">
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </>
          )}
          {reminders.length > 0 && (
            <>
              <div className="jarvis-tw-section-title"><Bell size={10} /> REMINDERS</div>
              {reminders
                .slice()
                .sort((a, b) => a.fire_at - b.fire_at)
                .map((r) => {
                  const d = new Date(r.fire_at * 1000);
                  const now = new Date();
                  const isToday = d.toDateString() === now.toDateString();
                  const isTomorrow = d.toDateString() === new Date(now.getTime() + 86400000).toDateString();
                  const whenStr = isToday
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : isTomorrow
                      ? `tomorrow ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={`r-${r.id}`} className="jarvis-tw-item jarvis-tw-reminder">
                      <div className="jarvis-tw-rem">
                        <div className="jarvis-tw-rem-when">{whenStr}</div>
                        <div className="jarvis-tw-rem-msg">{r.message}</div>
                      </div>
                      <button onClick={() => dismissTimer(r.id)} className="jarvis-tw-x" title="Delete">
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
            </>
          )}
        </div>
      )}

      {/* Settings-Button oben rechts */}
      <div className="jarvis-home-topright">
        {historyOpen && (
          <button
            onClick={() => setHistoryOpen(false)}
            className="jarvis-home-iconbtn"
            title="Hide history"
          >
            <X size={14} />
          </button>
        )}
        <button
          onClick={() => navigate('/settings')}
          className="jarvis-home-iconbtn"
          title="Settings"
        >
          <SettingsIcon size={14} />
        </button>
      </div>

      {/* Status-Label oben mittig */}
      <div className="jarvis-home-status">
        <span className="jarvis-home-status-dot" data-phase={busy ? 'busy' : ready ? 'ready' : 'off'} />
        <span>{statusText}</span>
        <strong>JARVIS</strong>
      </div>

      {/* 3D-Orb in der Mitte */}
      <div className="jarvis-home-orb-stage">
        <JarvisWebGLOrb
          activityOverride={activity}
          voiceOverride={voice}
          mood={mood}
          performanceMode
        />
        {subtitle && (
          <div className="jarvis-tts-subtitle">{subtitle}</div>
        )}
      </div>

      {/* Dialog schwebt unter dem Orb — nur letztes Q/A */}
      <div className="jarvis-home-dialog">
        {lastPair?.user && (
          <div className="jarvis-home-line jarvis-home-line-user">
            <span>{lastPair.user.content}</span>
          </div>
        )}
        {lastPair?.assistant && (
          <div className="jarvis-home-line jarvis-home-line-jarvis">
            <span>{lastPair.assistant.content}</span>
          </div>
        )}
        {!lastPair && reachable && (
          <div className="jarvis-home-line jarvis-home-line-hint">
            <span>Say "Hey Jarvis" or type a command</span>
          </div>
        )}
      </div>

      {/* Hardware-Widget unten rechts */}
      {hardware && (
        <div className="jarvis-hw">
          <div className="jarvis-hw-title">SYSTEM</div>
          {hardware.gpu_name && (
            <>
              <HwRow
                label="GPU"
                pct={hardware.gpu_percent ?? 0}
                detail={`${hardware.gpu_temp_c ?? 0}°C`}
              />
              <HwRow
                label="VRAM"
                pct={hardware.vram_percent ?? 0}
                detail={`${hardware.vram_used_gb ?? 0}/${hardware.vram_total_gb ?? 0} GB`}
              />
            </>
          )}
          <HwRow label="CPU" pct={hardware.cpu_percent ?? 0} detail="" />
          <HwRow
            label="RAM"
            pct={hardware.ram_percent ?? 0}
            detail={`${hardware.ram_used_gb ?? 0}/${hardware.ram_total_gb ?? 0} GB`}
          />
          {/* Welche Modelle laufen wo */}
          {hardware.voice_loop_runtime && (
            <div className="jarvis-hw-runtime">
              <div className="jarvis-hw-rt-row" title={hardware.voice_loop_runtime.llm}>
                <span className="jarvis-hw-rt-key">LLM</span>
                <span className="jarvis-hw-rt-val">{hardware.voice_loop_runtime.llm}</span>
              </div>
              <div className="jarvis-hw-rt-row" title={hardware.voice_loop_runtime.stt}>
                <span className="jarvis-hw-rt-key">STT</span>
                <span className="jarvis-hw-rt-val">{hardware.voice_loop_runtime.stt}</span>
              </div>
              <div className="jarvis-hw-rt-row" title={hardware.voice_loop_runtime.tts}>
                <span className="jarvis-hw-rt-key">TTS</span>
                <span className="jarvis-hw-rt-val">{hardware.voice_loop_runtime.tts}</span>
              </div>
            </div>
          )}
          {/* Top GPU-Prozesse */}
          {hardware.gpu_processes && hardware.gpu_processes.length > 0 && (
            <div className="jarvis-hw-procs">
              <div className="jarvis-hw-procs-title">VRAM USERS</div>
              {hardware.gpu_processes
                .slice()
                .sort((a, b) => b.vram_mb - a.vram_mb)
                .slice(0, 4)
                .map((p) => (
                  <div key={p.pid} className="jarvis-hw-proc">
                    <span className="jarvis-hw-proc-name">
                      {p.name.replace('.exe', '').slice(0, 14)}
                    </span>
                    <span className="jarvis-hw-proc-vram">
                      {Math.round(p.vram_mb)} MB
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Input row unten */}
      {REMOTE && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
          <button onClick={() => sendUi('take a screenshot')} className="jarvis-home-btn" title="Screenshot"><Camera size={18} /></button>
          <button onClick={() => setShowMem(true)} className="jarvis-home-btn" title="Memory"><Brain size={18} /></button>
          <button onClick={() => setShowCheats(true)} className="jarvis-home-btn" title="Commands"><HelpCircle size={18} /></button>
        </div>
      )}
      <div className="jarvis-home-input-row">
        <button
          onClick={triggerWake}
          disabled={busy || submitting || !reachable}
          className="jarvis-home-btn jarvis-home-btn-mic"
          title="Push to talk"
        >
          <Mic size={20} />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendText()}
          placeholder="speak or type..."
          disabled={busy || submitting}
          className="jarvis-home-input"
        />
        {busy ? (
          <button onClick={interrupt} className="jarvis-home-btn jarvis-home-btn-stop" title="Stop">
            <Square size={18} />
          </button>
        ) : (
          <button
            onClick={sendText}
            disabled={!text.trim() || submitting}
            className="jarvis-home-btn jarvis-home-btn-send"
            title="Send"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

function HwRow({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  // Farbe je nach Auslastung
  const color = pct > 85 ? '#ef4444' : pct > 60 ? '#fbbf24' : '#7df9ff';
  return (
    <div className="jarvis-hw-row">
      <div className="jarvis-hw-row-head">
        <span className="jarvis-hw-label">{label}</span>
        <span className="jarvis-hw-value">{Math.round(pct)}%</span>
        {detail && <span className="jarvis-hw-detail">{detail}</span>}
      </div>
      <div className="jarvis-hw-bar">
        <div className="jarvis-hw-bar-fill" style={{ width: `${Math.min(100, pct)}%`, background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
    </div>
  );
}

const homeStyles = `
  body, html, #root {
    background: #02060f !important;
    overflow: hidden;
  }
  .jarvis-home-root {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    align-items: center;
    justify-items: center;
    padding: 2rem 1.5rem;
    gap: 1rem;
    background:
      radial-gradient(ellipse at 18% 28%, rgba(8, 110, 170, 0.18) 0%, transparent 55%),
      radial-gradient(ellipse at 82% 72%, rgba(120, 60, 200, 0.10) 0%, transparent 55%),
      radial-gradient(circle at center, rgba(8, 22, 50, 0.6) 0%, rgba(2, 6, 16, 0.95) 70%, #02060f 100%);
    overflow: hidden;
  }
  .jarvis-home-root::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(34, 211, 238, 0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34, 211, 238, 0.025) 1px, transparent 1px);
    background-size: 80px 80px;
    mask-image: radial-gradient(circle at center, black 30%, transparent 90%);
    pointer-events: none;
    z-index: 0;
  }

  /* ====== History Sidebar links — Glassmorph ====== */
  .jarvis-history {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 280px;
    z-index: 8;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, rgba(5, 16, 30, 0.55) 0%, rgba(2, 6, 16, 0.4) 100%);
    border-right: 1px solid rgba(125, 249, 255, 0.08);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    transform: translateX(0);
    transition: transform 0.3s ease;
  }
  .jarvis-history.closed {
    transform: translateX(-100%);
  }
  .jarvis-history-header {
    padding: 1.25rem 1.25rem 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .jarvis-history-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.6rem;
    letter-spacing: 0.35em;
    text-transform: uppercase;
    color: rgba(125, 249, 255, 0.45);
    font-weight: 400;
  }
  .jarvis-history-clear {
    background: transparent;
    border: none;
    color: rgba(180, 200, 230, 0.35);
    font-size: 0.65rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: color 0.15s;
  }
  .jarvis-history-clear:hover { color: rgba(255, 150, 130, 0.85); }

  .jarvis-history-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 1rem 1.25rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(125, 249, 255, 0.15) transparent;
  }
  .jarvis-history-list::-webkit-scrollbar { width: 4px; }
  .jarvis-history-list::-webkit-scrollbar-thumb {
    background: rgba(125, 249, 255, 0.15);
    border-radius: 2px;
  }

  .jarvis-history-empty {
    padding: 3rem 0;
    text-align: center;
    color: rgba(125, 249, 255, 0.25);
    font-size: 0.7rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .jarvis-history-pair {
    margin: 0.6rem 0 1.3rem;
    padding: 0.3rem 0;
    position: relative;
  }
  .jarvis-history-pair::before {
    content: "";
    position: absolute;
    left: -10px;
    top: 0.2rem;
    bottom: 0.2rem;
    width: 1px;
    background: linear-gradient(180deg, rgba(125, 249, 255, 0.4), rgba(125, 249, 255, 0.08));
  }
  .jarvis-history-q {
    color: rgba(160, 200, 235, 0.65);
    font-size: 0.78rem;
    font-weight: 300;
    line-height: 1.45;
    margin-bottom: 0.45rem;
    font-style: italic;
  }
  .jarvis-history-a {
    color: rgba(225, 240, 255, 0.85);
    font-size: 0.83rem;
    font-weight: 300;
    line-height: 1.5;
    letter-spacing: 0.01em;
  }
  .jarvis-history-time {
    margin-top: 0.4rem;
    font-size: 0.55rem;
    letter-spacing: 0.25em;
    color: rgba(125, 249, 255, 0.25);
    text-transform: uppercase;
  }

  /* Toggle-Button wenn Sidebar zu */
  .jarvis-history-toggle {
    position: fixed;
    top: 1.25rem;
    left: 1.25rem;
    z-index: 10;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(125, 249, 255, 0.18);
    border-radius: 9999px;
    background: rgba(8, 22, 40, 0.55);
    color: rgba(180, 220, 255, 0.6);
    backdrop-filter: blur(8px);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .jarvis-history-toggle:hover {
    color: rgba(255, 255, 255, 0.95);
    border-color: rgba(125, 249, 255, 0.5);
  }

  /* ====== Timer/Reminder Widget oben rechts ====== */
  .jarvis-tw {
    position: absolute;
    top: 4.5rem;
    right: 1.25rem;
    z-index: 7;
    width: 280px;
    padding: 12px 14px;
    border: 1px solid rgba(125, 249, 255, 0.22);
    border-radius: 12px;
    background: rgba(5, 16, 30, 0.72);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    font-family: 'Segoe UI', system-ui, sans-serif;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }
  .jarvis-tw-time-big {
    font-family: 'Segoe UI Mono', Consolas, monospace;
    font-size: 1.6rem;
    font-weight: 500;
    color: #fbbf24;
    text-shadow: 0 0 14px rgba(251, 191, 36, 0.55);
    line-height: 1.05;
    letter-spacing: 0.02em;
  }
  .jarvis-tw-item.warn .jarvis-tw-time-big {
    color: #f97316;
    text-shadow: 0 0 14px rgba(249, 115, 22, 0.7);
    animation: jarvis-tw-pulse 1s ease-in-out infinite;
  }
  .jarvis-tw-item.fire {
    background: rgba(239, 68, 68, 0.15);
    border-radius: 8px;
    padding-left: 8px;
    padding-right: 8px;
    margin: 2px -4px;
    animation: jarvis-tw-flash 0.6s ease-in-out infinite;
  }
  .jarvis-tw-item.fire .jarvis-tw-time-big {
    color: #fca5a5;
    text-shadow: 0 0 18px rgba(248, 113, 113, 0.9);
  }
  @keyframes jarvis-tw-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  @keyframes jarvis-tw-flash {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
    50%      { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
  }
  .jarvis-tw-section-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.55rem;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: rgba(125, 249, 255, 0.45);
    margin: 4px 0 6px;
  }
  .jarvis-tw-section-title:not(:first-child) {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(125, 249, 255, 0.08);
  }
  .jarvis-tw-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }
  .jarvis-tw-item + .jarvis-tw-item {
    border-top: 1px dashed rgba(125, 249, 255, 0.06);
  }
  .jarvis-tw-time {
    font-family: 'Segoe UI Mono', Consolas, monospace;
    font-size: 1.05rem;
    font-weight: 500;
    color: #fbbf24;
    flex: 1;
    text-shadow: 0 0 10px rgba(251, 191, 36, 0.5);
  }
  .jarvis-tw-rem {
    flex: 1;
    min-width: 0;
  }
  .jarvis-tw-rem-when {
    font-size: 0.65rem;
    color: rgba(125, 249, 255, 0.7);
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .jarvis-tw-rem-msg {
    font-size: 0.75rem;
    color: rgba(220, 240, 255, 0.85);
    font-weight: 300;
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.3;
  }
  .jarvis-tw-x {
    width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(125, 249, 255, 0.2);
    background: transparent;
    color: rgba(180, 220, 255, 0.4);
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .jarvis-tw-x:hover {
    color: rgba(255, 150, 130, 0.95);
    border-color: rgba(255, 150, 130, 0.5);
  }

  /* ====== Topright: settings + close-history ====== */
  .jarvis-home-topright {
    position: absolute;
    top: 1.25rem;
    right: 1.25rem;
    z-index: 10;
    display: flex;
    gap: 0.5rem;
  }
  .jarvis-home-iconbtn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(125, 249, 255, 0.18);
    border-radius: 9999px;
    background: rgba(8, 22, 40, 0.55);
    color: rgba(180, 220, 255, 0.6);
    backdrop-filter: blur(8px);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .jarvis-home-iconbtn:hover {
    border-color: rgba(125, 249, 255, 0.5);
    color: rgba(255, 255, 255, 0.95);
  }

  /* Status-Pill */
  .jarvis-home-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border: 1px solid rgba(125, 249, 255, 0.25);
    border-radius: 9999px;
    background: rgba(5, 22, 34, 0.55);
    color: rgba(220, 250, 255, 0.85);
    backdrop-filter: blur(10px);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 10px;
    z-index: 5;
  }
  .jarvis-home-status strong { color: #fbbf24; font-weight: 700; }
  .jarvis-home-status-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: rgba(125, 249, 255, 0.9);
    box-shadow: 0 0 8px rgba(125, 249, 255, 0.7);
  }
  .jarvis-home-status-dot[data-phase="busy"] {
    background: #fbbf24;
    box-shadow: 0 0 10px rgba(251, 191, 36, 0.9);
    animation: jarvis-home-blink 0.7s ease-in-out infinite;
  }
  .jarvis-home-status-dot[data-phase="off"] {
    background: rgba(239, 68, 68, 0.7);
  }
  @keyframes jarvis-home-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* Orb-Stage */
  .jarvis-home-orb-stage {
    width: min(85vw, 620px);
    height: min(85vw, 620px);
    max-height: 70vh;
    position: relative;
    z-index: 1;
  }
  .jarvis-home-orb-stage .jarvis-reactor,
  .jarvis-home-orb-stage .jarvis-r3f-reactor {
    width: 100%;
    height: 100%;
    position: relative;
  }
  .jarvis-home-orb-stage canvas {
    width: 100% !important;
    height: 100% !important;
  }

  /* TTS-Subtitle: synchron zu Word-Boundaries unter dem Orb */
  .jarvis-tts-subtitle {
    position: absolute;
    bottom: 6%;
    left: 50%;
    transform: translateX(-50%);
    max-width: 90%;
    padding: 0.5rem 1.2rem;
    border-radius: 999px;
    background: rgba(5, 16, 30, 0.55);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: rgba(220, 240, 255, 0.92);
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 0.95rem;
    font-weight: 300;
    letter-spacing: 0.01em;
    line-height: 1.3;
    text-align: center;
    pointer-events: none;
    z-index: 5;
    animation: jarvis-subtitle-in 0.18s ease-out;
    text-shadow: 0 0 12px rgba(125, 249, 255, 0.35);
  }
  @keyframes jarvis-subtitle-in {
    from { opacity: 0; transform: translate(-50%, 4px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }

  /* Dialog */
  .jarvis-home-dialog {
    max-width: 720px;
    width: 100%;
    text-align: center;
    min-height: 4rem;
    z-index: 5;
  }
  .jarvis-home-line { margin: 0.35rem 0; }
  .jarvis-home-line-user span {
    color: rgba(160, 200, 235, 0.7);
    font-size: 0.85rem;
    font-style: italic;
  }
  .jarvis-home-line-user span::before {
    content: "you: ";
    font-style: normal;
    opacity: 0.4;
    letter-spacing: 0.12em;
    font-size: 0.7rem;
    text-transform: uppercase;
  }
  .jarvis-home-line-jarvis span {
    color: rgba(225, 245, 255, 0.97);
    font-size: 1.1rem;
    font-weight: 300;
    text-shadow: 0 0 28px rgba(34, 211, 238, 0.25);
    line-height: 1.5;
  }
  .jarvis-home-line-hint span {
    color: rgba(125, 249, 255, 0.4);
    font-size: 0.78rem;
    letter-spacing: 0.35em;
    text-transform: uppercase;
  }

  /* Input row */
  .jarvis-home-input-row {
    width: 100%;
    max-width: 520px;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    z-index: 5;
  }
  @keyframes jbar { 0%, 100% { transform: scaleY(0.25); opacity: 0.6; } 50% { transform: scaleY(1); opacity: 1; } }
  .jbar { width: 3px; height: 20px; background: rgba(34, 211, 238, 0.92); border-radius: 2px; transform-origin: center; box-shadow: 0 0 8px rgba(34, 211, 238, 0.5); }
  .bd-wrap{position:fixed;inset:0;z-index:81;overflow:hidden;background:radial-gradient(140% 120% at 50% 28%, rgba(10,26,48,0.6), rgba(1,3,8,0.97));animation:hudFade .5s ease;}
  .bd-gridbg{position:absolute;inset:0;background-image:linear-gradient(rgba(125,249,255,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(125,249,255,0.05) 1px,transparent 1px);background-size:46px 46px;-webkit-mask-image:radial-gradient(circle at 50% 42%, black, transparent 68%);mask-image:radial-gradient(circle at 50% 42%, black, transparent 68%);animation:hudGrid 22s linear infinite;pointer-events:none;}
  .bd-reactor{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);width:min(80vh,760px);height:min(80vh,760px);opacity:.42;pointer-events:none;}
  .bd-scan{position:absolute;left:0;width:100%;height:2px;background:linear-gradient(90deg,transparent,rgba(125,249,255,0.45),transparent);animation:hudScan 6s ease-in-out infinite;pointer-events:none;}
  .bd-deck{position:relative;height:100vh;display:grid;grid-template-columns:minmax(0,0.95fr) 1.5fr minmax(0,0.95fr);grid-template-rows:auto minmax(0,1fr) auto;gap:clamp(12px,1.5vw,20px);padding:clamp(16px,3vh,38px) clamp(16px,3vw,46px);box-sizing:border-box;}
  .bd-panel{background:linear-gradient(160deg, rgba(8,20,38,0.62), rgba(4,11,22,0.62));border:1px solid rgba(125,249,255,0.18);border-radius:18px;padding:15px 17px;backdrop-filter:blur(7px);position:relative;min-height:0;animation:hudCascade .6s ease both;}
  .bd-panel.sc{overflow-y:auto;}
  .bd-cell{position:relative;min-height:0;display:flex;flex-direction:column;}
  .bd-close{position:absolute;top:16px;right:20px;z-index:9;width:38px;height:38px;border-radius:50%;border:1px solid rgba(125,249,255,0.3);background:rgba(8,20,38,0.7);color:#bfefff;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
  .bd-close:hover{background:rgba(255,80,80,0.28);color:#fff;}
  .bd-newsrow{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;}
  .bd-newscard{flex:0 0 232px;border-radius:13px;overflow:hidden;background:rgba(255,255,255,0.04);border:1px solid rgba(125,249,255,0.1);text-decoration:none;color:inherit;transition:transform .15s, box-shadow .15s;}
  .bd-newscard:hover{transform:translateY(-3px);box-shadow:0 12px 28px rgba(0,0,0,0.5);}
  @media (max-width:900px){.bd-deck{display:block;height:100vh;overflow-y:auto;}.bd-deck>*{margin-bottom:14px;grid-column:auto !important;grid-row:auto !important;}.bd-reactor{opacity:.2;}.bd-panel.sc{overflow:visible;}}
  @keyframes hudFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes hudGrid { from { background-position: 0 0, 0 0; } to { background-position: 44px 44px, 44px 44px; } }
  @keyframes hudSpin { to { transform: rotate(360deg); } }
  @keyframes hudSpinR { to { transform: rotate(-360deg); } }
  @keyframes hudScan { 0% { top: 0; opacity: 0; } 12% { opacity: 0.9; } 88% { opacity: 0.9; } 100% { top: 100%; opacity: 0; } }
  @keyframes hudCascade { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
  @keyframes hudGlow { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
  @keyframes hudFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
  @keyframes hudReveal { 0% { opacity: 0; clip-path: inset(0 100% 0 0); filter: blur(4px); } 100% { opacity: 1; clip-path: inset(0 0 0 0); filter: blur(0); } }
  @keyframes brFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes brPop { 0% { opacity: 0; transform: translateY(20px) scale(0.95); } 100% { opacity: 1; transform: none; } }
  @keyframes jbootFade { 0%, 65% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
  @keyframes jbootSweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(120%); } }
  @keyframes jbootText { 0% { opacity: 0; letter-spacing: 0.7em; filter: blur(6px); } 45% { opacity: 1; filter: blur(0); } 100% { opacity: 1; letter-spacing: 0.3em; } }
  @keyframes jbootRing { 0% { transform: scale(0.6); opacity: 0; } 50% { opacity: 0.8; } 100% { transform: scale(1.4); opacity: 0; } }
  .jarvis-home-btn {
    width: 46px; height: 46px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(125, 249, 255, 0.3);
    border-radius: 9999px;
    background: rgba(15, 35, 70, 0.4);
    color: rgba(220, 240, 255, 0.95);
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
    backdrop-filter: blur(6px);
  }
  .jarvis-home-btn:hover:not(:disabled) {
    background: rgba(34, 70, 130, 0.6);
    border-color: rgba(180, 235, 255, 0.6);
    box-shadow: 0 0 18px rgba(34, 211, 238, 0.35);
  }
  .jarvis-home-btn:disabled { opacity: 0.3; cursor: default; }
  .jarvis-home-btn-mic { background: rgba(34, 211, 238, 0.22); }
  .jarvis-home-btn-send { background: rgba(34, 211, 238, 0.22); }
  .jarvis-home-btn-stop {
    background: rgba(220, 80, 60, 0.38);
    border-color: rgba(255, 150, 130, 0.5);
  }

  .jarvis-home-input {
    flex: 1; height: 46px; padding: 0 1.25rem;
    background: rgba(8, 22, 40, 0.4);
    border: 1px solid rgba(125, 249, 255, 0.22);
    border-radius: 9999px;
    color: rgba(220, 240, 255, 0.95);
    font-size: 0.95rem;
    outline: none;
    backdrop-filter: blur(6px);
    transition: all 0.15s;
  }
  .jarvis-home-input:focus {
    border-color: rgba(125, 249, 255, 0.5);
    box-shadow: 0 0 22px rgba(34, 211, 238, 0.18);
  }
  .jarvis-home-input:disabled { opacity: 0.5; }
  .jarvis-home-input::placeholder {
    color: rgba(125, 249, 255, 0.3);
    letter-spacing: 0.1em;
    font-size: 0.8rem;
    text-transform: uppercase;
  }

  /* ====== Hardware-Widget unten rechts ====== */
  .jarvis-hw {
    position: absolute;
    bottom: 1.25rem;
    right: 1.25rem;
    z-index: 6;
    width: 230px;
    padding: 10px 12px 10px;
    border: 1px solid rgba(125, 249, 255, 0.18);
    border-radius: 8px;
    background: rgba(5, 16, 30, 0.65);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    font-family: 'Segoe UI Mono', 'SF Mono', Consolas, monospace;
    pointer-events: none;
  }
  .jarvis-hw-title {
    font-size: 0.55rem;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    color: rgba(125, 249, 255, 0.5);
    margin-bottom: 8px;
    text-align: center;
  }
  .jarvis-hw-row {
    margin-bottom: 6px;
  }
  .jarvis-hw-row:last-child { margin-bottom: 0; }
  .jarvis-hw-row-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 0.65rem;
    margin-bottom: 2px;
  }
  .jarvis-hw-label {
    color: rgba(180, 220, 255, 0.55);
    letter-spacing: 0.15em;
    text-transform: uppercase;
    width: 38px;
  }
  .jarvis-hw-value {
    color: rgba(220, 245, 255, 0.95);
    font-weight: 500;
    min-width: 36px;
    text-align: right;
  }
  .jarvis-hw-detail {
    color: rgba(125, 249, 255, 0.4);
    font-size: 0.55rem;
    margin-left: auto;
  }
  .jarvis-hw-bar {
    height: 3px;
    background: rgba(125, 249, 255, 0.08);
    border-radius: 2px;
    overflow: hidden;
  }
  .jarvis-hw-bar-fill {
    height: 100%;
    transition: width 0.4s ease, background 0.3s ease;
    border-radius: 2px;
  }
  .jarvis-hw-runtime {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(125, 249, 255, 0.08);
  }
  .jarvis-hw-rt-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.55rem;
    margin: 2px 0;
    overflow: hidden;
  }
  .jarvis-hw-rt-key {
    color: rgba(125, 249, 255, 0.5);
    letter-spacing: 0.15em;
    text-transform: uppercase;
    width: 28px;
    flex-shrink: 0;
  }
  .jarvis-hw-rt-val {
    color: rgba(220, 240, 255, 0.7);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .jarvis-hw-procs {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(125, 249, 255, 0.08);
  }
  .jarvis-hw-procs-title {
    font-size: 0.5rem;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: rgba(125, 249, 255, 0.4);
    margin-bottom: 4px;
  }
  .jarvis-hw-proc {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-size: 0.55rem;
    margin: 1px 0;
  }
  .jarvis-hw-proc-name {
    color: rgba(180, 220, 255, 0.55);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jarvis-hw-proc-vram {
    color: rgba(125, 249, 255, 0.7);
    flex-shrink: 0;
  }
`;
