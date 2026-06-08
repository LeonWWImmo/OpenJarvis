import { useEffect, useState, useRef, useCallback } from 'react';
import { Mic, Send, Volume2, Loader2, CheckCircle2, XCircle, Square, RotateCcw } from 'lucide-react';

const VOICE_LOOP_URL = 'http://127.0.0.1:8770';

type Health = {
  ok: boolean;
  whisper_ready: boolean;
  kokoro_ready: boolean;
  pipeline_busy: boolean;
  last_wake_event_id: number;
  events: number;
  error: string | null;
  history_turns?: number;
  voice_model?: string;
  active_tts_voice?: string;
  deep_think_armed?: boolean;
  local_wake_enabled?: boolean;
  local_wake_models?: string[];
};

type ChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

export function VoicePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reachable, setReachable] = useState(true);
  const lastIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [hr, cr] = await Promise.all([
        fetch(`${VOICE_LOOP_URL}/health`),
        fetch(`${VOICE_LOOP_URL}/chat_log?after=0`),
      ]);
      const h: Health = await hr.json();
      const c = await cr.json();
      setHealth(h);
      const msgs: ChatMessage[] = c.messages ?? [];
      setMessages(msgs);
      const maxId = msgs.length > 0 ? msgs[msgs.length - 1].id : 0;
      lastIdRef.current = maxId;
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 800);
    return () => clearInterval(id);
  }, [refresh]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const triggerWake = async () => {
    setSubmitting(true);
    try {
      await fetch(`${VOICE_LOOP_URL}/trigger`, { method: 'POST' });
    } finally {
      setSubmitting(false);
    }
  };

  const sendText = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    const t = text.trim();
    setText('');
    try {
      await fetch(`${VOICE_LOOP_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const interrupt = async () => {
    await fetch(`${VOICE_LOOP_URL}/interrupt`, { method: 'POST' });
  };

  const resetChat = async () => {
    await fetch(`${VOICE_LOOP_URL}/reset`, { method: 'POST' });
    refresh();
  };

  const busy = health?.pipeline_busy ?? false;
  const phase = !reachable ? 'down' : busy ? 'busy' : 'idle';

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--color-bg)' }}>
      <style>{orbStyles}</style>

      {/* Header */}
      <div
        className="px-6 py-3 flex items-center gap-4 shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }}
      >
        <VoiceOrb phase={phase} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            JARVIS Voice
          </div>
          <div className="text-xs truncate" style={{ color: 'var(--color-text-tertiary)' }}>
            {!reachable
              ? 'Voice loop offline'
              : busy
                ? 'Pipeline active...'
                : `Ready · ${health?.voice_model ?? '?'} · voice: ${health?.active_tts_voice ?? '?'}${health?.deep_think_armed ? ' · deep-think armed' : ''}`}
          </div>
        </div>
        <button
          onClick={interrupt}
          disabled={!busy || !reachable}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-opacity disabled:opacity-40 cursor-pointer"
          style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          title="Interrupt TTS"
        >
          <Square size={12} /> Stop
        </button>
        <button
          onClick={resetChat}
          disabled={!reachable}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-opacity disabled:opacity-40 cursor-pointer"
          style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          title="Clear chat and conversation history"
        >
          <RotateCcw size={12} /> Reset
        </button>
        <StatusDots health={health} reachable={reachable} />
      </div>

      {/* Chat Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {messages.length === 0 ? (
            <div className="text-center py-12" style={{ color: 'var(--color-text-tertiary)' }}>
              <Mic size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Start by saying "Hey Jarvis" or typing below.</p>
              <p className="text-xs mt-1">Both voice and text appear here as chat.</p>
            </div>
          ) : (
            messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))
          )}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex items-center gap-2 px-3 py-2">
              <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                Jarvis is thinking...
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div
        className="px-6 py-3 shrink-0"
        style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }}
      >
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <button
            onClick={triggerWake}
            disabled={busy || submitting || !reachable}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-opacity disabled:opacity-40 cursor-pointer shrink-0"
            style={{ background: 'var(--color-accent)', color: 'white' }}
            title="Push-to-talk — microphone listens until silence"
          >
            <Mic size={16} />
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendText()}
            placeholder="Type a message or use the mic..."
            disabled={busy || submitting}
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none disabled:opacity-40"
            style={{
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          />
          <button
            onClick={sendText}
            disabled={!text.trim() || busy || submitting}
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-opacity disabled:opacity-40 cursor-pointer shrink-0"
            style={{ background: 'var(--color-accent)', color: 'white' }}
            title="Send"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words"
        style={{
          background: isUser ? 'var(--color-accent)' : 'var(--color-bg-secondary)',
          color: isUser ? 'white' : 'var(--color-text)',
          border: isUser ? 'none' : '1px solid var(--color-border)',
        }}
      >
        {message.content}
      </div>
    </div>
  );
}

function StatusDots({ health, reachable }: { health: Health | null; reachable: boolean }) {
  if (!reachable) {
    return <XCircle size={14} style={{ color: '#ef4444' }} />;
  }
  const allReady = health?.whisper_ready && health?.kokoro_ready;
  if (!allReady) {
    return <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />;
  }
  return <CheckCircle2 size={14} style={{ color: '#10b981' }} />;
}

function VoiceOrb({ phase }: { phase: 'idle' | 'busy' | 'down' }) {
  const color = phase === 'down' ? '#ef4444' : phase === 'busy' ? '#f59e0b' : '#3b82f6';
  const cls = phase === 'down' ? 'oj-orb-down' : phase === 'busy' ? 'oj-orb-busy' : 'oj-orb-idle';
  return (
    <div className={`oj-orb ${cls}`} style={{ ['--orb-color' as any]: color }}>
      <div className="oj-orb-ring oj-orb-ring-outer" />
      <div className="oj-orb-ring oj-orb-ring-inner" />
      <div className="oj-orb-core" />
    </div>
  );
}

const orbStyles = `
.oj-orb { position: relative; width: 36px; height: 36px; flex-shrink: 0; }
.oj-orb-core {
  position: absolute; inset: 12px;
  background: var(--orb-color); border-radius: 50%;
  box-shadow: 0 0 12px var(--orb-color);
}
.oj-orb-ring { position: absolute; border-radius: 50%; border: 1.5px solid var(--orb-color); opacity: 0.5; }
.oj-orb-ring-outer { inset: 0;   animation: oj-rot 6s linear infinite; }
.oj-orb-ring-inner { inset: 6px; animation: oj-rot 3s linear infinite reverse; opacity: 0.7; }
@keyframes oj-rot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes oj-pulse-soft { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.7; } }
@keyframes oj-pulse-fast { 0%,100% { transform: scale(1); } 50% { transform: scale(1.2); } }
.oj-orb-idle .oj-orb-core { animation: oj-pulse-soft 2.5s ease-in-out infinite; }
.oj-orb-busy .oj-orb-core { animation: oj-pulse-fast 0.6s ease-in-out infinite; }
.oj-orb-down .oj-orb-core { animation: none; opacity: 0.3; }
`;
