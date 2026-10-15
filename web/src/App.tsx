import { useEffect, useState } from 'react';
import { Chat } from './components/Chat';
import { RightPanel } from './components/RightPanel';
import { SettingsModal, type SettingsTab } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Onboarding, needsOnboarding } from './components/Onboarding';
import { useStore } from './store';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const openSettings = (tab?: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
  const settings = useStore((s) => s.settings);

  // First run (or ?setup in the URL, or "Run setup again" in Settings): the setup guide.
  const [setup, setSetup] = useState<'auto' | 'open' | 'closed'>(() => (new URLSearchParams(location.search).has('setup') ? 'open' : 'auto'));
  const showSetup = setup === 'open' || (setup === 'auto' && needsOnboarding(settings));
  // Once the guide is up it stays up until it is finished or skipped (its own steps make needsOnboarding false).
  useEffect(() => {
    if (setup === 'auto' && needsOnboarding(settings)) setSetup('open');
  }, [setup, settings]);
  const closeSetup = () => {
    setSetup('closed');
    if (new URLSearchParams(location.search).has('setup')) history.replaceState(null, '', location.pathname);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      }
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full flex bg-ink-950 text-ink-100">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onOpenSettings={openSettings} />
        <div className="flex-1 flex min-h-0">
          <Chat />
          <RightPanel onOpenSettings={openSettings} />
        </div>
      </div>
      {settingsOpen && (
        <SettingsModal
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
          onRunSetup={() => {
            setSettingsOpen(false);
            setSetup('open');
          }}
        />
      )}
      {showSetup && settings && <Onboarding onClose={closeSetup} />}
    </div>
  );
}
