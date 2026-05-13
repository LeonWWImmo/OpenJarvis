import { useRef, useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { MessageBubble } from './MessageBubble';
import { InputArea } from './InputArea';
import { StreamingDots } from './StreamingDots';
import { useAppStore } from '../../lib/store';
import { PanelRightOpen, PanelRightClose, Database, X } from 'lucide-react';
import { listConnectors } from '../../lib/connectors-api';

export function ChatArea() {
  const messages = useAppStore((s) => s.messages);
  const streamState = useAppStore((s) => s.streamState);
  const systemPanelOpen = useAppStore((s) => s.systemPanelOpen);
  const toggleSystemPanel = useAppStore((s) => s.toggleSystemPanel);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Check if any data sources are connected
  const [hasConnectedSources, setHasConnectedSources] = useState<boolean | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    listConnectors()
      .then((list) => setHasConnectedSources(list.some((c) => c.connected)))
      .catch(() => setHasConnectedSources(null));
  }, []);

  useEffect(() => {
    if (shouldAutoScroll.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streamState.content]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 100;
  };

  const isEmpty = messages.length === 0 && !streamState.isStreaming;

  const PanelIcon = systemPanelOpen ? PanelRightClose : PanelRightOpen;

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      <div className="jarvis-atmosphere" aria-hidden="true" />
      {/* Toggle bar */}
      <div className="relative z-10 flex items-center justify-end px-3 py-1.5 shrink-0">
        <button
          onClick={toggleSystemPanel}
          className="p-1.5 rounded-md transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-tertiary)' }}
          title={`${systemPanelOpen ? 'Hide' : 'Show'} system panel (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+I)`}
        >
          <PanelIcon size={16} />
        </button>
      </div>

      {/* Data sources banner */}
      {hasConnectedSources === false && !bannerDismissed && (
        <div
          className="relative z-10 mx-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-lg text-sm shrink-0"
          style={{
            background: 'var(--color-accent-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          <Database size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span style={{ color: 'var(--color-text-secondary)', flex: 1 }}>
            Connect your data sources (Gmail, iMessage, Slack, etc.) to get personalized answers.
          </span>
          <button
            onClick={() => navigate('/data-sources')}
            className="px-3 py-1 rounded text-xs font-medium cursor-pointer"
            style={{ background: 'var(--color-accent)', color: '#fff', border: 'none' }}
          >
            Connect
          </button>
          <button
            onClick={() => setBannerDismissed(true)}
            className="p-1 rounded cursor-pointer"
            style={{ color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none' }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="relative z-10 flex-1 overflow-y-auto"
      >
        {isEmpty ? (
          <div className="h-full" />
        ) : (
          <div className="max-w-[var(--chat-max-width)] mx-auto px-4 py-6">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {streamState.isStreaming && streamState.content === '' && (
              <div className="flex justify-start mb-4">
                <StreamingDots phase={streamState.phase} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="relative z-10">
        <InputArea />
      </div>
    </div>
  );
}
