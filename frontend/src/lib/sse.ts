import type { SSEEvent } from '../types';
import { getBase, isTauri } from './api';

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: true;
  temperature?: number;
  max_tokens?: number;
}

export async function* streamChat(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const base = getBase();
    const response = await invoke<any>('chat_completion', {
      apiUrl: base,
      body: { ...request, stream: false },
    });

    const choice = response?.choices?.[0];
    const content = choice?.message?.content || '';
    const usage = response?.usage;
    const complexity = response?.complexity;

    if (signal?.aborted) {
      const err = new Error('The operation was aborted.');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    }

    yield {
      data: JSON.stringify({
        id: response?.id || '',
        object: 'chat.completion.chunk',
        created: response?.created,
        model: response?.model || request.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }),
    };

    if (content) {
      yield {
        data: JSON.stringify({
          id: response?.id || '',
          object: 'chat.completion.chunk',
          created: response?.created,
          model: response?.model || request.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }),
      };
    }

    yield {
      data: JSON.stringify({
        id: response?.id || '',
        object: 'chat.completion.chunk',
        created: response?.created,
        model: response?.model || request.model,
        choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }],
        usage,
        complexity,
      }),
    };
    return;
  }

  const base = getBase();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent: string | undefined;

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          yield { event: currentEvent, data };
          currentEvent = undefined;
        } else if (line.trim() === '') {
          currentEvent = undefined;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
