// First-run setup: Welcome → Local or Cloud → model / accounts → folder → chatting.
// Styled as "Dex entries" (onboarding.css); fonts are bundled so nothing is fetched from the internet.
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './onboarding.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MEMBER_IDS, type LocalServerScan, type MemberId, type MemberStatus, type ModelInfo, type Settings } from '@localdex/shared';
import { send, useStore } from '../store';

type Step = 'welcome' | 'choose' | 'local' | 'cloud' | 'folder' | 'ready';
type Brain = 'local' | 'cloud';
type Pick = { baseUrl: string; model: string; server: string };

/** Show the guide on a fresh install: nothing set up yet and no record of the guide. */
export function needsOnboarding(s: Settings | null): boolean {
  return !!s && !s.onboarding?.completedAt && s.approvedFolders.length === 0 && !s.council.enabled;
}

const CLOUD: Record<MemberId, { name: string; vendor: string; color: string }> = {
  claude: { name: 'Claude', vendor: 'Anthropic · Pro/Max', color: '#e8a07a' },
  codex: { name: 'ChatGPT', vendor: 'OpenAI · runs as Codex', color: '#a9b6ff' },
  gemini: { name: 'Gemini', vendor: 'Google · Login with Google', color: '#7cc0f2' },
  cursor: { name: 'Cursor', vendor: 'Cursor plan', color: '#d6dde6' },
};

const MIN_CTX = 16_000;

const isChatModel = (m: ModelInfo) => !/embed|rerank|whisper|tts/i.test(m.id);
const normUrl = (u: string) => u.trim().replace(/\/+$/, '').replace('://127.0.0.1', '://localhost');
const usable = (st?: MemberStatus) => !!st?.installed && st.signedIn && st.billing !== 'api';
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const fmtCtx = (n?: number) => (!n ? '' : n % 1024 === 0 ? `${n / 1024}k` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Best first pick: the model already in settings, else a loaded one with the biggest context, else the first. */
function suggest(scan: LocalServerScan[], s: Settings): Pick | null {
  const ok = scan.filter((x) => x.ok && x.models.some(isChatModel));
  for (const srv of ok) {
    if (srv.current && s.model && srv.models.some((m) => m.id === s.model)) return { baseUrl: srv.baseUrl, model: s.model, server: srv.label };
  }
  for (const srv of ok) {
    const loaded = srv.models.filter((m) => m.loaded && isChatModel(m)).sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
    if (loaded[0]) return { baseUrl: srv.baseUrl, model: loaded[0].id, server: srv.label };
  }
  const first = ok[0];
  const m = first?.models.find(isChatModel);
  return first && m ? { baseUrl: first.baseUrl, model: m.id, server: first.label } : null;
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const session = useStore((s) => s.session);
  const connected = useStore((s) => s.connected);
  const statuses = useStore((s) => s.council);

  const [step, setStep] = useState<Step>('welcome');
  const [brain, setBrain] = useState<Brain | null>(null);
  const [furthest, setFurthest] = useState(0);
  const [scan, setScan] = useState<LocalServerScan[] | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [chatOnly, setChatOnly] = useState(false);
  const [playground, setPlayground] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  // ---------- local server scan ----------
  const scanNow = useCallback(async (extra?: string) => {
    try {
      const r = await fetch(`/api/setup/scan${extra ? `?url=${encodeURIComponent(extra)}` : ''}`);
      const j = (await r.json()) as { servers: LocalServerScan[] };
      setScan(j.servers ?? []);
      return j.servers ?? [];
    } catch {
      setScan((prev) => prev ?? []);
      return [];
    }
  }, []);

  const foundAny = !!scan?.some((x) => x.ok && x.models.some(isChatModel));

  useEffect(() => {
    void scanNow();
    send({ type: 'council_refresh' });
  }, [scanNow, connected]);

  // Keep looking while the user starts LM Studio / Ollama.
  useEffect(() => {
    if (step !== 'local' || foundAny) return;
    const t = setInterval(() => void scanNow(), 3000);
    return () => clearInterval(t);
  }, [step, foundAny, scanNow]);

  // Coming back from the browser or Terminal: look again.
  useEffect(() => {
    const onFocus = () => {
      if (step === 'local' || step === 'choose') void scanNow();
      if (step === 'cloud' || step === 'choose') send({ type: 'council_refresh' });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [step, scanNow]);

  useEffect(() => {
    if (!pick && scan && settings) setPick(suggest(scan, settings));
  }, [scan, settings, pick]);

  useEffect(() => {
    headRef.current?.focus();
  }, [step]);

  // ---------- navigation ----------
  const entries: Array<{ id: Step; label: string }> = [
    { id: 'welcome', label: 'Welcome' },
    { id: 'choose', label: 'Choose' },
    { id: brain === 'cloud' ? 'cloud' : 'local', label: brain === 'cloud' ? 'Accounts' : brain === 'local' ? 'Model' : 'Connect' },
    { id: 'folder', label: 'Folder' },
    { id: 'ready', label: 'Ready' },
  ];
  const index = entries.findIndex((e) => e.id === step);
  const go = (s: Step) => {
    const i = entries.findIndex((e) => e.id === s);
    setStep(s);
    setFurthest((f) => Math.max(f, i < 0 ? (s === 'cloud' || s === 'local' ? 2 : f) : i));
  };

  if (!settings) return null;

  // ---------- commits ----------
  const choose = (b: Brain) => {
    setBrain(b);
    // Changing the brain invalidates the steps after it.
    setFurthest(2);
    setStep(b);
  };

  const commitLocal = () => {
    if (!pick) return;
    const patch: Partial<Settings> = { model: pick.model };
    if (normUrl(pick.baseUrl) !== normUrl(settings.baseUrl)) patch.baseUrl = pick.baseUrl;
    send({ type: 'set_settings', patch });
    if (session) send({ type: 'set_model', sessionId: session.id, model: pick.model });
    go('folder');
  };

  const commitCloud = () => {
    const patch: Partial<Settings> = { council: { ...settings.council, enabled: true } };
    // No local server answered: don't leave a model selected that the router would try first.
    if (!foundAny) patch.model = null;
    send({ type: 'set_settings', patch });
    go('folder');
  };

  const commitFolder = (f: string | null) => {
    if (f) {
      setFolder(f);
      setChatOnly(false);
      send({ type: 'set_settings', patch: { approvedFolders: [f, ...settings.approvedFolders.filter((x) => x !== f)] } });
    } else {
      setChatOnly(true);
    }
    go('ready');
  };

  const finish = (prompt?: string) => {
    send({ type: 'set_settings', patch: { onboarding: { completedAt: Date.now(), path: brain ?? undefined } } });
    if (session) {
      const mode = brain === 'cloud' ? 'council' : 'solo';
      if ((session.mode ?? 'solo') !== mode) send({ type: 'set_mode', sessionId: session.id, mode });
      if (prompt) send({ type: 'send_message', sessionId: session.id, content: prompt });
    }
    onClose();
  };

  const skip = () => {
    send({ type: 'set_settings', patch: { onboarding: { completedAt: Date.now(), skipped: true } } });
    onClose();
  };

  const bigNum = index > 0 && step !== 'ready' ? String(index).padStart(2, '0') : null;

  return (
    <div className="dex" role="dialog" aria-modal="true" aria-labelledby="dex-h">
      <div className="dex-glow" aria-hidden="true" />
      <svg className="dex-grain" aria-hidden="true">
        <filter id="dex-grain-f">
          <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#dex-grain-f)" />
      </svg>

      <aside className="dex-rail">
        <div>
          <div className="dex-serif" style={{ fontSize: 32, lineHeight: 1 }}>
            Local<span className="dex-em">Dex</span>
          </div>
          <div className="dex-label dex-rail-brand-sub" style={{ marginTop: 10 }}>
            Setup · about two minutes
          </div>
        </div>
        <nav aria-label="Setup steps">
          <ol className="dex-rail-list">
            {entries.map((e, i) => {
              const reachable = i <= furthest && i !== index;
              return (
                <li key={e.label}>
                  <button
                    type="button"
                    className="dex-entry"
                    data-state={i === index ? 'on' : i < index ? 'done' : 'todo'}
                    data-reachable={reachable}
                    aria-current={i === index ? 'step' : undefined}
                    aria-disabled={!reachable && i !== index}
                    onClick={() => reachable && go(e.id === 'local' && brain === null ? 'choose' : e.id)}
                  >
                    <span className="n">{String(i).padStart(3, '0')}</span>
                    <span className="t">
                      <span className="l">{e.label}</span>
                      <span className="bar">
                        <span />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <button type="button" className="dex-link" style={{ alignSelf: 'flex-start' }} onClick={skip}>
          Skip setup
        </button>
      </aside>

      <main className="dex-main">
        {bigNum && (
          <div key={`n${step}`} className="dex-bignum dex-num-in" aria-hidden="true">
            {bigNum}
          </div>
        )}
        <div key={step} style={{ minHeight: '100%' }}>
          {step === 'welcome' && <Welcome headRef={headRef} connected={connected} onStart={() => go('choose')} onSkip={skip} />}
          {step === 'choose' && <Choose headRef={headRef} scan={scan} statuses={statuses} brain={brain} onPick={choose} />}
          {step === 'local' && (
            <LocalStep headRef={headRef} scan={scan} pick={pick} setPick={setPick} rescan={scanNow} onContinue={commitLocal} onSwitch={() => choose('cloud')} />
          )}
          {step === 'cloud' && <CloudStep headRef={headRef} statuses={statuses} onContinue={commitCloud} onSwitch={() => choose('local')} />}
          {step === 'folder' && (
            <FolderStep
              headRef={headRef}
              existing={settings.approvedFolders}
              allowSkip={brain !== 'cloud'}
              playground={playground}
              setPlayground={setPlayground}
              onUse={commitFolder}
            />
          )}
          {step === 'ready' && (
            <Ready
              headRef={headRef}
              brain={brain}
              pick={pick}
              statuses={statuses}
              folder={chatOnly ? null : folder}
              isPlayground={!!folder && folder === playground}
              onFinish={finish}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- shared bits ----------

type HeadRef = RefObject<HTMLHeadingElement>;

function Copy({ headRef, kicker, lines, children }: { headRef: HeadRef; kicker: string; lines: ReactNode[]; children?: ReactNode }) {
  return (
    <div className="dex-copy">
      <div className="dex-kicker dex-a dex-fi" style={{ animationDelay: '.05s' }}>
        {kicker}
      </div>
      <h2 id="dex-h" ref={headRef} tabIndex={-1} className="dex-h">
        {lines.map((l, i) => (
          <span key={i} className="dex-ln">
            <span style={{ animationDelay: `${0.12 + i * 0.13}s` }}>{l}</span>
          </span>
        ))}
      </h2>
      {children}
    </div>
  );
}

function Icon({ d, size = 20, color = 'currentColor' }: { d: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const I = {
  chip: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 6h10a1 1 0 011 1v10a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1z',
  cloud: 'M7 18a4 4 0 01-.6-7.96A6 6 0 0118 9a4.5 4.5 0 01-.5 9H7z',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M5 12l7-7 7 7',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z M9 12l2.2 2.2L15 10',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
};

function Spinner({ label }: { label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="dex-spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

// ---------- 000 Welcome ----------

function Welcome({ headRef, connected, onStart, onSkip }: { headRef: HeadRef; connected: boolean; onStart: () => void; onSkip: () => void }) {
  return (
    <div className="dex-stage" style={{ alignItems: 'center', paddingBottom: 120 }}>
      <div style={{ maxWidth: 900 }}>
        <div className="dex-kicker dex-a dex-fi" style={{ display: 'flex', alignItems: 'center', gap: 14, animationDelay: '.1s' }}>
          <span style={{ display: 'block', width: 44, height: 1, background: 'var(--dex-acid)' }} />
          Welcome
        </div>
        <h1 id="dex-h" ref={headRef} tabIndex={-1} className="dex-serif" style={{ margin: '14px 0 0', fontSize: 'clamp(110px, 15vw, 206px)', lineHeight: 0.92, letterSpacing: '-.02em', outline: 'none' }}>
          <span className="dex-ln">
            <span style={{ animationDelay: '.25s' }}>
              Local<span className="dex-em">Dex</span>
            </span>
          </span>
        </h1>
        <p className="dex-a dex-fu" style={{ animationDelay: '1s', margin: '28px 0 0', fontSize: 24, color: 'var(--dex-soft)' }}>
          Your files. Your terminal. Your model.
        </p>
        <p className="dex-a dex-fu dex-mono" style={{ animationDelay: '1.2s', margin: '16px 0 0', fontSize: 13, color: 'var(--dex-dim)' }}>
          Pick a brain, pick a folder, start chatting. Local models never leave your machine.
        </p>
        <div className="dex-a dex-fu" style={{ animationDelay: '1.45s', display: 'flex', alignItems: 'center', gap: 18, marginTop: 36, flexWrap: 'wrap' }}>
          <button type="button" className="dex-btn" onClick={onStart} disabled={!connected}>
            Get started <Icon d={I.arrow} size={18} />
          </button>
          <button type="button" className="dex-link" onClick={onSkip}>
            I'll set it up myself
          </button>
          {!connected && (
            <span className="dex-mono dex-pulse" style={{ fontSize: 12, color: 'var(--dex-warn)' }}>
              Connecting to the LocalDex server…
            </span>
          )}
        </div>
      </div>
      <div className="dex-marquee" aria-hidden="true">
        <div>
          {[0, 1].map((k) => (
            <span key={k}>Files • Terminal • Local or cloud • Your subscriptions, no API keys • Files • Terminal • Local or cloud • Your subscriptions, no API keys •</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 001 Choose ----------

function Choose({ headRef, scan, statuses, brain, onPick }: { headRef: HeadRef; scan: LocalServerScan[] | null; statuses: MemberStatus[]; brain: Brain | null; onPick: (b: Brain) => void }) {
  const found = scan?.filter((x) => x.ok && x.models.some(isChatModel)) ?? [];
  const signedIn = MEMBER_IDS.filter((id) => usable(statuses.find((s) => s.id === id)));
  return (
    <div className="dex-stage">
      <Copy headRef={headRef} kicker="Entry 001 · Choose" lines={['Pick your', <span className="dex-em">brain.</span>]}>
        <p className="dex-p dex-a dex-fu" style={{ animationDelay: '.5s' }}>
          Run a model on this computer, or bring the cloud models you already pay for. You can add the other one later in Settings.
        </p>
      </Copy>
      <div className="dex-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <button type="button" className="dex-choice dex-a dex-fu" style={{ animationDelay: '.3s' }} aria-pressed={brain === 'local'} onClick={() => onPick('local')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon d={I.chip} size={26} color="var(--dex-acid)" />
            <span className="dex-serif" style={{ fontSize: 34, lineHeight: 1 }}>
              Local model
            </span>
          </div>
          <p style={{ margin: '10px 0 14px', color: 'var(--dex-soft)' }}>Runs on this computer through LM Studio or Ollama. Private, free, works offline.</p>
          {scan === null ? (
            <span className="dex-chip dex-pulse">Looking for local models…</span>
          ) : found.length ? (
            <span className="dex-chip" data-tone="ok">
              <span className="dex-dot" /> Found {found[0].label} · {found[0].models.filter(isChatModel).length} model{found[0].models.filter(isChatModel).length === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="dex-chip">Nothing running yet. We'll help you start it.</span>
          )}
        </button>
        <button type="button" className="dex-choice dex-a dex-fu" style={{ animationDelay: '.42s' }} aria-pressed={brain === 'cloud'} onClick={() => onPick('cloud')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon d={I.cloud} size={26} color="var(--dex-acid)" />
            <span className="dex-serif" style={{ fontSize: 34, lineHeight: 1 }}>
              Cloud model
            </span>
          </div>
          <p style={{ margin: '10px 0 14px', color: 'var(--dex-soft)' }}>Claude, ChatGPT, Gemini or Cursor, on the subscription you already have. You sign in with your browser, so there are no API keys to paste.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {signedIn.length ? (
              <span className="dex-chip" data-tone="ok">
                <span className="dex-dot" /> Signed in: {signedIn.map((id) => CLOUD[id].name).join(', ')}
              </span>
            ) : (
              MEMBER_IDS.map((id) => (
                <span key={id} className="dex-chip">
                  <span className="dex-dot" style={{ background: CLOUD[id].color }} /> {CLOUD[id].name}
                </span>
              ))
            )}
          </div>
        </button>
      </div>
    </div>
  );
}

// ---------- 002 Local model ----------

function LocalStep({
  headRef,
  scan,
  pick,
  setPick,
  rescan,
  onContinue,
  onSwitch,
}: {
  headRef: HeadRef;
  scan: LocalServerScan[] | null;
  pick: Pick | null;
  setPick: (p: Pick) => void;
  rescan: (extra?: string) => Promise<LocalServerScan[]>;
  onContinue: () => void;
  onSwitch: () => void;
}) {
  const [custom, setCustom] = useState('');
  const [checking, setChecking] = useState(false);
  const [customErr, setCustomErr] = useState<string | null>(null);
  const servers = (scan ?? []).filter((x) => x.ok && x.models.some(isChatModel));
  const picked = pick && servers.some((s) => s.baseUrl === pick.baseUrl && s.models.some((m) => m.id === pick.model)) ? pick : null;
  const pickedInfo = picked ? servers.find((s) => s.baseUrl === picked.baseUrl)?.models.find((m) => m.id === picked.model) : undefined;

  const checkCustom = async () => {
    if (!custom.trim()) return;
    setChecking(true);
    setCustomErr(null);
    const res = await rescan(custom.trim());
    setChecking(false);
    const hit = res.find((x) => x.baseUrl.includes(custom.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/v1$/, '')));
    if (!hit?.ok) setCustomErr(hit?.error ? `No answer there (${hit.error}).` : 'No answer there.');
  };

  return (
    <div className="dex-stage">
      <Copy headRef={headRef} kicker="Entry 002 · Model" lines={servers.length ? ['Choose a', <span className="dex-em">model.</span>] : ['Start your', <span className="dex-em">model server.</span>]}>
        <p className="dex-p dex-a dex-fu" style={{ animationDelay: '.5s' }}>
          {servers.length
            ? 'We found these on your machine. Models marked ● are loaded and answer right away; the others load the first time you use them.'
            : 'LocalDex talks to LM Studio or Ollama on this computer. Start one and this page picks it up on its own.'}
        </p>
        <button type="button" className="dex-link dex-a dex-fi" style={{ animationDelay: '.7s', marginTop: 18 }} onClick={onSwitch}>
          Use a cloud model instead →
        </button>
      </Copy>

      <div className="dex-panel">
        <div className="dex-glass dex-a dex-fu" style={{ animationDelay: '.25s' }}>
          {scan === null ? (
            <Scanning />
          ) : servers.length ? (
            <>
              <div className="dex-scroll" role="radiogroup" aria-label="Local models">
                {servers.map((srv) => (
                  <div key={srv.baseUrl} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="dex-label" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <span>{srv.label}</span>
                      <span style={{ textTransform: 'none', letterSpacing: 0 }}>{srv.baseUrl.replace(/^https?:\/\//, '')}</span>
                    </div>
                    {srv.models.filter(isChatModel).map((m) => {
                      const on = picked?.baseUrl === srv.baseUrl && picked.model === m.id;
                      return (
                        <button key={m.id} type="button" role="radio" aria-checked={on} className="dex-row" onClick={() => setPick({ baseUrl: srv.baseUrl, model: m.id, server: srv.label })}>
                          <span className="dex-dot" data-off={!m.loaded} aria-label={m.loaded ? 'loaded' : 'not loaded'} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="dex-mono" style={{ display: 'block', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {m.id}
                            </span>
                            <span style={{ display: 'block', fontSize: 12, color: 'var(--dex-dim)', marginTop: 2 }}>
                              {[m.contextLength ? `${fmtCtx(m.contextLength)} context` : null, m.loaded ? 'loaded' : 'loads on first use'].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          {!!m.contextLength && m.contextLength < MIN_CTX && (
                            <span className="dex-chip" data-tone="warn">
                              small context
                            </span>
                          )}
                          {on && <Icon d={I.check} size={18} color="var(--dex-acid)" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {pickedInfo?.contextLength && pickedInfo.contextLength < MIN_CTX ? (
                <p style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--dex-warn)' }}>
                  This model is loaded with under 16k context. Coding work needs more: reload it in LM Studio with 16k or higher if you can.
                </p>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
                <span className="dex-mono" style={{ fontSize: 12, color: 'var(--dex-dim)' }}>
                  {picked ? `${picked.server} · ${picked.model}` : 'Pick a model'}
                </span>
                <button type="button" className="dex-btn" disabled={!picked} onClick={onContinue}>
                  Use this model <Icon d={I.arrow} size={18} />
                </button>
              </div>
            </>
          ) : (
            <NotFound />
          )}
          <details style={{ marginTop: 18 }}>
            <summary className="dex-label" style={{ cursor: 'pointer', minHeight: 32, display: 'flex', alignItems: 'center' }}>
              Using another server?
            </summary>
            <form
              style={{ display: 'flex', gap: 8, marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                void checkCustom();
              }}
            >
              <label htmlFor="dex-custom-url" className="sr-only" style={{ position: 'absolute', left: -9999 }}>
                Server address
              </label>
              <input id="dex-custom-url" className="dex-input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="http://192.168.1.20:1234/v1" />
              <button type="submit" className="dex-btn dex-btn-sm dex-btn-line" disabled={!custom.trim() || checking}>
                {checking ? <Spinner label="Checking" /> : 'Check'}
              </button>
            </form>
            {customErr && <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--dex-danger)' }}>{customErr}</p>}
          </details>
        </div>
      </div>
    </div>
  );
}

function Scanning() {
  return (
    <div style={{ padding: '8px 0 4px', textAlign: 'center' }}>
      <div className="dex-radar" aria-hidden="true">
        <i style={{ inset: 0 }} />
        <i style={{ inset: 28 }} />
        <i style={{ inset: 56 }} />
        <div className="dex-sweep" />
      </div>
      <p className="dex-mono" style={{ margin: '16px 0 0', fontSize: 13, color: 'var(--dex-dim)' }}>
        Scanning localhost for LM Studio and Ollama…
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div className="dex-radar" aria-hidden="true" style={{ width: 92, height: 92, margin: 0, flex: 'none' }}>
          <i style={{ inset: 0 }} />
          <i style={{ inset: 18 }} />
          <div className="dex-sweep" />
        </div>
        <div>
          <div className="dex-mono dex-pulse" style={{ fontSize: 13, color: 'var(--dex-warn)' }}>
            Still looking…
          </div>
          <div style={{ fontSize: 14, color: 'var(--dex-soft)', marginTop: 4 }}>This page checks again every few seconds.</div>
        </div>
      </div>
      <ol style={{ margin: '20px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[
          <>
            Open <b>LM Studio</b> (free:{' '}
            <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">
              lmstudio.ai
            </a>
            ) or <b>Ollama</b>.
          </>,
          <>Download a chat model. Qwen2.5-Coder 14B or similar with tool support works well.</>,
          <>
            LM Studio: <b>Developer → Start Server</b>, or run <span className="dex-code" style={{ display: 'inline', padding: '2px 6px' }}>lms server start</span>. Ollama runs its server by itself.
          </>,
        ].map((t, i) => (
          <li key={i} style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
            <span className="dex-mono" style={{ color: 'var(--dex-acid)', fontSize: 12 }}>
              0{i + 1}
            </span>
            <span style={{ color: 'var(--dex-soft)', fontSize: 14 }}>{t}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- 002 Cloud accounts ----------

function CloudStep({ headRef, statuses, onContinue, onSwitch }: { headRef: HeadRef; statuses: MemberStatus[]; onContinue: () => void; onSwitch: () => void }) {
  const ready = MEMBER_IDS.filter((id) => usable(statuses.find((s) => s.id === id)));
  return (
    <div className="dex-stage">
      <Copy headRef={headRef} kicker="Entry 002 · Accounts" lines={['Connect your', <span className="dex-em">accounts.</span>]}>
        <p className="dex-p dex-a dex-fu" style={{ animationDelay: '.5s' }}>
          Sign in once with your browser. Each model runs through its official app on the subscription you already pay for, so you never paste an API key. One account is enough to start.
        </p>
        <p className="dex-a dex-fu" style={{ animationDelay: '.65s', margin: '14px 0 0', fontSize: 13, color: 'var(--dex-faint)', maxWidth: 420 }}>
          What you ask, and any files a cloud model reads, go to that company.
        </p>
        <button type="button" className="dex-link dex-a dex-fi" style={{ animationDelay: '.8s', marginTop: 14 }} onClick={onSwitch}>
          Use a local model instead →
        </button>
      </Copy>
      <div className="dex-panel">
        <div className="dex-glass dex-a dex-fu" style={{ animationDelay: '.25s', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {MEMBER_IDS.map((id, i) => (
            <MemberRow key={id} id={id} st={statuses.find((s) => s.id === id)} delay={0.35 + i * 0.08} />
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            <span className="dex-mono" style={{ fontSize: 12, color: ready.length ? 'var(--dex-acid)' : 'var(--dex-dim)' }}>
              {ready.length ? `Ready: ${ready.map((id) => CLOUD[id].name).join(', ')}` : 'Sign in to at least one'}
            </span>
            <button type="button" className="dex-btn" disabled={!ready.length} onClick={onContinue}>
              Continue <Icon d={I.arrow} size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MemberRow({ id, st, delay }: { id: MemberId; st?: MemberStatus; delay: number }) {
  const login = useStore((s) => s.councilLogin);
  const [installing, setInstalling] = useState(false);
  const [installErr, setInstallErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const meta = CLOUD[id];
  const signingIn = login?.member === id && !login.done;
  const loginErr = login?.member === id && login.done && login.error ? login.error : null;

  const install = async () => {
    setInstalling(true);
    setInstallErr(null);
    try {
      const r = await fetch('/api/setup/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member: id }) });
      const j = (await r.json()) as { ok: boolean; output: string };
      if (!j.ok) setInstallErr(j.output.split('\n').filter(Boolean).slice(-3).join(' ') || 'Install failed.');
    } catch (e) {
      setInstallErr((e as Error).message);
    }
    setInstalling(false);
  };

  let status: ReactNode;
  let action: ReactNode = null;
  if (!st) {
    status = <span className="dex-chip dex-pulse">Checking…</span>;
  } else if (!st.installed) {
    status = <span className="dex-chip">Not installed</span>;
    action =
      id === 'cursor' ? null : (
        <button type="button" className="dex-btn dex-btn-sm dex-btn-line" disabled={installing} onClick={() => void install()}>
          {installing ? <Spinner label="Installing" /> : 'Install'}
        </button>
      );
  } else if (signingIn) {
    status = (
      <span className="dex-chip" data-tone="warn">
        <span className="dex-spinner" aria-hidden="true" /> Waiting for your browser
      </span>
    );
    action = (
      <button type="button" className="dex-btn dex-btn-sm dex-btn-line" onClick={() => send({ type: 'council_login_cancel' })}>
        Cancel
      </button>
    );
  } else if (st.signedIn && st.billing === 'api') {
    status = (
      <span className="dex-chip" data-tone="bad">
        API key, not a subscription
      </span>
    );
    action = (
      <button type="button" className="dex-btn dex-btn-sm" onClick={() => send({ type: 'council_login', member: id })}>
        Switch
      </button>
    );
  } else if (st.signedIn) {
    status = (
      <span className="dex-chip" data-tone="ok">
        <Icon d={I.check} size={14} /> Signed in
      </span>
    );
  } else {
    status = <span className="dex-chip">Signed out</span>;
    action = (
      <button type="button" className="dex-btn dex-btn-sm" onClick={() => send({ type: 'council_login', member: id })}>
        Sign in
      </button>
    );
  }

  return (
    <div className="dex-a dex-fu" style={{ animationDelay: `${delay}s`, padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,.09)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span aria-hidden="true" className="dex-serif" style={{ width: 38, height: 38, flex: 'none', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: `${meta.color}22`, color: meta.color }}>
          {meta.name[0]}
        </span>
        <span style={{ flex: 1, minWidth: 120 }}>
          <span style={{ display: 'block', fontWeight: 600 }}>{meta.name}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--dex-dim)' }}>{st?.signedIn && st.account ? st.account : meta.vendor}</span>
        </span>
        {status}
        {action}
      </div>
      {st && !st.installed && id === 'cursor' && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--dex-dim)' }}>
          Cursor's SDK installs with LocalDex. Run <span className="dex-code" style={{ display: 'inline', padding: '2px 6px' }}>npm install</span> in the LocalDex folder, then come back.
        </p>
      )}
      {installErr && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--dex-danger)' }}>Couldn't install it here: {installErr}</p>
          <p style={{ margin: '6px 0 4px', fontSize: 13, color: 'var(--dex-dim)' }}>Run this in Terminal instead, then come back:</p>
          <code className="dex-code">npm i -g {id === 'claude' ? '@anthropic-ai/claude-code' : id === 'codex' ? '@openai/codex' : '@google/gemini-cli'}</code>
        </div>
      )}
      {signingIn && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--dex-soft)' }}>
          <p style={{ margin: 0 }}>Finish signing in to {meta.name} in the browser tab that just opened.</p>
          {login?.url && (
            <a href={login.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, minHeight: 32 }}>
              No tab opened? Open the sign-in page <Icon d={I.ext} size={14} />
            </a>
          )}
          {login?.needsCode && (
            <form
              style={{ display: 'flex', gap: 8, marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) send({ type: 'council_login_code', member: id, code: code.trim() });
                setCode('');
              }}
            >
              <label htmlFor={`dex-code-${id}`} style={{ position: 'absolute', left: -9999 }}>
                Code from the sign-in page
              </label>
              <input id={`dex-code-${id}`} className="dex-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code the page shows" autoComplete="off" />
              <button type="submit" className="dex-btn dex-btn-sm" disabled={!code.trim()}>
                Submit
              </button>
            </form>
          )}
        </div>
      )}
      {loginErr && <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--dex-danger)' }}>Sign-in didn't finish: {loginErr}</p>}
    </div>
  );
}

// ---------- 003 Folder ----------

type DirListing = { path: string; parent: string; dirs: string[]; error?: string };

function FolderStep({
  headRef,
  existing,
  allowSkip,
  playground,
  setPlayground,
  onUse,
}: {
  headRef: HeadRef;
  existing: string[];
  allowSkip: boolean;
  playground: string | null;
  setPlayground: (p: string) => void;
  onUse: (f: string | null) => void;
}) {
  const [browse, setBrowse] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (p?: string) => {
    try {
      const r = await fetch(`/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      const j = (await r.json()) as DirListing;
      if (j.error) setErr(j.error);
      else setErr(null);
      setBrowse(j);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const usePlayground = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/setup/playground', { method: 'POST' });
      const j = (await r.json()) as { ok: boolean; path?: string; error?: string };
      if (j.ok && j.path) {
        setPlayground(j.path);
        onUse(j.path);
      } else setErr(j.error ?? 'Could not create the playground folder.');
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const crumbs = useMemo(() => {
    if (!browse) return [];
    const parts = browse.path.split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }));
  }, [browse]);

  return (
    <div className="dex-stage">
      <Copy headRef={headRef} kicker="Entry 003 · Folder" lines={['Pick a', <span className="dex-em">workspace.</span>]}>
        <p className="dex-p dex-a dex-fu" style={{ animationDelay: '.5s' }}>
          The agent can only read and change files inside folders you approve. Secrets like ~/.ssh and .env files stay blocked even inside them, and risky commands ask you first.
        </p>
        {!allowSkip && (
          <p className="dex-a dex-fu" style={{ animationDelay: '.65s', margin: '14px 0 0', fontSize: 13, color: 'var(--dex-faint)', maxWidth: 420 }}>
            Cloud models work inside an approved folder, so pick one. The playground is fine.
          </p>
        )}
      </Copy>
      <div className="dex-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {existing[0] && (
          <button type="button" className="dex-choice dex-a dex-fu" style={{ animationDelay: '.2s', padding: '16px 18px' }} onClick={() => onUse(existing[0])}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Icon d={I.check} size={20} color="var(--dex-acid)" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600 }}>Keep {baseName(existing[0])}</span>
                <span className="dex-mono" style={{ display: 'block', fontSize: 12, color: 'var(--dex-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {existing[0]}
                </span>
              </span>
            </div>
          </button>
        )}
        <button type="button" className="dex-choice dex-a dex-fu" style={{ animationDelay: '.3s', padding: '16px 18px' }} disabled={busy} onClick={() => void usePlayground()}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon d={I.spark} size={20} color="var(--dex-acid)" />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontWeight: 600 }}>{busy ? 'Making your playground…' : 'Start in a playground'}</span>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--dex-dim)' }}>{playground ?? 'A fresh folder at ~/LocalDex Playground. Good for trying things.'}</span>
            </span>
            <Icon d={I.arrow} size={18} />
          </div>
        </button>

        <div className="dex-glass dex-a dex-fu" style={{ animationDelay: '.4s', padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon d={I.folder} size={20} color="var(--dex-acid)" />
            <span style={{ flex: 1, fontWeight: 600 }}>Use a project folder</span>
            {!browse && (
              <button type="button" className="dex-btn dex-btn-sm dex-btn-line" onClick={() => void load()}>
                Browse
              </button>
            )}
          </div>
          {browse && (
            <div style={{ marginTop: 14 }}>
              <div className="dex-mono" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, fontSize: 12, color: 'var(--dex-dim)' }}>
                <button type="button" className="dex-link" style={{ minHeight: 28, padding: '0 4px', letterSpacing: 0, textTransform: 'none' }} onClick={() => void load('/')}>
                  /
                </button>
                {crumbs.map((c) => (
                  <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <button type="button" className="dex-link" style={{ minHeight: 28, padding: '0 4px', letterSpacing: 0, textTransform: 'none' }} onClick={() => void load(c.path)}>
                      {c.name}
                    </button>
                    /
                  </span>
                ))}
              </div>
              <div className="dex-scroll" style={{ maxHeight: 190, marginTop: 8, gap: 2 }}>
                {browse.dirs.length === 0 && <div style={{ fontSize: 13, color: 'var(--dex-faint)', padding: '6px 4px' }}>No folders inside.</div>}
                {browse.dirs.map((d) => (
                  <button key={d} type="button" className="dex-row" style={{ minHeight: 40, padding: '6px 12px', border: 0 }} onClick={() => void load(`${browse.path.replace(/\/+$/, '')}/${d}`)}>
                    <Icon d={I.folder} size={16} color="var(--dex-dim)" />
                    <span className="dex-mono" style={{ fontSize: 13 }}>
                      {d}
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" className="dex-btn" style={{ width: '100%', marginTop: 12 }} onClick={() => onUse(browse.path)}>
                Use {baseName(browse.path)}
              </button>
            </div>
          )}
          <form
            style={{ display: 'flex', gap: 8, marginTop: 14 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) onUse(typed.trim());
            }}
          >
            <label htmlFor="dex-folder-path" style={{ position: 'absolute', left: -9999 }}>
              Folder path
            </label>
            <input id="dex-folder-path" className="dex-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="or paste a path: ~/projects/my-app" />
            <button type="submit" className="dex-btn dex-btn-sm dex-btn-line" disabled={!typed.trim()}>
              Use
            </button>
          </form>
          {err && <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--dex-danger)' }}>{err}</p>}
        </div>
        {allowSkip && (
          <button type="button" className="dex-link dex-a dex-fi" style={{ animationDelay: '.6s', alignSelf: 'flex-start' }} onClick={() => onUse(null)}>
            Skip for now · just chat →
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 004 Ready ----------

function Ready({
  headRef,
  brain,
  pick,
  statuses,
  folder,
  isPlayground,
  onFinish,
}: {
  headRef: HeadRef;
  brain: Brain | null;
  pick: Pick | null;
  statuses: MemberStatus[];
  folder: string | null;
  isPlayground: boolean;
  onFinish: (prompt?: string) => void;
}) {
  const cloudNames = MEMBER_IDS.filter((id) => usable(statuses.find((s) => s.id === id))).map((id) => CLOUD[id].name);
  const stamps: Array<{ label: string; detail: string; icon: string; skipped?: boolean }> = [
    brain === 'cloud'
      ? { label: 'Cloud', detail: cloudNames.join(', ') || 'Signed in', icon: I.cloud }
      : { label: 'Model', detail: pick?.model ?? 'Local model', icon: I.chip },
    folder ? { label: 'Folder', detail: baseName(folder), icon: I.folder } : { label: 'Folder', detail: 'Chat only for now', icon: I.folder, skipped: true },
    { label: 'Guarded', detail: 'Asks before risky steps', icon: I.shield },
  ];
  const prompts =
    brain === 'cloud'
      ? folder && !isPlayground
        ? ['Explain this project', 'Find TODOs and summarize them', 'Review the README for gaps']
        : ['Plan a one-page to-do app for this folder', '/vote Python or JavaScript for a first project?', 'What can you help me with here?']
      : !folder
        ? ['What can you help me with?', 'Explain recursion with a tiny example', 'Draft a README for a command-line tool']
        : isPlayground
          ? ['Build a one-page to-do app in index.html', 'Write a Python script that renames photos by date', 'Explain what you can do in this folder']
          : ['Explain this project', 'Find TODOs and summarize them', 'Summarize the README'];

  return (
    <div className="dex-stage" style={{ flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
      <div className="dex-kicker dex-a dex-fi" style={{ animationDelay: '.1s' }}>
        All entries collected
      </div>
      <h2 id="dex-h" ref={headRef} tabIndex={-1} className="dex-h" style={{ fontSize: 'clamp(56px, 7vw, 100px)', lineHeight: 1 }}>
        <span className="dex-ln">
          <span style={{ animationDelay: '.2s' }}>
            Your Dex is <span className="dex-em">ready.</span>
          </span>
        </span>
      </h2>
      <div style={{ display: 'flex', gap: 18, marginTop: 34, flexWrap: 'wrap', justifyContent: 'center' }}>
        {stamps.map((s, i) => (
          <div key={s.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, transform: `rotate(${[-5, 3, -3][i]}deg)`, width: 190 }}>
            <div className="dex-stamp dex-a dex-thud" data-skipped={!!s.skipped} style={{ animationDelay: `${0.9 + i * 0.3}s` }}>
              <Icon d={s.icon} size={34} color={s.skipped ? 'var(--dex-faint)' : 'var(--dex-acid)'} />
            </div>
            <div className="dex-a dex-fi" style={{ animationDelay: `${1.2 + i * 0.3}s` }}>
              <div className="dex-label" style={{ color: 'var(--dex-soft)' }}>
                {s.label}
              </div>
              <div className="dex-mono" style={{ fontSize: 12, color: 'var(--dex-dim)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 190 }}>
                {s.detail}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="dex-a dex-fu" style={{ animationDelay: '2s', marginTop: 40, width: '100%', maxWidth: 640 }}>
        <div className="dex-label" style={{ marginBottom: 12 }}>
          Try one to start
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {prompts.map((p) => (
            <button key={p} type="button" className="dex-btn dex-btn-sm dex-btn-line" style={{ minHeight: 44, fontWeight: 400 }} onClick={() => onFinish(p)}>
              {p}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 28 }}>
          <button type="button" className="dex-btn" onClick={() => onFinish()}>
            Start chatting <Icon d={I.arrow} size={18} />
          </button>
        </div>
        {brain === 'cloud' && (
          <p style={{ margin: '18px 0 0', fontSize: 13, color: 'var(--dex-faint)' }}>Cloud models start read-only. Allow edits any time in Settings → Council.</p>
        )}
      </div>
    </div>
  );
}
