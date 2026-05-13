import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Paperclip } from 'lucide-react';
import { useAppStore, generateId } from '../../lib/store';
import { streamChat } from '../../lib/sse';
import {
  fetchNativeWakeEvents,
  fetchNativeWakeHealth,
  fetchSavings,
  getBase,
  isTauri,
  playWakeAck,
  rememberText,
  speakText,
  stopTts,
} from '../../lib/api';
import { MicButton } from './MicButton';
import { useSpeech } from '../../hooks/useSpeech';
import type { ChatMessage, ToolCallInfo, TokenUsage, MessageTelemetry } from '../../types';

export function InputArea() {
  const [input, setInput] = useState('');
  const [nativeWakeAvailable, setNativeWakeAvailable] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeRecognitionRef = useRef<any | null>(null);
  const wakeCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeTriggeredRef = useRef(false);
  const followUpActiveRef = useRef(false);
  const voiceCycleActiveRef = useRef(false);
  const wakeCooldownUntilRef = useRef(0);
  const nativeWakeLastEventIdRef = useRef(0);

  const activeId = useAppStore((s) => s.activeId);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const streamState = useAppStore((s) => s.streamState);
  const messages = useAppStore((s) => s.messages);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const wakeWordEnabled = useAppStore((s) => s.settings.wakeWordEnabled);
  const wakeWord = useAppStore((s) => s.settings.wakeWord);
  const wakeCaptureSeconds = useAppStore((s) => s.settings.wakeCaptureSeconds);
  const ttsEnabled = useAppStore((s) => s.settings.ttsEnabled);
  const voiceAutoSend = useAppStore((s) => s.settings.voiceAutoSend);
  const ttsVoiceName = useAppStore((s) => s.settings.ttsVoiceName);
  const ttsRate = useAppStore((s) => s.settings.ttsRate);
  const ttsVolume = useAppStore((s) => s.settings.ttsVolume);
  const maxTokens = useAppStore((s) => s.settings.maxTokens);
  const temperature = useAppStore((s) => s.settings.temperature);
  const createConversation = useAppStore((s) => s.createConversation);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateLastAssistant = useAppStore((s) => s.updateLastAssistant);
  const setStreamState = useAppStore((s) => s.setStreamState);
  const resetStream = useAppStore((s) => s.resetStream);
  const modelLoading = useAppStore((s) => s.modelLoading);

  const { state: speechState, available: speechAvailable, startRecording, stopRecording, stopAfterSilence } = useSpeech();

  const spokenCue = (kind: 'working' | 'done' | 'error' | 'listening'): string => {
    const pools: Record<typeof kind, string[]> = {
      working: ['On it, Sir.', 'Checking that now, Sir.', 'One moment, Sir.'],
      done: ['Done, Sir.', 'Handled, Sir.', 'All set, Sir.'],
      error: ['That failed, Sir.', 'Something went wrong, Sir.', 'I hit an issue, Sir.'],
      listening: ['Listening, Sir.', 'Go ahead, Sir.', 'I am listening, Sir.'],
    };
    const items = pools[kind];
    return items[Math.floor(Math.random() * items.length)];
  };

  const inferSpokenIntent = (text: string): 'done' | 'error' | 'working' | 'neutral' => {
    if (/error|failed|fehler|problem|nicht geklappt|geht nicht|unable|cannot/i.test(text)) return 'error';
    if (/erledigt|fertig|done|fixed|gefixt|eingebaut|updated|neugestartet|funktioniert|works|success/i.test(text)) return 'done';
    if (/checking|pruefe|schaue|analysiere|baue|starte|installiere|lade/i.test(text)) return 'working';
    return 'neutral';
  };

  const summarizeForVoice = (text: string): string => {
    const intent = inferSpokenIntent(text);
    if (intent === 'error') return `${spokenCue('error')} I will check the logs and adjust.`;
    if (intent === 'done') {
      if (/voice|stimme|tts|kokoro|piper/i.test(text)) return `${spokenCue('done')} The voice system is updated.`;
      if (/memory|brain|obsidian|gehirn/i.test(text)) return `${spokenCue('done')} Memory is updated and ready.`;
      if (/desktop|backend|watchdog|server/i.test(text)) return `${spokenCue('done')} The local system is back online.`;
      return `${spokenCue('done')} The change is active now.`;
    }
    if (intent === 'working') return `${spokenCue('working')} I am handling it now.`;
    return '';
  };

  const toEnglishSpokenLine = (sentence: string): string => {
    let line = sentence
      .replace(/\bSir\b/gi, 'Sir')
      .replace(/\bErledigt\b/gi, 'Done')
      .replace(/\bFertig\b/gi, 'Done')
      .replace(/\bPerfekt\b/gi, 'Perfect')
      .replace(/\bJa\b/gi, 'Yes')
      .replace(/\bNein\b/gi, 'No')
      .replace(/\bOkay\b/gi, 'Okay')
      .replace(/\bIch habe\b/gi, 'I have')
      .replace(/\bIch bin\b/gi, 'I am')
      .replace(/\bIch werde\b/gi, 'I will')
      .replace(/\bIch kann\b/gi, 'I can')
      .replace(/\bDas ist\b/gi, 'That is')
      .replace(/\bDas war\b/gi, 'That was')
      .replace(/\bDas funktioniert\b/gi, 'That works')
      .replace(/\bfunktioniert\b/gi, 'works')
      .replace(/\bgefixt\b/gi, 'fixed')
      .replace(/\beingebaut\b/gi, 'added')
      .replace(/\bgestartet\b/gi, 'started')
      .replace(/\bneugestartet\b/gi, 'restarted')
      .replace(/\bgeprueft\b/gi, 'checked')
      .replace(/\bweiter\b/gi, 'next')
      .replace(/\bStimme\b/gi, 'voice')
      .replace(/\bSprache\b/gi, 'language')
      .replace(/\bAntwort\b/gi, 'answer')
      .replace(/\bBackend\b/gi, 'backend')
      .replace(/\bDesktop\b/gi, 'desktop')
      .replace(/\bGehirn\b/gi, 'brain')
      .replace(/\bObsidian\b/gi, 'Obsidian')
      .replace(/\bModell\b/gi, 'model');

    const hasGerman = /[\u00e4\u00f6\u00fc\u00df]|\b(der|die|das|und|ist|ich|du|wir|nicht|noch|jetzt|wurde|wurden|kannst|soll|sollte|bitte|habe|haben|mache|mach|gebaut|eingestellt|geändert|aenderung|änderung|antworten|sprechen|sprache)\b/i.test(line);
    if (hasGerman) {
      if (/erledigt|fertig|eingebaut|gefixt|funktioniert/i.test(sentence)) {
        return 'Done, Sir. The change is active now.';
      }
      if (/backend|desktop|watchdog|gestartet|neugestartet/i.test(sentence)) {
        return 'Systems are back online, Sir.';
      }
      if (/stimme|sprache|tts|kokoro|piper/i.test(sentence)) {
        return 'Voice settings are updated, Sir.';
      }
      if (/obsidian|gehirn|memory|brain/i.test(sentence)) {
        return 'Memory is updated and ready, Sir.';
      }
      return 'Understood, Sir. I have handled it.';
    }

    return line;
  };

  const isMostlyEnglishForSpeech = (text: string): boolean => {
    if (!text.trim()) return false;
    if (/[\u00e4\u00f6\u00fc\u00df]/i.test(text)) return false;
    const germanHits = text.match(/\b(der|die|das|und|ist|ich|du|wir|nicht|noch|jetzt|wurde|wurden|kannst|soll|sollte|bitte|habe|haben|macht|mache|gebaut|geändert|antwort|sprache|stimme|funktioniert)\b/gi);
    return (germanHits?.length || 0) === 0;
  };

  const prepareSpeechText = (text: string): string => {
    const summary = summarizeForVoice(text);
    if (summary) return summary;

    const stripped = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/[#*_>\[\]{}]/g, '')
      .replace(/\s*[:;]\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();

    const sentences = stripped
      .split(/(?<=[.!?])\s+|\n+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const selected: string[] = [];
    for (const sentence of sentences) {
      if (selected.length >= 3) break;
      if (sentence.length < 4) continue;
      if (/^(quelle|sources?|http|repo|backend|model|engine)\b/i.test(sentence)) continue;
      selected.push(sentence);
    }

    const spoken = sentences
      .slice(0, 0)
      .concat(selected)
      .map((sentence) => {
        const normalized = sentence
          .replace(/\bOK\b/g, 'okay')
          .replace(/\bokay,\s*/gi, 'Okay. ')
          .replace(/\bDone\b/g, 'Done')
          .replace(/\bAPI\b/g, 'A P I')
          .replace(/\bTTS\b/g, 'T T S')
          .replace(/\bGPU\b/g, 'G P U')
          .replace(/\bCPU\b/g, 'C P U')
          .replace(/\bURL\b/g, 'U R L')
          .replace(/\bSTT\b/g, 'S T T')
          .replace(/\bEXE\b/g, 'E X E')
          .replace(/\bqwen3\.5:4b\b/gi, 'Qwen three point five, four B');
        const english = toEnglishSpokenLine(normalized);
        return english.length > 150 ? `${english.slice(0, 147).trim()}...` : english;
      })
      .join('\n');
    return isMostlyEnglishForSpeech(spoken) ? spoken : 'Understood, Sir. I have handled it.';
  };

  const speakAssistantResponse = useCallback(async (text: string) => {
    if (!ttsEnabled) return;
    const clean = prepareSpeechText(text).slice(0, 520);
    if (!clean || clean.startsWith('Error:')) return;

    if (ttsCooldownRef.current) {
      clearTimeout(ttsCooldownRef.current);
      ttsCooldownRef.current = null;
    }
    if (await speakText(clean, { voiceName: ttsVoiceName, rate: ttsRate, volume: ttsVolume })) return;
    if (!('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    const lang = 'en-GB';
    utterance.lang = lang;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice =
      voices.find((voice) => voice.name === ttsVoiceName) ||
      voices.find((voice) => voice.lang?.toLowerCase().startsWith('en-gb')) ||
      voices.find((voice) => voice.lang?.toLowerCase().startsWith('en')) ||
      voices.find((voice) => voice.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())) ||
      voices[0] ||
      null;
    utterance.rate = Math.max(0.5, Math.min(1.5, 1 + ttsRate / 10));
    utterance.pitch = 1;
    utterance.volume = Math.max(0, Math.min(1, ttsVolume / 100));
    window.speechSynthesis.speak(utterance);
  }, [ttsEnabled, ttsVoiceName, ttsRate, ttsVolume]);

  const speakBriefCue = useCallback((text: string, volume = 75) => {
    if (!ttsEnabled) return;
    if (ttsCooldownRef.current) clearTimeout(ttsCooldownRef.current);
    ttsCooldownRef.current = setTimeout(() => {
      void speakText(text, {
        voiceName: ttsVoiceName,
        rate: ttsRate,
        volume: Math.min(ttsVolume, volume),
      });
      ttsCooldownRef.current = null;
    }, 180);
  }, [ttsEnabled, ttsVoiceName, ttsRate, ttsVolume]);

  const isSyntheticErrorMessage = (message: ChatMessage): boolean => {
    if (message.role !== 'assistant') return false;
    const text = message.content.trim();
    return (
      text.startsWith('Error: HTTP ') ||
      text.startsWith('Error: Connection failed') ||
      text.startsWith('Error: Chat request failed') ||
      text.startsWith('No response was generated')
    );
  };

  const buildApiMessages = (items: ChatMessage[]) => {
    // Keep local prompts small and never feed previous transport errors back
    // into the model as if they were useful conversation context.
    return items
      .filter((m) => !isSyntheticErrorMessage(m))
      .slice(-8)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));
  };

  const requestMaxTokens =
    selectedModel.startsWith('qwen3:0.6b') || selectedModel.startsWith('qwen3.5:0.8b')
      ? Math.min(maxTokens || 1024, 1024)
      : maxTokens;

  // Abort in-flight stream when the user switches models mid-generation.
  // This prevents errors from trying to continue a stream with a stale model.
  const prevModelRef = useRef(selectedModel);
  useEffect(() => {
    if (prevModelRef.current !== selectedModel && streamState.isStreaming) {
      abortRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      abortRef.current = null;
    }
    prevModelRef.current = selectedModel;
  }, [selectedModel, streamState.isStreaming, resetStream]);

  const micDisabled = !speechEnabled || !speechAvailable || streamState.isStreaming;
  const micReason: 'not-enabled' | 'no-backend' | 'streaming' | undefined =
    !speechEnabled ? 'not-enabled'
    : !speechAvailable ? 'no-backend'
    : streamState.isStreaming ? 'streaming'
    : undefined;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    void stopTts();
    if (wakeCaptureTimerRef.current) {
      clearTimeout(wakeCaptureTimerRef.current);
      wakeCaptureTimerRef.current = null;
    }
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
    voiceCycleActiveRef.current = false;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    resetStream();
  }, [resetStream]);

  const shouldRememberExchange = (userText: string, assistantText: string): boolean => {
    const text = `${userText}\n${assistantText}`.toLowerCase();
    if (assistantText.startsWith('Error:') || assistantText.includes('No response was generated')) return false;
    return (
      /\b(merk|merken|remember|speicher|save|notier|notiere|wichtig|important)\b/i.test(text) ||
      /\b(ich bin|ich habe|ich will|mein ziel|mein computer|mein rechner|meine|mein)\b/i.test(text)
    );
  };

  const isWakeAckEcho = (text: string): boolean => {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(yes|yeah|yep)?\s*sir$/.test(normalized) || normalized === 'yes sir' || normalized === 'yesser';
  };

  const rememberExchange = async (userText: string, assistantText: string) => {
    if (!shouldRememberExchange(userText, assistantText)) return;
    const note = [
      'Automatisch gespeicherte OpenJarvis-Konversation:',
      `User: ${userText.trim()}`,
      `Jarvis: ${assistantText.trim().slice(0, 900)}`,
    ].join('\n');
    await rememberText(note).catch(() => {});
  };

  const sendMessage = useCallback(async (overrideContent?: string) => {
    const content = (overrideContent ?? input).trim();
    if (!content || streamState.isStreaming) return;

    if (!overrideContent) setInput('');

    let convId = activeId;
    if (!convId) {
      convId = createConversation(selectedModel);
    }

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    addMessage(convId, userMsg);

    // Build API messages before adding assistant placeholder
    const currentMessages = useAppStore.getState().messages;
    const apiMessages = buildApiMessages(currentMessages);

    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(convId, assistantMsg);

    // Start streaming
    const startTime = Date.now();
    const timer = setInterval(() => {
      setStreamState({ elapsedMs: Date.now() - startTime });
    }, 100);
    timerRef.current = timer;

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulatedContent = '';
    let usage: TokenUsage | undefined;
    let complexity: { score: number; tier: string; suggested_max_tokens: number } | undefined;
    const toolCalls: ToolCallInfo[] = [];
    let lastFlush = 0;
    let ttftMs: number | undefined;

    setStreamState({
      isStreaming: true,
      phase: 'Generating...',
      elapsedMs: 0,
      activeToolCalls: [],
      content: '',
    });
    useAppStore.getState().addLogEntry({
      timestamp: Date.now(),
      level: 'info',
      category: 'chat',
      message: `Request: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}" -> ${selectedModel}`,
    });

    try {
      for await (const sseEvent of streamChat(
        { model: selectedModel, messages: apiMessages, stream: true, temperature, max_tokens: requestMaxTokens },
        controller.signal,
      )) {
        const eventName = sseEvent.event;

        if (eventName === 'agent_turn_start') {
          setStreamState({ phase: 'Agent thinking...' });
        } else if (eventName === 'inference_start') {
          setStreamState({ phase: 'Generating...' });
          useAppStore.getState().addLogEntry({
            timestamp: Date.now(), level: 'info', category: 'chat',
            message: `Generating with ${selectedModel}...`,
          });
        } else if (eventName === 'tool_call_start') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc: ToolCallInfo = {
              id: generateId(),
              tool: data.tool,
              arguments: data.arguments || '',
              status: 'running',
            };
            toolCalls.push(tc);
            setStreamState({
              phase: `Calling ${data.tool}...`,
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
            useAppStore.getState().addLogEntry({
              timestamp: Date.now(), level: 'info', category: 'tool',
              message: `Calling ${data.tool}(${data.arguments || ''})`,
            });
          } catch {}
        } else if (eventName === 'tool_call_end') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc = toolCalls.find(
              (t) => t.tool === data.tool && t.status === 'running',
            );
            if (tc) {
              tc.status = data.success ? 'success' : 'error';
              tc.latency = data.latency;
              tc.result = data.result;
            }
            setStreamState({
              phase: 'Generating...',
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
          } catch {}
        } else {
          try {
            const data = JSON.parse(sseEvent.data);
            const delta = data.choices?.[0]?.delta;
            if (data.usage) usage = data.usage;
            if (data.complexity) complexity = data.complexity;
            if (delta?.content) {
              if (!ttftMs) ttftMs = Date.now() - startTime;
              accumulatedContent += delta.content;
              setStreamState({ content: accumulatedContent, phase: '' });

              const now = Date.now();
              if (now - lastFlush >= 80) {
                updateLastAssistant(
                  convId,
                  accumulatedContent,
                  toolCalls.length > 0 ? [...toolCalls] : undefined,
                );
                lastFlush = now;
              }
            }
            if (data.choices?.[0]?.finish_reason === 'stop') break;
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // User cancelled or model switch - keep whatever was accumulated
        if (!accumulatedContent) accumulatedContent = '(Generation stopped)';
      } else {
        const errMsg = err?.message || String(err);
        accumulatedContent =
          accumulatedContent || `Error: ${errMsg}`;
        useAppStore.getState().addLogEntry({
          timestamp: Date.now(), level: 'error', category: 'chat',
          message: `Stream error: ${errMsg}`,
        });
      }
    } finally {
      if (!accumulatedContent) {
        accumulatedContent = 'No response was generated. Please try again.';
      }
      const totalMs = Date.now() - startTime;
      const _CLOUD_PREFIXES = ['gpt-', 'o1-', 'o3-', 'o4-', 'claude-', 'gemini-', 'openrouter/', 'MiniMax-', 'chatgpt-'];
      const engineLabel = _CLOUD_PREFIXES.some(p => selectedModel.startsWith(p)) ? 'cloud' : 'ollama';
      const telemetry: MessageTelemetry = {
        engine: engineLabel,
        model_id: selectedModel,
        total_ms: totalMs,
        ttft_ms: ttftMs,
        tokens_per_sec: usage?.completion_tokens
          ? usage.completion_tokens / (totalMs / 1000)
          : undefined,
        complexity_score: complexity?.score,
        complexity_tier: complexity?.tier,
        suggested_max_tokens: complexity?.suggested_max_tokens,
      };
      // Check if the response has digest audio available
      let audioMeta: { url: string } | undefined;
      try {
        const digestRes = await fetch(`${getBase()}/api/digest`);
        if (digestRes.ok) {
          const digest = await digestRes.json();
          if (digest.audio_available) {
            audioMeta = { url: `${getBase()}/api/digest/audio` };
          }
        }
      } catch {
        // Not a digest response or server unavailable - skip
      }

      updateLastAssistant(
        convId,
        accumulatedContent,
        toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        telemetry,
        audioMeta,
      );
      speakAssistantResponse(accumulatedContent);
      void rememberExchange(content, accumulatedContent);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'info', category: 'chat',
        message: `Response: ${accumulatedContent.length} chars`,
      });
      abortRef.current = null;

      if (
        speechEnabled &&
        speechAvailable &&
        voiceAutoSend &&
        !accumulatedContent.startsWith('Error:') &&
        !followUpActiveRef.current
      ) {
        const spoken = prepareSpeechText(accumulatedContent);
        const estimatedSpeechMs = Math.min(12000, Math.max(3000, spoken.length * 75));
        if (followUpTimerRef.current) clearTimeout(followUpTimerRef.current);
        followUpTimerRef.current = setTimeout(async () => {
          followUpTimerRef.current = null;
          if (useAppStore.getState().streamState.isStreaming || speechState !== 'idle') return;
          followUpActiveRef.current = true;
          voiceCycleActiveRef.current = true;
          try {
            await startRecording();
            const followUpText = (await stopAfterSilence({
              maxMs: 8000,
              minListenMs: 1200,
              silenceMs: 1200,
              levelThreshold: 0.018,
            })).trim();
            if (followUpText) await sendMessage(followUpText);
          } catch {
          } finally {
            followUpActiveRef.current = false;
            voiceCycleActiveRef.current = false;
            wakeCooldownUntilRef.current = Date.now() + 1500;
          }
        }, estimatedSpeechMs + 500);
      }

      fetchSavings()
        .then((data) => useAppStore.getState().setSavings(data))
        .catch(() => {});
    }
  }, [
    input,
    activeId,
    selectedModel,
    maxTokens,
    requestMaxTokens,
    temperature,
    streamState.isStreaming,
    createConversation,
    addMessage,
    updateLastAssistant,
    setStreamState,
    resetStream,
    speakAssistantResponse,
    speakBriefCue,
    speechEnabled,
    speechAvailable,
    voiceAutoSend,
    speechState,
    startRecording,
    stopAfterSilence,
  ]);

  const handleMicClick = useCallback(async () => {
    voiceCycleActiveRef.current = false;
    if (wakeCaptureTimerRef.current) {
      clearTimeout(wakeCaptureTimerRef.current);
      wakeCaptureTimerRef.current = null;
    }
    if (speechState === 'recording') {
      try {
        const text = (await stopRecording()).trim();
        if (!text) return;
        if (voiceAutoSend) {
          setInput('');
          speakBriefCue(spokenCue('working'), 80);
          await sendMessage(text);
        } else {
          setInput((prev) => (prev ? prev + ' ' + text : text));
        }
      } catch {
        // Error is captured in useSpeech
      }
    } else {
      void stopTts();
      await startRecording();
    }
  }, [speechState, startRecording, stopRecording, voiceAutoSend, sendMessage, speakBriefCue]);

  const startWakeCapture = useCallback(async () => {
    const now = Date.now();
    if (
      voiceCycleActiveRef.current ||
      followUpActiveRef.current ||
      now < wakeCooldownUntilRef.current ||
      speechState !== 'idle' ||
      streamState.isStreaming ||
      !speechEnabled ||
      !speechAvailable
    ) {
      return;
    }

    voiceCycleActiveRef.current = true;
    wakeCooldownUntilRef.current = now + 4500;
    wakeTriggeredRef.current = true;
    wakeRecognitionRef.current?.stop?.();
    wakeRecognitionRef.current = null;
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
    void stopTts();
    void playWakeAck().then((played) => {
      if (!played) speakBriefCue('Yes, Sir.', 90);
    });

    try {
      await new Promise((resolve) => window.setTimeout(resolve, 2100));
      await startRecording();
      const seconds = Math.max(5, Math.min(30, wakeCaptureSeconds || 20));
      const text = (await stopAfterSilence({
        maxMs: seconds * 1000,
        minListenMs: 900,
        silenceMs: 1400,
        levelThreshold: 0.022,
      })).trim();
      if (isWakeAckEcho(text)) return;
      if (!text) {
        return;
      }
      if (voiceAutoSend) {
        await sendMessage(text);
      } else {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
    } catch {
    } finally {
      voiceCycleActiveRef.current = false;
      wakeCooldownUntilRef.current = Date.now() + 2500;
    }
  }, [
    speechState,
    streamState.isStreaming,
    speechEnabled,
    speechAvailable,
    wakeCaptureSeconds,
    startRecording,
    stopAfterSilence,
    voiceAutoSend,
    sendMessage,
    speakBriefCue,
  ]);

  useEffect(() => {
    if (!speechEnabled || !wakeWordEnabled) {
      setNativeWakeAvailable(false);
      return;
    }

    let disposed = false;

    const pollNativeWake = async () => {
      const health = await fetchNativeWakeHealth();
      const available = !!health?.available && !!health?.listening;
      if (!disposed) setNativeWakeAvailable(available);
      if (!available) return;

      const events = await fetchNativeWakeEvents(nativeWakeLastEventIdRef.current);
      for (const event of events) {
        nativeWakeLastEventIdRef.current = Math.max(nativeWakeLastEventIdRef.current, event.id);
        if (!disposed) void startWakeCapture();
      }
    };

    void pollNativeWake();
    const interval = window.setInterval(() => {
      void pollNativeWake();
    }, 700);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [speechEnabled, wakeWordEnabled, startWakeCapture]);

  useEffect(() => {
    if (
      !speechEnabled ||
      !wakeWordEnabled ||
      !wakeWord.trim() ||
      speechState !== 'idle' ||
      streamState.isStreaming
    ) {
      wakeRecognitionRef.current?.stop?.();
      wakeRecognitionRef.current = null;
      return;
    }

    const win = window as any;
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    let disposed = false;
    const expected = wakeWord.trim().toLowerCase();
    const aliases = new Set([expected, 'hey jarvis', 'ok jarvis', 'okay jarvis', 'tschervis', 'jarves']);

    const startListener = () => {
      if (disposed || wakeRecognitionRef.current || speechState !== 'idle' || streamState.isStreaming) return;
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'de-DE';

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          transcript += ` ${event.results[i][0]?.transcript || ''}`;
        }
        const normalized = transcript.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (!normalized) return;
        const matched = Array.from(aliases).some((alias) => normalized.includes(alias));
        if (matched) {
          recognition.onresult = null;
          recognition.stop();
          void startWakeCapture();
        }
      };

      recognition.onerror = () => {
        wakeRecognitionRef.current = null;
      };
      recognition.onend = () => {
        wakeRecognitionRef.current = null;
        if (!disposed && !wakeTriggeredRef.current) {
          window.setTimeout(startListener, 750);
        }
        wakeTriggeredRef.current = false;
      };

      wakeRecognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        wakeRecognitionRef.current = null;
      }
    };

    startListener();

    return () => {
      disposed = true;
      wakeRecognitionRef.current?.stop?.();
      wakeRecognitionRef.current = null;
    };
  }, [speechEnabled, wakeWordEnabled, wakeWord, speechState, streamState.isStreaming, startWakeCapture]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!(event.ctrlKey && event.altKey && event.key.toLowerCase() === 'j')) return;
      event.preventDefault();
      if (micDisabled && speechState !== 'recording') return;
      void handleMicClick();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleMicClick, micDisabled, speechState]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('openjarvis-push-to-talk', () => {
        if (micDisabled && speechState !== 'recording') return;
        void handleMicClick();
      }))
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleMicClick, micDisabled, speechState]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2" style={{ maxWidth: 'var(--chat-max-width)', margin: '0 auto', width: '100%' }}>
      <div
        className="flex items-center gap-2 rounded-2xl px-4 py-3 transition-shadow"
        style={{
          background: 'var(--color-input-bg)',
          border: '1px solid var(--color-input-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message OpenJarvis..."
          rows={1}
          className="flex-1 bg-transparent outline-none resize-none text-sm leading-relaxed"
          style={{ color: 'var(--color-text)', maxHeight: '200px' }}
          disabled={streamState.isStreaming || modelLoading}
        />
        {streamState.isStreaming ? (
          <button
            onClick={stopStreaming}
            className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer"
            style={{ background: 'var(--color-error)', color: 'white' }}
            title="Stop generating"
          >
            <Square size={16} />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <MicButton
              state={speechState}
              onClick={handleMicClick}
              disabled={micDisabled}
              reason={micReason}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || modelLoading}
              className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-default"
              style={{
                background: input.trim() ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                color: input.trim() ? 'white' : 'var(--color-text-tertiary)',
              }}
              title="Send message"
            >
              <Send size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center justify-center mt-2 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <span>
          <kbd className="font-mono">Enter</kbd> to send &middot;{' '}
          <kbd className="font-mono">Shift+Enter</kbd> for new line
        </span>
      </div>
    </div>
  );
}
