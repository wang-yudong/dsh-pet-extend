/**
 * 随插件打包的模型：路径声明、完整性检查与补装（下载/解压）。
 * 正常安装时模型已在 models/ 目录里；设置页可调用 installModels() 修复或升级。
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS_DIR = join(PACKAGE_ROOT, 'models');
export const KWS_MODEL_DIR = join(MODELS_DIR, 'kws');
export const KWS_ARCHIVE_NAME = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
export const KWS_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/' + KWS_ARCHIVE_NAME + '.tar.bz2';
export const SPEAKER_MODEL_DIR = join(MODELS_DIR, 'speaker');
export const SPEAKER_MODEL_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const SPEAKER_MODEL_PATH = join(SPEAKER_MODEL_DIR, SPEAKER_MODEL_FILE);
export const SPEAKER_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/' + SPEAKER_MODEL_FILE;

/** 只保留 int8 transducer 三件套、词表与官方示例关键词。 */
export const KWS_KEEP_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
  'keywords.txt',
  'keywords_raw.txt',
];
const KWS_REQUIRED = [...KWS_KEEP_FILES.slice(0, 3), 'tokens.txt'];

const installState = {
  running: false,
  phase: 'idle',
  error: null,
  startedAt: null,
  finishedAt: null,
};

export function installStatus() {
  return { ...installState, ...modelStatus() };
}

export function modelStatus() {
  const kwsFiles = KWS_REQUIRED.map((file) => ({
    file,
    present: existsSync(join(KWS_MODEL_DIR, file)),
  }));
  const kwsComplete = kwsFiles.every((item) => item.present);
  const speakerPresent = existsSync(SPEAKER_MODEL_PATH);
  let sizeMB = 0;
  for (const file of [...KWS_KEEP_FILES.map((name) => join(KWS_MODEL_DIR, name)), SPEAKER_MODEL_PATH]) {
    if (existsSync(file)) sizeMB += statSync(file).size / 1048576;
  }
  return {
    kwsDir: KWS_MODEL_DIR,
    kwsComplete,
    kwsFiles,
    speakerPath: SPEAKER_MODEL_PATH,
    speakerPresent,
    complete: kwsComplete && speakerPresent,
    sizeMB: Number(sizeMB.toFixed(2)),
  };
}

async function download(url, target, onProgress, label) {
  mkdirSync(dirname(target), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${label} 下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    received += chunk.length;
    onProgress({ label, received, total });
  });
  await pipeline(stream, createWriteStream(target));
  if (total > 0 && received < total) throw new Error(`${label} 下载不完整（${received}/${total} 字节）`);
  return target;
}

function installKwsArchive(archive, workDir) {
  const extracted = join(workDir, 'extracted');
  mkdirSync(extracted, { recursive: true });
  execFileSync('tar', ['-xjf', archive, '-C', extracted], { stdio: 'ignore' });
  const root = join(extracted, KWS_ARCHIVE_NAME);
  if (!existsSync(root)) throw new Error('KWS 压缩包结构与预期不符');
  mkdirSync(KWS_MODEL_DIR, { recursive: true });
  for (const file of KWS_KEEP_FILES) copyFileSync(join(root, file), join(KWS_MODEL_DIR, file));
}

/** 补装/升级模型。调用方一般不等它完成，用 installStatus() 轮询进度。 */
export async function installModels({ force = false, onProgress = () => {} } = {}) {
  if (installState.running) return { ok: false, reason: 'already-running' };
  if (!force && modelStatus().complete) return { ok: true, skipped: true };
  Object.assign(installState, {
    running: true, phase: 'starting', error: null, startedAt: Date.now(), finishedAt: null,
  });
  const workDir = join(tmpdir(), 'dsh-pet-extend-models-' + Date.now());
  try {
    mkdirSync(workDir, { recursive: true });
    if (force || !modelStatus().kwsComplete) {
      installState.phase = 'downloading-kws';
      const archive = await download(KWS_MODEL_URL, join(workDir, 'kws.tar.bz2'), onProgress, 'KWS 模型');
      installState.phase = 'extracting-kws';
      installKwsArchive(archive, workDir);
    }
    if (force || !existsSync(SPEAKER_MODEL_PATH)) {
      installState.phase = 'downloading-speaker';
      const tmpSpeaker = await download(SPEAKER_MODEL_URL, join(workDir, SPEAKER_MODEL_FILE), onProgress, '声纹模型');
      mkdirSync(SPEAKER_MODEL_DIR, { recursive: true });
      copyFileSync(tmpSpeaker, SPEAKER_MODEL_PATH);
    }
    installState.phase = 'done';
    return { ok: true, skipped: false, ...modelStatus() };
  } catch (error) {
    installState.phase = 'error';
    installState.error = String(error?.message ?? error);
    return { ok: false, reason: installState.error };
  } finally {
    installState.running = false;
    installState.finishedAt = Date.now();
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function listModelFiles() {
  if (!existsSync(MODELS_DIR)) return [];
  return readdirSync(MODELS_DIR, { withFileTypes: true }).map((entry) => entry.name);
}
