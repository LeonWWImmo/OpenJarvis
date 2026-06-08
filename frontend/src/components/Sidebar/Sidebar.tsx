import { useNavigate, useLocation } from 'react-router';
import {
  Settings,
  PanelLeftClose,
  PanelLeft,
  Cpu,
  Sun,
  Moon,
  Monitor,
  Mic,
} from 'lucide-react';
import { useAppStore } from '../../lib/store';

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const serverInfo = useAppStore((s) => s.serverInfo);

  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const ThemeIcon = settings.theme === 'light' ? Sun : settings.theme === 'dark' ? Moon : Monitor;
  const nextTheme = settings.theme === 'light' ? 'dark' : settings.theme === 'dark' ? 'system' : 'light';

  // Minimalistisch — nur Hauptansicht (JARVIS) + Settings.
  // Alles andere (Dashboard, Logs, Classic Chat, etc.) ist routbar via URL
  // aber nicht in der Sidebar — Jarvis kümmert sich um den Rest.
  const navItems = [
    { path: '/', icon: Mic, label: 'JARVIS' },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <>
      {/* Collapse button when sidebar is closed */}
      {!sidebarOpen && (
        <button
          onClick={toggleSidebar}
          className="fixed top-3 left-3 z-30 p-2 rounded-lg transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--color-bg-secondary)')}
        >
          <PanelLeft size={18} />
        </button>
      )}

      <aside
        className={`
          flex flex-col h-full shrink-0 transition-all duration-200 ease-in-out overflow-hidden
          fixed md:relative z-30
          ${sidebarOpen ? 'w-[260px]' : 'w-0'}
        `}
        style={{
          background: 'var(--color-sidebar)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRight: sidebarOpen ? '1px solid var(--color-border)' : 'none',
        }}
      >
        <div className="flex flex-col h-full w-[260px]">
          {/* Header: collapse + theme — minimalistisch */}
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-lg transition-colors cursor-pointer"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <PanelLeftClose size={18} />
            </button>
            <button
              onClick={() => updateSettings({ theme: nextTheme })}
              className="p-2 rounded-lg transition-colors cursor-pointer"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-tertiary)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              title={`Theme: ${settings.theme} (click for ${nextTheme})`}
            >
              <ThemeIcon size={16} />
            </button>
          </div>

          {/* Brand badge */}
          <div className="mx-3 mb-2 px-3 py-3 rounded-lg text-xs flex items-center gap-2"
               style={{
                 background: 'var(--color-bg-secondary)',
                 color: 'var(--color-text-secondary)',
                 border: '1px solid var(--color-border)',
               }}>
            <Cpu size={14} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>JARVIS</div>
              <div className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                Local · {selectedModel || serverInfo?.model || '...'}
              </div>
            </div>
          </div>

          <div className="flex-1" />


          {/* Bottom nav */}
          <nav className="px-2 pb-3 pt-2 flex flex-col gap-0.5" style={{ borderTop: '1px solid var(--color-border)' }}>
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full text-left cursor-pointer"
                  style={{
                    background: isActive ? 'var(--color-accent-subtle)' : 'transparent',
                    color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)',
                    fontWeight: isActive ? 500 : 400,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'var(--color-bg-secondary)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <item.icon size={16} />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </aside>
    </>
  );
}
