import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Sidebar } from './Sidebar/Sidebar';
import { SystemPulse } from './SystemPulse';
import { JarvisWebGLOrb } from './Chat/JarvisWebGLOrb';
import { useAppStore } from '../lib/store';
import { checkHealth } from '../lib/api';

export function Layout() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const location = useLocation();
  // JARVIS-Home (default '/') ist transparent — der Rest hat normalen BG.
  const transparentBg = location.pathname === '/';

  useEffect(() => {
    const check = () => checkHealth().then(setApiReachable);
    check();
    const interval = setInterval(check, 30000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const navigate = useNavigate();

  // Auf Home: fullscreen Orb-Look ohne SystemPulse, ohne Sidebar.
  // Sonst: normale Sidebar + SystemPulse-Header.
  if (transparentBg) {
    return (
      <div className="h-full w-full overflow-hidden">
        <Outlet />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden" style={{ paddingTop: '3px' }}>
      <SystemPulse apiReachable={apiReachable} />

      {/* Health check banner */}
      {apiReachable === false && (
        <div
          className="flex items-center gap-3 px-4 py-2 text-sm shrink-0"
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.15)',
            color: 'var(--color-text)',
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'var(--color-error)' }}
          />
          <span>Cannot reach OpenJarvis backend</span>
          <button
            onClick={() => navigate('/settings')}
            className="text-sm underline cursor-pointer ml-auto shrink-0"
            style={{ color: 'var(--color-accent)' }}
          >
            Change URL
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <Sidebar />
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/40 md:hidden"
            onClick={() => useAppStore.getState().setSidebarOpen(false)}
          />
        )}
        <main
          className="relative flex-1 flex flex-col min-w-0 h-full overflow-hidden"
          style={{ background: 'var(--color-bg)' }}
        >
          <div className="jarvis-layout-core" aria-hidden="true">
            <JarvisWebGLOrb />
          </div>
          <div className="relative z-10 flex flex-col min-h-0 h-full">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
