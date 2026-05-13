import { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { Brain, Copy, Check } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { ToolCallCard } from './ToolCallCard';
import { XRayFooter } from './XRayFooter';
import { promoteMemoryText, rememberText } from '../../lib/api';
import { useAppStore } from '../../lib/store';
import type { ChatMessage } from '../../types';

function stripThinkTags(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  cleaned = cleaned.replace(/^[\s\S]*?<\/think>\s*/i, '');
  return cleaned.trim();
}

interface Props {
  message: ChatMessage;
}

function getTextContent(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getTextContent).join('');
  }
  if (node?.props?.children) {
    return getTextContent(node.props.children);
  }
  return '';
}

function CodeBlockPre({ children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const codeElement = Array.isArray(children) ? children[0] : children;
  const className = codeElement?.props?.className || '';
  const match = /language-([\w-]+)/.exec(className);
  const lang = match ? match[1] : '';
  const code = getTextContent(codeElement?.props?.children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="code-block-wrapper relative my-3"
      style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden' }}
    >
      <div
        className="flex items-center justify-between px-4 py-1.5 text-xs"
        style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }}
      >
        <span className="font-mono">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-tertiary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-tertiary)')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre {...props} style={{ margin: 0, borderRadius: 0 }}>
        {children}
      </pre>
    </div>
  );
}

function CopyMessageButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
      style={{ color: 'var(--color-text-tertiary)' }}
      title="Copy message"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function RememberMessageButton({ content }: { content: string }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const addLogEntry = useAppStore((s) => s.addLogEntry);

  const handleRemember = async () => {
    const clean = content.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      await rememberText(clean.slice(0, 1200));
      setSaved(true);
      addLogEntry({
        timestamp: Date.now(),
        level: 'info',
        category: 'tool',
        message: 'Saved message to Obsidian inbox',
      });
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      addLogEntry({
        timestamp: Date.now(),
        level: 'error',
        category: 'tool',
        message: error instanceof Error ? error.message : 'Failed to save memory',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={handleRemember}
      disabled={saving || !content.trim()}
      className="flex items-center gap-1 px-1.5 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-default disabled:opacity-30"
      style={{ color: saved ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
      title="Save to Jarvis memory inbox"
    >
      {saved ? <Check size={14} /> : <Brain size={14} />}
      <span className="text-[11px]">{saved ? 'Saved' : 'Remember'}</span>
    </button>
  );
}

function PromoteMemoryButton({ content }: { content: string }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const addLogEntry = useAppStore((s) => s.addLogEntry);

  const handlePromote = async () => {
    const clean = content.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      await promoteMemoryText(clean.slice(0, 1200));
      setSaved(true);
      addLogEntry({
        timestamp: Date.now(),
        level: 'info',
        category: 'tool',
        message: 'Promoted message to long-term memory',
      });
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      addLogEntry({
        timestamp: Date.now(),
        level: 'error',
        category: 'tool',
        message: error instanceof Error ? error.message : 'Failed to promote memory',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={handlePromote}
      disabled={saving || !content.trim()}
      className="flex items-center gap-1 px-1.5 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-default disabled:opacity-30"
      style={{ color: saved ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
      title="Save directly to long-term memory"
    >
      {saved ? <Check size={14} /> : <Brain size={14} />}
      <span className="text-[11px]">{saved ? 'Promoted' : 'Promote'}</span>
    </button>
  );
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="group flex flex-col items-end mb-4">
        <div
          className="max-w-[85%] px-4 py-2.5 text-sm leading-relaxed"
          style={{
            background: 'var(--color-user-bubble)',
            color: 'var(--color-user-bubble-text)',
            borderRadius: 'var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.content}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <RememberMessageButton content={message.content} />
          <PromoteMemoryButton content={message.content} />
          <CopyMessageButton content={message.content} />
        </div>
      </div>
    );
  }

  const cleanContent = useMemo(() => stripThinkTags(message.content), [message.content]);

  return (
    <div className="group mb-6">
      {/* Tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {/* Audio player (e.g. morning digest) */}
      {message.audio?.url && <AudioPlayer src={message.audio.url} />}

      {/* Assistant message */}
      {cleanContent && (
        <div className="prose max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeHighlight, { detect: true }], rehypeKatex]}
            components={{
              pre: CodeBlockPre,
            }}
          >
            {cleanContent}
          </ReactMarkdown>
        </div>
      )}

      {/* Footer: copy + x-ray */}
      <div className="flex items-center gap-2 mt-1.5">
        <RememberMessageButton content={cleanContent} />
        <PromoteMemoryButton content={cleanContent} />
        <CopyMessageButton content={cleanContent} />
      </div>
      <XRayFooter usage={message.usage} telemetry={message.telemetry} />
    </div>
  );
}
