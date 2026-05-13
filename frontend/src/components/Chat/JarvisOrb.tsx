import { useAppStore } from '../../lib/store';
import type { CSSProperties } from 'react';

interface JarvisOrbProps {
  compact?: boolean;
}

export function JarvisOrb({ compact = false }: JarvisOrbProps) {
  const streamState = useAppStore((s) => s.streamState);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const wakeWordEnabled = useAppStore((s) => s.settings.wakeWordEnabled);
  const phase = streamState.isStreaming ? 'thinking' : speechEnabled && wakeWordEnabled ? 'listening' : 'standby';

  return (
    <div className={`jarvis-orb-wrap ${compact ? 'jarvis-orb-compact' : ''} jarvis-orb-${phase}`} aria-hidden="true">
      <div className="jarvis-grid" />
      <div className="jarvis-orb">
        <div className="jarvis-ring jarvis-ring-outer" />
        <div className="jarvis-ring jarvis-ring-middle" />
        <div className="jarvis-ring jarvis-ring-inner" />
        <div className="jarvis-core">
          <div className="jarvis-core-glow" />
          <div className="jarvis-core-dot" />
        </div>
        <div className="jarvis-scanline" />
        {Array.from({ length: 18 }).map((_, index) => (
          <span
            key={index}
            className="jarvis-spark"
            style={{
              '--spark-index': index,
              '--spark-rotation': `${index * 20}deg`,
              '--spark-distance': `${132 + (index % 4) * 13}px`,
              '--spark-delay': `${index * -0.19}s`,
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="jarvis-status">
        <span>{phase === 'thinking' ? 'Processing' : phase === 'listening' ? 'Voice link active' : 'Standby'}</span>
        <strong>JARVIS CORE</strong>
      </div>
    </div>
  );
}
