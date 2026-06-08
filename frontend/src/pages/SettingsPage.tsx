import { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  Palette,
  Globe,
  Cpu,
  Database,
  Info,
  Check,
  Sun,
  Moon,
  Monitor,
  Download,
  Upload,
  Trash2,
  Volume2,
  FolderOpen,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useAppStore, type ThemeMode } from '../lib/store';
import {
  checkHealth,
  fetchModels,
  fetchServerInfo,
  fetchSpeechHealth,
  getMemoryStatus,
  listTtsVoices,
  openLocalTarget,
  openMemoryTarget,
  searchMemory,
  speakText,
  syncMemoryBrain,
  type LocalTarget,
  type MemorySearchResult,
  type MemoryStatus,
  type TtsVoice,
} from '../lib/api';

function OllamaModelList() {
  const [models, setModels] = useState<Array<{ name: string; size: number }>>([]);
  useEffect(() => {
    fetchModels()
      .then(data => setModels(data.map((m) => ({ name: m.id, size: 0 }))))
      .catch(() => setModels([]));
  }, []);
  if (models.length === 0) return <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>No models loaded</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {models.map(m => (
        <span key={m.name} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
          style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
          {m.name}{m.size > 0 ? ` (${(m.size / 1e9).toFixed(1)} GB)` : ''}
        </span>
      ))}
    </div>
  );
}

function ApiKeyInput({ storageKey, placeholder }: { storageKey: string; placeholder: string }) {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(storageKey) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const save = (v: string) => {
    setValue(v);
    try { if (v) localStorage.setItem(storageKey, v); else localStorage.removeItem(storageKey); } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
    <div className="flex items-center gap-2">
      <input type="password" value={value} onChange={e => save(e.target.value)} placeholder={placeholder}
        className="w-48 px-2 py-1 rounded text-xs"
        style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} />
      {saved && <span className="text-[10px]" style={{ color: '#22c55e' }}>Saved</span>}
    </div>
  );
}

function CloudProviderStatus({ label, storageKey }: { label: string; storageKey: string }) {
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => {
    try { setHasKey(!!localStorage.getItem(storageKey)); } catch { setHasKey(false); }
  }, [storageKey]);
  return (
    <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
        background: hasKey ? '#22c55e' : 'var(--color-text-tertiary)',
      }} />
      {label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-5"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <div>
        <div className="text-sm" style={{ color: 'var(--color-text)' }}>{label}</div>
        {description && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{description}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function MemoryOpenButton({ target, children }: { target: 'vault' | 'inbox' | 'long_term' | 'profile'; children: React.ReactNode }) {
  const [failed, setFailed] = useState(false);

  const open = async () => {
    setFailed(false);
    try {
      await openMemoryTarget(target);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  };

  return (
    <button
      onClick={open}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
      style={{
        background: failed ? 'rgba(220,38,38,0.12)' : 'var(--color-bg-secondary)',
        color: failed ? 'var(--color-error)' : 'var(--color-text-secondary)',
        border: failed ? '1px solid var(--color-error)' : '1px solid var(--color-border)',
      }}
      title={failed ? 'Could not open memory file' : undefined}
    >
      <FolderOpen size={12} /> {failed ? 'Failed' : children}
    </button>
  );
}

function LocalOpenButton({ target, children }: { target: LocalTarget; children: React.ReactNode }) {
  const [failed, setFailed] = useState(false);

  const open = async () => {
    setFailed(false);
    try {
      await openLocalTarget(target);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  };

  return (
    <button
      onClick={open}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
      style={{
        background: failed ? 'rgba(220,38,38,0.12)' : 'var(--color-bg-secondary)',
        color: failed ? 'var(--color-error)' : 'var(--color-text-secondary)',
        border: failed ? '1px solid var(--color-error)' : '1px solid var(--color-border)',
      }}
      title={failed ? 'Could not open local target' : undefined}
    >
      <FolderOpen size={12} /> {failed ? 'Failed' : children}
    </button>
  );
}

function formatMemoryTime(value: number | null | undefined): string {
  if (!value) return 'missing';
  return new Date(value * 1000).toLocaleString();
}

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const conversations = useAppStore((s) => s.conversations);
  const serverInfo = useAppStore((s) => s.serverInfo);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [speechBackendAvailable, setSpeechBackendAvailable] = useState<boolean | null>(null);
  const [browserSpeechAvailable, setBrowserSpeechAvailable] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const [saved, setSaved] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [memorySyncing, setMemorySyncing] = useState(false);
  const [memorySyncError, setMemorySyncError] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memorySearchResults, setMemorySearchResults] = useState<MemorySearchResult[]>([]);
  const [memorySearching, setMemorySearching] = useState(false);
  const [memorySearchError, setMemorySearchError] = useState<string | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [selfTestResults, setSelfTestResults] = useState<Array<{ label: string; ok: boolean; detail: string }>>([]);

  useEffect(() => {
    const win = window as any;
    setBrowserSpeechAvailable(Boolean(win.SpeechRecognition || win.webkitSpeechRecognition));
    checkHealth().then(setHealthy);
    fetchSpeechHealth()
      .then((h) => setSpeechBackendAvailable(h.available))
      .catch(() => setSpeechBackendAvailable(false));
    listTtsVoices()
      .then((voices) => {
        setTtsVoices(voices);
        if (!settings.ttsVoiceName && voices.some((voice) => voice.name === 'Kokoro George UK')) {
          updateSettings({ ttsVoiceName: 'Kokoro George UK' });
        } else if (!settings.ttsVoiceName && voices.some((voice) => voice.name === 'Piper Alan UK')) {
          updateSettings({ ttsVoiceName: 'Piper Alan UK' });
        }
      })
      .catch(() => setTtsVoices([]));
    getMemoryStatus().then(setMemoryStatus).catch(() => setMemoryStatus(null));
  }, [settings.ttsVoiceName, updateSettings]);

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleMemorySync = async () => {
    setMemorySyncing(true);
    setMemorySyncError(null);
    try {
      await syncMemoryBrain();
      setMemoryStatus(await getMemoryStatus());
      showSaved();
    } catch (error) {
      setMemorySyncError(error instanceof Error ? error.message : 'Brain sync failed');
    } finally {
      setMemorySyncing(false);
    }
  };

  const handleMemorySearch = async () => {
    const query = memoryQuery.trim();
    if (!query) return;
    setMemorySearching(true);
    setMemorySearchError(null);
    try {
      setMemorySearchResults(await searchMemory(query, 5));
    } catch (error) {
      setMemorySearchError(error instanceof Error ? error.message : 'Brain search failed');
      setMemorySearchResults([]);
    } finally {
      setMemorySearching(false);
    }
  };

  const handleSelfTest = async () => {
    setSelfTestRunning(true);
    const results: Array<{ label: string; ok: boolean; detail: string }> = [];

    const addResult = (label: string, ok: boolean, detail: string) => {
      results.push({ label, ok, detail });
      setSelfTestResults([...results]);
    };

    const backendOk = await checkHealth();
    addResult('Backend', backendOk, backendOk ? 'API server reachable' : 'API server not reachable');

    try {
      const info = await fetchServerInfo();
      addResult('Inference', true, `${info.engine} / ${info.model}`);
    } catch (error) {
      addResult('Inference', false, error instanceof Error ? error.message : 'Model info unavailable');
    }

    try {
      const models = await fetchModels();
      addResult('Ollama models', models.length > 0, models.length > 0 ? `${models.length} local model(s) found` : 'No local models found');
    } catch (error) {
      addResult('Ollama models', false, error instanceof Error ? error.message : 'Model list unavailable');
    }

    try {
      const speech = await fetchSpeechHealth();
      addResult('Speech', speech.available, speech.available ? `${speech.backend} available` : 'Speech backend unavailable');
    } catch (error) {
      addResult('Speech', false, error instanceof Error ? error.message : 'Speech check failed');
    }

    try {
      const memory = await getMemoryStatus();
      addResult('Jarvis Brain', Boolean(memory), memory?.needs_sync ? 'Vault found, sync recommended' : memory ? 'Vault and memory DB reachable' : 'Desktop memory status unavailable');
      if (memory) setMemoryStatus(memory);
    } catch (error) {
      addResult('Jarvis Brain', false, error instanceof Error ? error.message : 'Brain status failed');
    }

    setSelfTestRunning(false);
  };

  const chooseJarvisVoice = () => {
    const kokoroGeorge = ttsVoices.find((voice) => voice.name === 'Kokoro George UK');
    if (kokoroGeorge) {
      updateSettings({
        ttsVoiceName: kokoroGeorge.name,
        ttsRate: -1,
        ttsVolume: 100,
      });
      showSaved();
      return;
    }
    const piperAlan = ttsVoices.find((voice) => voice.name === 'Piper Alan UK');
    if (piperAlan) {
      updateSettings({
        ttsVoiceName: piperAlan.name,
        ttsRate: -1,
        ttsVolume: 100,
      });
      showSaved();
      return;
    }
    const candidates = ['george', 'ryan', 'guy', 'mark', 'david', 'james', 'richard', 'daniel'];
    const byName = ttsVoices.find((voice) => candidates.some((candidate) => voice.name.toLowerCase().includes(candidate)));
    const british = ttsVoices.find((voice) => voice.culture?.toLowerCase().startsWith('en-gb'));
    const male = ttsVoices.find((voice) => voice.gender?.toLowerCase() === 'male');
    const selected = byName || british || male || ttsVoices[0];
    updateSettings({
      ttsVoiceName: selected?.name || '',
      ttsRate: -1,
      ttsVolume: 100,
    });
    showSaved();
  };

  const testVoice = () => {
    void speakText('Good evening, Sir. I am online, listening, and ready when you are.', {
      voiceName: settings.ttsVoiceName,
      rate: settings.ttsRate,
      volume: settings.ttsVolume,
    });
  };

  const handleExport = () => {
    const data = localStorage.getItem('openjarvis-conversations') || '{}';
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openjarvis-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          if (data.version === 1) {
            localStorage.setItem('openjarvis-conversations', JSON.stringify(data));
            useAppStore.getState().loadConversations();
            showSaved();
          }
        } catch {}
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const [confirmClear, setConfirmClear] = useState(false);
  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    localStorage.removeItem('openjarvis-conversations');
    useAppStore.getState().loadConversations();
    setConfirmClear(false);
    showSaved();
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Settings size={24} style={{ color: 'var(--color-accent)' }} />
          <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
            Settings
          </h1>
          {saved && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full" style={{
              background: 'var(--color-accent-subtle)',
              color: 'var(--color-success)',
            }}>
              <Check size={12} /> Saved
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {/* Appearance */}
          <Section title="Appearance">
            <SettingRow label="Theme" description="Choose how OpenJarvis looks">
              <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: 'var(--color-bg-secondary)' }}>
                {themeOptions.map((opt) => {
                  const isActive = settings.theme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { updateSettings({ theme: opt.value }); showSaved(); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer"
                      style={{
                        background: isActive ? 'var(--color-surface)' : 'transparent',
                        color: isActive ? 'var(--color-text)' : 'var(--color-text-tertiary)',
                        boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
                      }}
                    >
                      <opt.icon size={14} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </SettingRow>
            <SettingRow label="Font size">
              <select
                value={settings.fontSize}
                onChange={(e) => { updateSettings({ fontSize: e.target.value as any }); showSaved(); }}
                className="text-sm px-3 py-1.5 rounded-lg outline-none cursor-pointer"
                style={{
                  background: 'var(--color-bg-secondary)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <option value="small">Small</option>
                <option value="default">Default</option>
                <option value="large">Large</option>
              </select>
            </SettingRow>
          </Section>

          {/* Connection */}
          <Section title="Connection">
            <SettingRow label="Server status" description={serverInfo ? `${serverInfo.engine} / ${serverInfo.model}` : 'Not connected'}>
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: healthy === true ? 'var(--color-success)' : healthy === false ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}
                />
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  {healthy === true ? 'Connected' : healthy === false ? 'Disconnected' : 'Checking...'}
                </span>
              </div>
            </SettingRow>
            <SettingRow label="API URL" description="Remote OpenJarvis server, for example http://192.168.1.20:8088">
              <input
                type="text"
                value={settings.apiUrl}
                onChange={(e) => { updateSettings({ apiUrl: e.target.value }); showSaved(); }}
                placeholder="http://SERVER-IP:8088"
                className="text-sm px-3 py-1.5 rounded-lg outline-none w-56"
                style={{
                  background: 'var(--color-bg-secondary)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                }}
              />
            </SettingRow>
          </Section>

          {/* Self-test */}
          <Section title="Self-test">
            <SettingRow label="Assistant check" description="Checks remote backend and model plus local speech and brain integration">
              <button
                onClick={handleSelfTest}
                disabled={selfTestRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                style={{
                  background: 'var(--color-bg-secondary)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <RefreshCw size={12} className={selfTestRunning ? 'animate-spin' : ''} />
                {selfTestRunning ? 'Running...' : 'Run self-test'}
              </button>
            </SettingRow>
            {selfTestResults.length > 0 && (
              <div className="grid gap-2 mt-2">
                {selfTestResults.map((result) => (
                  <div
                    key={result.label}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-xs"
                    style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle)' }}
                  >
                    <span className="flex items-center gap-2" style={{ color: 'var(--color-text)' }}>
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: result.ok ? 'var(--color-success)' : 'var(--color-error)' }}
                      />
                      {result.label}
                    </span>
                    <span className="text-right" style={{ color: 'var(--color-text-tertiary)' }}>
                      {result.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Models */}
          <Section title="Models">
            <SettingRow label="Local models (Ollama)" description="Models available for local inference">
              <OllamaModelList />
            </SettingRow>
            <div className="text-xs mt-2 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
              Run <code className="px-1 py-0.5 rounded text-[11px]" style={{ background: 'var(--color-bg-tertiary)' }}>ollama pull &lt;model-name&gt;</code> in your terminal to add more models
            </div>
            <SettingRow label="Cloud providers" description="Green dot means API key is configured">
              <div className="flex flex-wrap gap-3">
                <CloudProviderStatus label="OpenAI" storageKey="openjarvis-openai-key" />
                <CloudProviderStatus label="Anthropic" storageKey="openjarvis-anthropic-key" />
                <CloudProviderStatus label="Google" storageKey="openjarvis-gemini-key" />
                <CloudProviderStatus label="OpenRouter" storageKey="openjarvis-openrouter-key" />
              </div>
            </SettingRow>
          </Section>

          {/* API Keys */}
          <Section title="API Keys">
            <SettingRow label="OpenAI" description="GPT-4, GPT-3.5, etc.">
              <ApiKeyInput storageKey="openjarvis-openai-key" placeholder="sk-..." />
            </SettingRow>
            <SettingRow label="Anthropic" description="Claude models">
              <ApiKeyInput storageKey="openjarvis-anthropic-key" placeholder="sk-ant-..." />
            </SettingRow>
            <SettingRow label="Google" description="Gemini models">
              <ApiKeyInput storageKey="openjarvis-gemini-key" placeholder="AI..." />
            </SettingRow>
            <SettingRow label="OpenRouter" description="Multi-provider routing">
              <ApiKeyInput storageKey="openjarvis-openrouter-key" placeholder="sk-or-..." />
            </SettingRow>
          </Section>

          {/* Tools */}
          <Section title="Tools">
            <SettingRow label="Web Search" description="SerpAPI or Tavily key for web search tool">
              <ApiKeyInput storageKey="openjarvis-search-key" placeholder="API key..." />
            </SettingRow>
          </Section>

          {/* Model defaults */}
          <Section title="Model Defaults">
            <SettingRow label="Temperature" description={`${settings.temperature}`}>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={settings.temperature}
                onChange={(e) => { updateSettings({ temperature: parseFloat(e.target.value) }); showSaved(); }}
                className="w-32 cursor-pointer accent-[var(--color-accent)]"
              />
            </SettingRow>
            <SettingRow label="Max tokens" description={`${settings.maxTokens}`}>
              <input
                type="range"
                min="256"
                max="32768"
                step="256"
                value={settings.maxTokens}
                onChange={(e) => { updateSettings({ maxTokens: parseInt(e.target.value) }); showSaved(); }}
                className="w-32 cursor-pointer accent-[var(--color-accent)]"
              />
            </SettingRow>
          </Section>

          {/* Speech */}
          <Section title="Speech">
            <SettingRow label="Speech-to-Text" description="Enable microphone input for voice dictation">
              <button
                onClick={() => { updateSettings({ speechEnabled: !settings.speechEnabled }); showSaved(); }}
                className="relative w-11 h-6 rounded-full transition-colors cursor-pointer"
                style={{
                  background: settings.speechEnabled ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                }}
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform bg-white"
                  style={{
                    transform: settings.speechEnabled ? 'translateX(20px)' : 'translateX(0)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </SettingRow>
            <SettingRow label="Wake word" description="Say the wake word to start a short voice capture automatically">
              <button
                onClick={() => { updateSettings({ wakeWordEnabled: !settings.wakeWordEnabled, speechEnabled: true }); showSaved(); }}
                className="relative w-11 h-6 rounded-full transition-colors cursor-pointer"
                style={{
                  background: settings.wakeWordEnabled ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                }}
                title="Wake word"
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform bg-white"
                  style={{
                    transform: settings.wakeWordEnabled ? 'translateX(20px)' : 'translateX(0)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </SettingRow>
            {settings.wakeWordEnabled && (
              <>
                <SettingRow label="Wake phrase" description="Default: Jarvis">
                  <input
                    type="text"
                    value={settings.wakeWord}
                    onChange={(e) => { updateSettings({ wakeWord: e.target.value || 'jarvis' }); showSaved(); }}
                    className="text-sm px-3 py-1.5 rounded-lg outline-none w-36"
                    style={{
                      background: 'var(--color-bg-secondary)',
                      color: 'var(--color-text)',
                      border: '1px solid var(--color-border)',
                    }}
                    placeholder="jarvis"
                  />
                </SettingRow>
                <SettingRow label="Wake capture" description={`${settings.wakeCaptureSeconds}s after wake word`}>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="1"
                    value={settings.wakeCaptureSeconds}
                    onChange={(e) => { updateSettings({ wakeCaptureSeconds: parseInt(e.target.value, 10) }); showSaved(); }}
                    className="w-32 cursor-pointer accent-[var(--color-accent)]"
                  />
                </SettingRow>
              </>
            )}
            <SettingRow label="Text-to-Speech" description="Speak assistant answers through the local browser voice">
              <button
                onClick={() => { updateSettings({ ttsEnabled: !settings.ttsEnabled }); showSaved(); }}
                className="relative w-11 h-6 rounded-full transition-colors cursor-pointer"
                style={{
                  background: settings.ttsEnabled ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                }}
                title="Text-to-Speech"
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform bg-white"
                  style={{
                    transform: settings.ttsEnabled ? 'translateX(20px)' : 'translateX(0)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </SettingRow>
            <SettingRow label="Jarvis-style voice" description="Uses the closest installed Windows/WebView voice, not the movie voice">
              <div className="flex flex-wrap gap-2 justify-end">
                <select
                  value={settings.ttsVoiceName}
                  onChange={(e) => { updateSettings({ ttsVoiceName: e.target.value }); showSaved(); }}
                  className="text-sm px-3 py-1.5 rounded-lg outline-none max-w-56"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <option value="">System default</option>
                  {ttsVoices.map((voice) => (
                    <option key={voice.name} value={voice.name}>
                      {voice.name}{voice.culture ? ` (${voice.culture})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={chooseJarvisVoice}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                >
                  Jarvis preset
                </button>
                <button
                  onClick={testVoice}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                >
                  Test voice
                </button>
              </div>
            </SettingRow>
            <SettingRow label="Voice speed" description={`${settings.ttsRate}`}>
              <input
                type="range"
                min="-5"
                max="3"
                step="1"
                value={settings.ttsRate}
                onChange={(e) => { updateSettings({ ttsRate: parseInt(e.target.value, 10) }); showSaved(); }}
                className="w-32 cursor-pointer accent-[var(--color-accent)]"
              />
            </SettingRow>
            <SettingRow label="Voice volume" description={`${settings.ttsVolume}%`}>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={settings.ttsVolume}
                onChange={(e) => { updateSettings({ ttsVolume: parseInt(e.target.value, 10) }); showSaved(); }}
                className="w-32 cursor-pointer accent-[var(--color-accent)]"
              />
            </SettingRow>
            <SettingRow label="Auto-send voice" description="Send recognized speech directly to Jarvis after recording stops">
              <button
                onClick={() => { updateSettings({ voiceAutoSend: !settings.voiceAutoSend }); showSaved(); }}
                className="relative w-11 h-6 rounded-full transition-colors cursor-pointer"
                style={{
                  background: settings.voiceAutoSend ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                }}
                title="Auto-send recognized voice"
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform bg-white"
                  style={{
                    transform: settings.voiceAutoSend ? 'translateX(20px)' : 'translateX(0)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </SettingRow>
            <SettingRow label="Voice status" description="Browser fallback works without Whisper installation">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    background: speechBackendAvailable === true || browserSpeechAvailable ? 'var(--color-success)'
                      : speechBackendAvailable === false ? 'var(--color-text-tertiary)'
                      : 'var(--color-text-tertiary)',
                  }}
                />
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  {speechBackendAvailable === null ? 'Checking...'
                    : speechBackendAvailable ? 'Backend available'
                    : browserSpeechAvailable ? 'Browser voice available'
                    : 'Not available'}
                </span>
              </div>
            </SettingRow>
            <SettingRow label="Voice shortcut" description="Start or stop voice input globally from Windows">
              <kbd
                className="font-mono text-xs px-2 py-1 rounded"
                style={{
                  background: 'var(--color-bg-secondary)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                Ctrl + Alt + J
              </kbd>
            </SettingRow>
            {!speechBackendAvailable && !browserSpeechAvailable && speechBackendAvailable !== null && (
              <div className="text-xs mt-2 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                Set up a speech backend to use voice input.
                See the <a href="https://open-jarvis.github.io/OpenJarvis/user-guide/tools/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>documentation</a> for details.
              </div>
            )}
            {settings.ttsEnabled && (
              <div className="flex items-center gap-1 text-xs mt-2 px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                <Volume2 size={12} /> Voice output uses the installed Windows/WebView voices.
              </div>
            )}
          </Section>

          {/* JARVIS Voice Loop (Kokoro) */}
          <Section title="JARVIS Voice (Voice Loop)">
            <JarvisVoiceSection />
          </Section>

          {/* Data */}
          <Section title="Data">
            <SettingRow label="Diagnostics" description="Open local project files and logs for troubleshooting">
              <div className="flex flex-wrap gap-2 justify-end">
                <LocalOpenButton target="repo">Repo</LocalOpenButton>
                <LocalOpenButton target="config">Config</LocalOpenButton>
                <LocalOpenButton target="backend_log">Backend log</LocalOpenButton>
                <LocalOpenButton target="backend_error_log">Error log</LocalOpenButton>
                <LocalOpenButton target="watchdog_log">Watchdog</LocalOpenButton>
                <LocalOpenButton target="startup">Autostart</LocalOpenButton>
              </div>
            </SettingRow>
            <SettingRow label="Jarvis Brain" description="Open the Obsidian memory files used by OpenJarvis">
              <div className="flex flex-wrap gap-2 justify-end">
                <MemoryOpenButton target="vault">Vault</MemoryOpenButton>
                <MemoryOpenButton target="inbox">Inbox</MemoryOpenButton>
                <MemoryOpenButton target="long_term">Long-Term</MemoryOpenButton>
                <MemoryOpenButton target="profile">Profile</MemoryOpenButton>
              </div>
            </SettingRow>
            <SettingRow
              label="Brain sync"
              description={
                memorySyncError ||
                (memoryStatus
                  ? memoryStatus.needs_sync
                    ? 'Markdown changed after the memory DB'
                    : `DB indexed: ${formatMemoryTime(memoryStatus.db_modified)}`
                  : 'Desktop memory status unavailable')
              }
            >
              <button
                onClick={handleMemorySync}
                disabled={memorySyncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                style={{
                  background: memoryStatus?.needs_sync ? 'var(--color-accent)' : 'var(--color-bg-secondary)',
                  color: memoryStatus?.needs_sync ? 'white' : 'var(--color-text-secondary)',
                  border: memoryStatus?.needs_sync ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
                }}
              >
                <RefreshCw size={12} className={memorySyncing ? 'animate-spin' : ''} />
                {memorySyncing ? 'Syncing...' : memoryStatus?.needs_sync ? 'Sync now' : 'Re-sync'}
              </button>
            </SettingRow>
            <SettingRow label="Brain search" description={memorySearchError || 'Search the indexed Obsidian memory DB'}>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={memoryQuery}
                  onChange={(e) => setMemoryQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleMemorySearch();
                  }}
                  placeholder="Search memory..."
                  className="text-sm px-3 py-1.5 rounded-lg outline-none w-48"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                  }}
                />
                <button
                  onClick={handleMemorySearch}
                  disabled={memorySearching || !memoryQuery.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text-secondary)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <Search size={12} /> {memorySearching ? 'Searching...' : 'Search'}
                </button>
              </div>
            </SettingRow>
            {memorySearchResults.length > 0 && (
              <div className="grid gap-2 px-1 -mt-1 mb-1">
                {memorySearchResults.map((result, index) => (
                  <div
                    key={`${result.source || 'memory'}-${index}`}
                    className="rounded-lg px-3 py-2 text-xs"
                    style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle)' }}
                  >
                    <div className="mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                      {result.source || 'Memory'} · score {Number(result.score || 0).toFixed(2)}
                    </div>
                    <div className="line-clamp-4 whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                      {result.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {memoryStatus && (
              <div className="text-[11px] px-1 -mt-1 mb-1 leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
                Inbox: {formatMemoryTime(memoryStatus.inbox_modified)} · Long-Term: {formatMemoryTime(memoryStatus.long_term_modified)}
              </div>
            )}
            <SettingRow label="Conversations" description={`${conversations.length} stored locally`}>
              <div className="flex gap-2">
                <button
                  onClick={handleExport}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--color-bg-secondary)')}
                >
                  <Download size={12} /> Export
                </button>
                <button
                  onClick={handleImport}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--color-bg-secondary)')}
                >
                  <Upload size={12} /> Import
                </button>
              </div>
            </SettingRow>
            <SettingRow label="Clear all data" description="Permanently delete all conversations">
              <button
                onClick={handleClear}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                style={{
                  color: confirmClear ? 'white' : 'var(--color-error)',
                  background: confirmClear ? 'var(--color-error)' : 'transparent',
                  border: '1px solid var(--color-error)',
                }}
                onMouseEnter={(e) => { if (!confirmClear) e.currentTarget.style.background = 'rgba(220,38,38,0.1)'; }}
                onMouseLeave={(e) => { if (!confirmClear) e.currentTarget.style.background = 'transparent'; }}
              >
                <Trash2 size={12} /> {confirmClear ? 'Click again to confirm' : 'Clear'}
              </button>
            </SettingRow>
          </Section>

          {/* About */}
          <Section title="About">
            <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              <p className="mb-2">
                <span className="font-semibold" style={{ color: 'var(--color-text)' }}>OpenJarvis</span> — Programming abstractions for on-device AI.
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                Part of Intelligence Per Watt, a research initiative at Stanford SAIL.
              </p>
              <div className="flex gap-3 mt-3 text-xs">
                <a
                  href="https://scalingintelligence.stanford.edu/blogs/openjarvis/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-accent)' }}
                >
                  Project site
                </a>
                <a
                  href="https://open-jarvis.github.io/OpenJarvis/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-accent)' }}
                >
                  Documentation
                </a>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ====== JARVIS Voice Loop — Voice Selector + Tester ======

const VOICE_LOOP_BASE = 'http://127.0.0.1:8770';

function JarvisVoiceSection() {
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>('');
  const [testing, setTesting] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [testText, setTestText] = useState('Hello Sir, this is a voice test.');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${VOICE_LOOP_BASE}/voices`);
      const d = await r.json();
      setVoices(d.voices ?? {});
      setActive(d.active ?? '');
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyVoice = async (voiceId: string) => {
    try {
      await fetch(`${VOICE_LOOP_BASE}/set_voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: voiceId }),
      });
      setActive(voiceId);
    } catch { /* ignore */ }
  };

  const testVoice = async (voiceId: string) => {
    setTesting(voiceId);
    try {
      await fetch(`${VOICE_LOOP_BASE}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: testText, voice: voiceId }),
      });
      // Poll until pipeline_busy turns false
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 500));
        try {
          const r = await fetch(`${VOICE_LOOP_BASE}/health`);
          const h = await r.json();
          if (!h.pipeline_busy) break;
        } catch { /* ignore */ }
      }
    } finally {
      setTesting(null);
    }
  };

  if (reachable === false) {
    return (
      <div className="text-xs p-3 rounded-lg" style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-tertiary)',
      }}>
        Voice loop is not reachable (expected at <code>{VOICE_LOOP_BASE}</code>). Start it with{' '}
        <code>start-openjarvis-voice-loop.ps1</code>.
      </div>
    );
  }

  const aliasEntries = Object.entries(voices);

  return (
    <div className="space-y-3">
      <SettingRow
        label="Test sentence"
        description="What each voice should say when you press Test"
      >
        <input
          type="text"
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          className="px-2 py-1.5 rounded-md text-sm outline-none w-full max-w-md"
          style={{
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
        />
      </SettingRow>

      <SettingRow
        label="Active voice"
        description={`Currently: ${active || 'unknown'}. Click "Use" to make it permanent for this session.`}
      >
        <div />
      </SettingRow>

      <div className="rounded-lg p-2 space-y-1" style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        maxHeight: '320px',
        overflowY: 'auto',
      }}>
        {aliasEntries.length === 0 ? (
          <div className="text-xs p-2" style={{ color: 'var(--color-text-tertiary)' }}>
            Loading voices…
          </div>
        ) : (
          aliasEntries.map(([alias, voiceId]) => {
            const isActive = voiceId === active;
            const isTesting = testing === voiceId;
            const flavor =
              voiceId.startsWith('bm_') ? 'British male' :
              voiceId.startsWith('bf_') ? 'British female' :
              voiceId.startsWith('am_') ? 'American male' :
              voiceId.startsWith('af_') ? 'American female' : '';
            return (
              <div
                key={voiceId}
                className="flex items-center gap-3 px-2 py-1.5 rounded-md"
                style={{
                  background: isActive ? 'var(--color-accent-subtle)' : 'transparent',
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm capitalize" style={{ color: 'var(--color-text)' }}>
                    {alias}
                    {isActive && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--color-accent)' }}>
                        active
                      </span>
                    )}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {voiceId} · {flavor}
                  </div>
                </div>
                <button
                  onClick={() => testVoice(voiceId)}
                  disabled={isTesting || testing !== null}
                  className="px-2.5 py-1 rounded-md text-xs transition-opacity disabled:opacity-40 cursor-pointer"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  {isTesting ? '...' : 'Test'}
                </button>
                <button
                  onClick={() => applyVoice(voiceId)}
                  disabled={isActive}
                  className="px-2.5 py-1 rounded-md text-xs transition-opacity disabled:opacity-40 cursor-pointer"
                  style={{
                    background: isActive ? 'var(--color-bg-secondary)' : 'var(--color-accent)',
                    color: isActive ? 'var(--color-text-tertiary)' : 'white',
                  }}
                >
                  {isActive ? '✓ in use' : 'Use'}
                </button>
              </div>
            );
          })
        )}
      </div>

      <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        For permanent default voice, set <code>OJ_TTS_VOICE</code> in <code>start-openjarvis-voice-loop.ps1</code>.
      </p>
    </div>
  );
}
