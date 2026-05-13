import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function publishSpeechState(state: SpeechState): void {
  window.dispatchEvent(new CustomEvent('openjarvis-speech-state', { detail: { state } }));
}

function publishSpeechLevel(level: number): void {
  window.dispatchEvent(new CustomEvent('openjarvis-speech-level', { detail: { level } }));
}

function createBrowserRecognition(): BrowserSpeechRecognition | null {
  const win = window as any;
  const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition() as BrowserSpeechRecognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'de-DE';
  return recognition;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const browserTranscriptRef = useRef('');
  const browserResolveRef = useRef<((text: string) => void) | null>(null);
  const browserRejectRef = useRef<((error: Error) => void) | null>(null);

  // Check if speech backend is available on mount
  useEffect(() => {
    const browserAvailable = createBrowserRecognition() !== null;
    fetchSpeechHealth()
      .then((health) => {
        setBackendAvailable(health.available);
        setAvailable(health.available || browserAvailable);
      })
      .catch(() => {
        setBackendAvailable(false);
        setAvailable(browserAvailable);
      });
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);

    if (!backendAvailable) {
      const recognition = createBrowserRecognition();
      if (!recognition) {
        setError('Speech recognition not supported in this browser');
        return;
      }

      browserTranscriptRef.current = '';
      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0]?.transcript || '';
        }
        browserTranscriptRef.current = transcript.trim();
      };
      recognition.onerror = (event: any) => {
        const msg = event?.error ? `Speech recognition failed: ${event.error}` : 'Speech recognition failed';
        setError(msg);
        setState('idle');
        browserRejectRef.current?.(new Error(msg));
        browserResolveRef.current = null;
        browserRejectRef.current = null;
      };
      recognition.onend = () => {
        const text = browserTranscriptRef.current.trim();
        setState('idle');
        publishSpeechState('idle');
        publishSpeechLevel(0);
        browserResolveRef.current?.(text);
        browserResolveRef.current = null;
        browserRejectRef.current = null;
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
      setState('recording');
      publishSpeechState('recording');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.25;
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
      }

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState('recording');
      publishSpeechState('recording');
    } catch (err) {
      setError('Microphone access denied');
      setState('idle');
      publishSpeechState('idle');
      publishSpeechLevel(0);
    }
  }, [backendAvailable]);

  const stopRecording = useCallback(async (): Promise<string> => {
    if (recognitionRef.current) {
      setState('transcribing');
      publishSpeechState('transcribing');
      return new Promise((resolve, reject) => {
        browserResolveRef.current = resolve;
        browserRejectRef.current = reject;
        recognitionRef.current?.stop();
      });
    }

    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        setState('transcribing');
        publishSpeechState('transcribing');

        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        analyserRef.current = null;
        audioContextRef.current?.close().catch(() => {});
        audioContextRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          setState('idle');
          publishSpeechState('idle');
          publishSpeechLevel(0);
          resolve(result.text);
        } catch (err) {
          setState('idle');
          publishSpeechState('idle');
          publishSpeechLevel(0);
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      recorder.stop();
    });
  }, []);

  const getInputLevel = useCallback((): number => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = value - 128;
      sum += centered * centered;
    }
    const level = Math.sqrt(sum / data.length) / 128;
    publishSpeechLevel(level);
    return level;
  }, []);

  useEffect(() => {
    if (state !== 'recording') {
      publishSpeechLevel(0);
      return;
    }

    const interval = window.setInterval(() => {
      if (analyserRef.current) {
        getInputLevel();
      } else {
        publishSpeechLevel(0.08);
      }
    }, 80);

    return () => {
      window.clearInterval(interval);
    };
  }, [state, getInputLevel]);

  const stopAfterSilence = useCallback(async (options: {
    maxMs: number;
    minListenMs?: number;
    silenceMs?: number;
    levelThreshold?: number;
  }): Promise<string> => {
    if (recognitionRef.current) {
      return new Promise((resolve) => {
        window.setTimeout(() => {
          void stopRecording().then(resolve).catch(() => resolve(''));
        }, options.maxMs);
      });
    }

    const startedAt = Date.now();
    const minListenMs = options.minListenMs ?? 1000;
    const silenceMs = options.silenceMs ?? 1400;
    const threshold = options.levelThreshold ?? 0.018;
    let heardSpeech = false;
    let silenceStartedAt: number | null = null;

    return new Promise((resolve) => {
      const finish = () => {
        window.clearInterval(interval);
        void stopRecording().then(resolve).catch(() => resolve(''));
      };

      const interval = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const level = getInputLevel();
        const speaking = level >= threshold;

        if (speaking) {
          heardSpeech = true;
          silenceStartedAt = null;
        } else if (heardSpeech && elapsed >= minListenMs) {
          silenceStartedAt ??= Date.now();
        }

        if (heardSpeech && silenceStartedAt && Date.now() - silenceStartedAt >= silenceMs) {
          finish();
          return;
        }

        if (elapsed >= options.maxMs) {
          finish();
        }
      }, 120);
    });
  }, [getInputLevel, stopRecording]);

  return {
    state,
    error,
    available,
    startRecording,
    stopRecording,
    stopAfterSilence,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
