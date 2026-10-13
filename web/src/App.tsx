import { useEffect, useState } from 'react';
import { Chat } from './components/Chat';
import { RightPanel } from './components/RightPanel';
import { SettingsModal, type SettingsTab } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const openSettings = (tab?: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
  const settings = useStore((s) => s.settings);

  // First run: open settings so the user approves a folder.
  useEffect(() => {
    if (settings && settings.approvedFolders.length === 0) setSettingsOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings === null]);

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
      {settingsOpen && <SettingsModal initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
