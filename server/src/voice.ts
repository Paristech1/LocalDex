// E6: voice input with a local speech-to-text engine (whisper.cpp). The browser records, LocalDex converts the
// audio with ffmpeg and transcribes it on this machine; the text goes into the composer for review, never sent
// by itself. Nothing leaves the computer. Commands come from PATH or ~/.localdex/config.json (never the UI).
// Pattern from DeepSeek Harness speech-to-text-sensevoice + client-ui-voice-input (local worker, reviewable draft).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VoiceStatus } from '@localdex/shared';
import { DATA_DIR, expandHome, getSettings } from './config.js';
import { onPath } from './lsp.js';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const WHISPER_BINS = ['whisper-cli', 'whisper-cpp', 'whisper'];

function ffmpegBin(): string | null {
  const env = process.env.LOCALDEX_FFMPEG;
  if (env) return onPath(env) ? env : null;
  return onPath('ffmpeg') ? 'ffmpeg' : null;
}

function whisperBin(): string | null {
  const env = process.env.LOCALDEX_WHISPER ?? getSettings().voice?.command;
  if (env) return onPath(expandHome(env)) ? expandHome(env) : null;
  return WHISPER_BINS.find((b) => onPath(b)) ?? null;
}

/** The model file: the configured one, else the first ggml-*.bin in ~/.localdex/models. */
function modelPath(): string | null {
  const configured = getSettings().voice?.model;
  if (configured) {
    const p = path.resolve(expandHome(configured));
    return fs.existsSync(p) ? p : null;
  }
  const dir = path.join(DATA_DIR, 'models');
  try {
    const f = fs.readdirSync(dir).filter((x) => /^ggml-.*\.bin$/.test(x)).sort()[0];
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

export function voiceStatus(): VoiceStatus {
  const ffmpeg = ffmpegBin();
  const whisper = whisperBin();
  const model = modelPath();
  const missing: string[] = [];
  if (!ffmpeg) missing.push('ffmpeg (`brew install ffmpeg`)');
  if (!whisper) missing.push('whisper.cpp (`brew install whisper-cpp`)');
  if (!model) missing.push(`a model file in ${path.join(DATA_DIR, 'models')} (e.g. ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp)`);
  return missing.length ? { available: false, missing } : { available: true, model: path.basename(model!) };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/** whisper.cpp prints "[00:00:00.000 --> 00:00:02.000]  text" unless -nt; strip any timestamps and join lines. */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '').trim())
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SOUND)\]$/i.test(l) && !/^\((music|silence|noise)\)$/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Transcribe recorded audio (any format ffmpeg reads). Temp files are removed afterwards. */
export async function transcribe(audio: Buffer): Promise<string> {
  if (!audio.length) throw new Error('No audio.');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('Recording is too long (over 25 MB).');
  const st = voiceStatus();
  if (!st.available) throw new Error(`Voice input needs: ${st.missing!.join('; ')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localdex-voice-'));
  try {
    const inFile = path.join(dir, 'in.audio');
    const wav = path.join(dir, 'in.wav');
    fs.writeFileSync(inFile, audio);
    const conv = await run(ffmpegBin()!, ['-y', '-loglevel', 'error', '-i', inFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60_000);
    if (conv.code !== 0 || !fs.existsSync(wav)) throw new Error(`ffmpeg could not read the recording: ${conv.err.split('\n')[0]}`);
    const lang = getSettings().voice?.language ?? 'auto';
    const w = await run(whisperBin()!, ['-m', modelPath()!, '-f', wav, '-nt', '-np', '-l', lang], 180_000);
    if (w.code !== 0) throw new Error(`whisper.cpp failed: ${w.err.split('\n').filter(Boolean).pop() ?? `exit ${w.code}`}`);
    return cleanTranscript(w.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
