/**
 * 宿主半侧：sherpa-onnx KWS（keyword spotting）语音唤醒引擎。
 *
 * 客户端浏览器采集麦克风并上传 16kHz 单声道 Int16LE PCM，本模块把 PCM 流式喂给
 * sherpa-onnx-node 的 KeywordSpotter；命中关键词后回调 onDetect，由 index.js 复用
 * 原有的 menu-event 通道让客户端打开 dsh-pet 的 pet-chat 标签。
 *
 * sherpa-onnx-node 是可选依赖：未安装时引擎进入 error 状态并给出安装指引，
 * 不影响原有的右键菜单功能。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { KWS_MODEL_DIR, KWS_MODEL_URL, MODELS_DIR, SPEAKER_MODEL_PATH } from './models.js';

export const KWS_SAMPLE_RATE = 16000;
export const KWS_CHUNK_SAMPLES = 1600;
export const SPEAKER_WINDOW_SAMPLES = KWS_SAMPLE_RATE * 3;
/** 正式监听最近音频的保留窗口：设置页可回放，用来对比「按住测试」与真实监听收到的声音。 */
const LISTEN_WINDOW_SAMPLES = KWS_SAMPLE_RATE * 6;
export const DEFAULT_MODEL_NAME = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
export const MODEL_DOWNLOAD_URL = KWS_MODEL_URL;

/**
 * 从滚动缓冲里截出「刚触发这次检测的那句唤醒词」，用于声纹比对。
 *
 * 为什么不是「取最响的一段」：唤醒词不一定最响，也可能被环境声/回放音盖过，取最响不能保证
 * 对齐到唤醒词。检测时刻是确定的——唤醒词刚好结束在缓冲末尾，所以：
 *   1) 按唤醒词字数估算这段语音最长多久（cap），只回看这么长；
 *   2) 在窗口内做 20ms 帧能量端点检测，从末尾回溯到最近一段持续静音（≥120ms），
 *      那就是这句唤醒词的起点（念完通常会停一下）；
 *   3) 太短则向前补到约 0.6 秒（声纹 embedding 的最小可用长度），但不会无限扩张。
 *
 * @param {Float32Array} samples 最近的滚动音频（本插件约 3 秒）
 * @param {string} keyword 本次命中的唤醒词，用于估时长
 * @param {number} [sampleRate]
 * @returns {Float32Array} 与本次触发对齐的一段音频
 */
export function extractUtterance(samples, keyword, sampleRate = KWS_SAMPLE_RATE) {
  const data = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  if (data.length === 0) return data;
  const chars = Math.max(1, [...String(keyword ?? '').replace(/\s+/g, '')].length);
  const capMs = Math.min(2600, 600 + chars * 450);
  const capLen = Math.floor((sampleRate * capMs) / 1000);
  const end = data.length;
  const from = Math.max(0, end - capLen);
  const frame = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms
  const frames = Math.floor((end - from) / frame);
  const minLen = Math.floor(sampleRate * 0.6); // 声纹比对至少约 0.6 秒
  if (frames < 4) return data.subarray(from, end);

  const energy = new Float32Array(frames);
  let maxEnergy = 0;
  for (let f = 0; f < frames; f += 1) {
    const start = from + f * frame;
    let sum = 0;
    for (let i = start; i < start + frame; i += 4) sum += data[i] * data[i];
    energy[f] = sum;
    if (sum > maxEnergy) maxEnergy = sum;
  }
  if (maxEnergy <= 1e-9) {
    // 整段静音：没有可对齐的语音，退回最近约 1 秒（交给声纹判定，通常会被拒）。
    return data.subarray(Math.max(0, end - Math.max(minLen, Math.floor(sampleRate * 1.0))), end);
  }
  // floor 取最强帧的 8%：对底噪自适应，避免把轻声唤醒词当静音。
  const floor = Math.max(1e-6, maxEnergy * 0.08);

  let last = frames - 1;
  while (last > 0 && energy[last] < floor) last -= 1;
  let first = last;
  let silenceRun = 0;
  for (let f = last; f >= 0; f -= 1) {
    if (energy[f] < floor) {
      silenceRun += 1;
      if (silenceRun >= 6) {
        first = f + silenceRun;
        break;
      }
    } else {
      silenceRun = 0;
      first = f;
    }
  }

  let startSample = from + first * frame;
  const endSample = from + (last + 1) * frame;
  if (endSample - startSample < minLen) startSample = Math.max(from, endSample - minLen);
  if (endSample <= startSample) return data.subarray(from, end);
  return data.subarray(startSample, Math.min(end, endSample));
}

const INSTALL_HINT =
  '1) 在插件目录执行 npm install sherpa-onnx-node；2) 模型缺失时在设置页点「重新安装模型」或运行 npm run install:models；3) POST /api/kws/retry 重新初始化';

const boolOf = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
  return fallback;
};
const numOf = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const optionalNum = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const arrayOf = (value) => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // 非 JSON 时按逗号分隔
    }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

function scanFiles(root, depth = 2) {
  const out = [];
  const walk = (dir, prefix, left) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (left > 0) walk(join(dir, entry.name), rel, left - 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root, '', depth);
  return out;
}

/** 在模型目录里找 transducer 三件套与 tokens.txt；有配套的 int8 版本时优先选用。 */
export function findModelFiles(modelDir) {
  if (!modelDir || !existsSync(modelDir)) return null;
  const files = scanFiles(modelDir);
  const onnx = files.filter((file) => /\.onnx$/i.test(file));
  const pick = (pattern) => {
    const matched = onnx.filter((file) => pattern.test(basename(file)));
    return {
      fp32: matched.find((file) => !/int8/i.test(file)),
      int8: matched.find((file) => /int8/i.test(file)),
    };
  };
  const encoder = pick(/encoder/i);
  const decoder = pick(/decoder/i);
  const joiner = pick(/joiner/i);
  const tokens = files.find((file) => basename(file).toLowerCase() === 'tokens.txt');
  const useInt8 = Boolean(encoder.int8 && decoder.int8 && joiner.int8);
  const chosen = useInt8
    ? [encoder.int8, decoder.int8, joiner.int8]
    : [encoder.fp32, decoder.fp32, joiner.fp32];
  if (!tokens || chosen.some((file) => !file)) return null;
  return {
    encoder: join(modelDir, chosen[0]),
    decoder: join(modelDir, chosen[1]),
    joiner: join(modelDir, chosen[2]),
    tokens: join(modelDir, tokens),
    variant: useInt8 ? 'int8' : 'fp32',
  };
}

function findKeywordsFile(modelDir) {
  if (!modelDir) return '';
  const candidates = [
    join(modelDir, 'keywords.txt'),
    join(modelDir, 'test_wavs', 'test_keywords.txt'),
  ];
  for (const file of scanFiles(modelDir)) {
    if (basename(file).toLowerCase() === 'keywords.txt') candidates.push(join(modelDir, file));
  }
  return candidates.find((file) => existsSync(file)) ?? '';
}

/** 从 keywords 文件里提取 @别名（没有别名时取第一个 token），仅用于诊断展示。 */
export function readKeywords(file) {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const at = line.lastIndexOf('@');
        return at >= 0 ? line.slice(at + 1).trim() : line.split(/\s+/)[0];
      });
  } catch {
    return [];
  }
}

/**
 * 音频幅度全程原样透传：不做任何自动增益/降增益，麦克风电平完全由用户和操作系统决定。
 * 客户端只做抗混叠重采样与 Int16 编码，服务端把原始 PCM 同时喂给 KeywordSpotter 与声纹校验。
 */

/** 拼接并保留最近 limit 个 16kHz 采样，供唤醒命中时的声纹校验使用。 */
function appendTail(previous, samples, limit) {
  const keep = Math.max(0, limit - samples.length);
  const head = previous.length > keep ? previous.subarray(previous.length - keep) : previous;
  const merged = new Float32Array(head.length + samples.length);
  merged.set(head, 0);
  merged.set(samples, head.length);
  return merged;
}

/** 配置来源：插件 config.kws > 设置页 settings > 环境变量 > 随包默认模型。 */
export function resolveKwsConfig(config = {}, env = process.env, settings = {}) {
  const raw = config?.kws;
  if (raw === false || raw === null || raw === 'off') {
    return {
      enabled: false,
      // 禁用引擎不等于没有模型：设置页的声纹录入与关键词生成仍要用随包模型。
      modelDir: KWS_MODEL_DIR,
      keywordsFile: '',
      speakerModel: SPEAKER_MODEL_PATH,
      cooldownMs: 1500,
      sessionTimeoutMs: 30000,
      maxAudioBytes: 256 * 1024,
      wakeKeywords: [],
      keywordLines: [],
      modulePath: '',
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    };
  }
  const kws = raw && typeof raw === 'object' ? raw : {};
  const user = settings && typeof settings === 'object' ? settings : {};
  const explicitDir = kws.modelDir ?? user.modelDir ?? env.DSH_PET_KWS_MODEL_DIR;
  const modelDir = explicitDir
    ? resolve(String(explicitDir))
    : [KWS_MODEL_DIR, MODELS_DIR].find((dir) => Boolean(findModelFiles(dir))) ?? KWS_MODEL_DIR;
  const explicitKeywords = kws.keywordsFile ?? env.DSH_PET_KWS_KEYWORDS_FILE;
  const keywordsFile = explicitKeywords ? resolve(String(explicitKeywords)) : findKeywordsFile(modelDir);
  const flag = kws.enabled ?? env.DSH_PET_KWS_ENABLED ?? user.enabled;
  return {
    // 模型随包存在也不能自动开启：必须在设置页录入声纹后主动启用。
    enabled: flag === undefined ? false : boolOf(flag, false),
    modelDir,
    keywordsFile,
    speakerModel: kws.speakerModel ?? user.speakerModel ?? env.DSH_PET_KWS_SPEAKER_MODEL ?? SPEAKER_MODEL_PATH,
    modulePath: kws.modulePath ?? user.modulePath ?? env.DSH_PET_KWS_MODULE_PATH ?? '',
    keywordLines: arrayOf(kws.keywordLines ?? user.keywordLines ?? env.DSH_PET_KWS_KEYWORD_LINES),
    wakeKeywords: arrayOf(kws.wakeKeywords ?? env.DSH_PET_KWS_WAKE_KEYWORDS),
    numThreads: numOf(kws.numThreads ?? user.numThreads ?? env.DSH_PET_KWS_NUM_THREADS, 1),
    provider: String(kws.provider ?? user.provider ?? env.DSH_PET_KWS_PROVIDER ?? 'cpu'),
    debug: boolOf(kws.debug ?? user.debug ?? env.DSH_PET_KWS_DEBUG, false),
    // 实测（真实 int8 模型 + 用户本机录音，同一段音频）：maxActivePaths=4/8 全部漏检，
    // 16 在 blanks 2/4/8 下都能检出。3.3M 小模型开 16 路活跃路径的 CPU 开销可接受，取 16。
    // numTrailingBlanks 提高后，关键词末尾会多等几帧静音再确认，减少「说完了但没吐词」。
    maxActivePaths: optionalNum(kws.maxActivePaths) ?? 16,
    numTrailingBlanks: optionalNum(kws.numTrailingBlanks) ?? 4,
    // 设置页的灵敏度以前只写进 keywords.txt 行内，引擎全局阈值仍是默认 0.25；
    // 部分 sherpa-onnx 版本以全局值优先，导致「调了灵敏度没反应」。这里两条路都接上。
    keywordsScore: optionalNum(kws.keywordsScore ?? user.keywordsScore),
    keywordsThreshold: optionalNum(kws.keywordsThreshold ?? user.keywordsThreshold),
    cooldownMs: numOf(kws.cooldownMs ?? user.cooldownMs ?? env.DSH_PET_KWS_COOLDOWN_MS, 1500),
    sessionTimeoutMs: numOf(kws.sessionTimeoutMs ?? env.DSH_PET_KWS_SESSION_TIMEOUT_MS, 30000),
    maxAudioBytes: numOf(kws.maxAudioBytes, 256 * 1024),
    loadModule: typeof kws.loadModule === 'function' ? kws.loadModule : undefined,
  };
}

function materializeKeywords(config) {
  if (config.keywordsFile && existsSync(config.keywordsFile)) return config.keywordsFile;
  if (!config.keywordLines?.length) return '';
  const target = config.modelDir && existsSync(config.modelDir)
    ? join(config.modelDir, 'dsh-pet-keywords.txt')
    : join(tmpdir(), 'dsh-pet-extend-keywords.txt');
  writeFileSync(target, config.keywordLines.join('\n') + '\n', 'utf8');
  return target;
}

/** 用指定 boost/threshold 重写词表行内值，供「参数归因」临时探测使用。 */
function keywordsWithValues(file, boost, threshold) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const next = lines.map((line) => {
    const at = line.indexOf('@');
    const head = at >= 0 ? line.slice(0, at) : line;
    const tail = at >= 0 ? line.slice(at) : '';
    const tokens = head
      .replace(/:\s*[\d.]+\s*/g, ' ')
      .replace(/#\s*[\d.]+\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return tokens + ' :' + boost + ' #' + threshold + (tail ? ' ' + tail : '');
  });
  const target = join(tmpdir(), `dsh-kws-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(target, next.join('\n') + '\n', 'utf8');
  return target;
}

function buildSherpaConfig(config, files, keywordsFile) {
  const result = {
    featConfig: { sampleRate: KWS_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: config.numThreads,
      provider: config.provider,
      debug: config.debug ? 1 : 0,
    },
    keywordsFile,
  };
  for (const key of ['maxActivePaths', 'numTrailingBlanks', 'keywordsScore', 'keywordsThreshold']) {
    if (typeof config[key] === 'number' && Number.isFinite(config[key])) result[key] = config[key];
  }
  return result;
}

/** 同步加载可选依赖，声纹模块与 KWS 共用（Windows 自动补 DLL 搜索路径）。 */
export function loadSherpaModule({ modulePath } = {}) {
  const require = createRequire(import.meta.url);
  let resolved;
  try {
    if (modulePath) {
      const abs = resolve(String(modulePath));
      try {
        resolved = require.resolve('sherpa-onnx-node', { paths: [abs, dirname(abs)] });
      } catch {
        resolved = require.resolve(abs);
      }
    } else {
      resolved = require.resolve('sherpa-onnx-node');
    }
  } catch {
    throw new Error(
      '找不到 sherpa-onnx-node：请在插件目录执行 npm install sherpa-onnx-node，' +
      '或用 DSH_PET_KWS_MODULE_PATH 指向它所在的目录',
    );
  }
  if (process.platform === 'win32') {
    const pkgDir = dirname(resolved);
    for (const dir of [join(pkgDir, 'lib'), pkgDir]) {
      if (existsSync(dir) && !(process.env.PATH ?? '').includes(dir)) {
        process.env.PATH = dir + delimiter + (process.env.PATH ?? '');
      }
    }
  }
  const mod = require(resolved);
  return mod?.default ?? mod;
}

/**
 * 创建 KWS 引擎。返回的接口全部同步（除 start/retry），便于在 HTTP handler 里直接使用。
 * loadModule 可注入，用于测试或替换其它 sherpa-onnx 后端。
 */
export function createKwsEngine({
  config = resolveKwsConfig(),
  loadModule = loadSherpaModule,
  log = () => {},
  warn = () => {},
  onDetect = () => {},
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  const state = {
    enabled: Boolean(config.enabled),
    state: config.enabled ? 'idle' : 'disabled',
    reason: null,
    hint: null,
    backend: 'sherpa-onnx-node',
    modelDir: config.modelDir || null,
    modelVariant: null,
    keywordsFile: config.keywordsFile || null,
    keywords: [],
    sampleRate: KWS_SAMPLE_RATE,
    chunkSamples: KWS_CHUNK_SAMPLES,
    // 当前并行的 boost 档位，设置页诊断会显示。
    boosts: [],
    cooldownMs: config.cooldownMs,
    // 引擎重建次数：设置页用它确认「重新初始化」真的发生过，而不是只看到状态一直是 ready。
    restarts: 0,
    detections: 0,
    triggers: 0,
    speakerRejections: 0,
    audioChunks: 0,
    audioBytes: 0,
    decodedChunks: 0,
    noKeywordChunks: 0,
    skips: {},
    lastSkipReason: null,
    lastSkipAt: null,
    lastDecodeAt: null,
    lastAudioAt: null,
    lastPeak: 0,
    maxPeak: 0,
    avgPeak: 0,
    // 最近约 2 秒里「有声音的块」占比：能看出采集端是不是把持续语音吃掉了。
    voiceRatio: 0,
    lastRms: 0,
    lastDetection: null,
    lastVerification: null,
    client: null,
    listeningEnabled: true,
  };
  // 并行多档：同一句唤醒词在不同语速/节奏下的最优 keywordsScore 会漂移（实测同一段录音
  // boost 2 全线命中、boost 3 全灭，另一段恰好相反），单档必然漏一批。同时跑几档，任一吐词即触发。
  let spotters = [];
  // 每一档 boost 需要自己的词表文件（行内值不同），重建时统一清理。
  let keywordTmpFiles = [];
  let loading = null;
  let stopped = false;
  // 每次 reload 递增：正在进行的旧加载完成后不得把旧实例写回，覆盖新重建的引擎。
  let generation = 0;
  // 正式监听最近 6 秒音频（不含测试会话），供设置页回放对比。
  let listenBuffer = new Float32Array(0);
  let verifier = null;
  let lastTriggerAt = -Infinity;
  let lastStartAttemptAt = 0;

  /**
   * 并行档位：以用户设置的 keywordsScore 为中心，固定带上 1.5 / 2 / 2.5。
   * 实测（4 种节奏 × 5 种语速 × 3 种音量 = 60 组）：单档 2/0.25 覆盖 57/60；
   * 1.5+2+2.5 三档并行 60/60；去掉 1.5 只留 2+2.5+3 掉到 58/60 —— 低档必须保留。
   */
  function keywordBoosts(score) {
    const base = Number(score) || 2;
    const set = new Set([1.5, 2, 2.5]);
    if (base > 0 && base <= 5) set.add(Math.round(base * 2) / 2);
    return [...set].sort((a, b) => a - b);
  }

  function cleanupKeywordFiles() {
    for (const file of keywordTmpFiles) {
      try { rmSync(file, { force: true }); } catch {}
    }
    keywordTmpFiles = [];
  }

  function status() {
    return {
      ...state,
      boosts: spotters.map((item) => item.boost),
      sessions: sessions.size,
      ready: state.state === 'ready',
      wakeWords: state.keywords,
      readyToListen: state.state === 'ready' && state.enabled && state.listeningEnabled,
    };
  }

  /** 注入声纹校验函数：(Float32Array) => { ok, score, reason }。 */
  function setVerifier(fn) {
    verifier = typeof fn === 'function' ? fn : null;
  }

  function setListeningEnabled(value) {
    state.listeningEnabled = value !== false;
  }

  function updateConfig(patch) {
    Object.assign(config, patch && typeof patch === 'object' ? patch : {});
    Object.assign(state, {
      enabled: Boolean(config.enabled),
      modelDir: config.modelDir || null,
      cooldownMs: config.cooldownMs,
    });
    if (state.enabled && state.state === 'disabled') state.state = 'idle';
  }

  /** 重建结果：让 HTTP 层能等到真正结束，并把成功/失败与原因如实回给设置页。 */
  function restartResult(ok) {
    return {
      ok,
      state: state.state,
      ready: state.state === 'ready',
      enabled: state.enabled,
      reason: ok ? null : (state.reason ?? (state.enabled ? 'engine-not-ready' : 'disabled')),
      hint: ok ? null : state.hint,
      keywords: state.keywords,
      keywordsFile: state.keywordsFile,
      restarts: state.restarts,
      sessions: sessions.size,
    };
  }

  /**
   * 设置变更后重建 KeywordSpotter（keywordsFile / 阈值变化需要重新读文件）。
   * 同步部分就让旧引擎与旧会话一起失效，避免重建窗口里用旧 spotter 开出「永远解不出词」的流；
   * 返回 Promise，调用方可以 await 后拿到真实的重建结果。
   */
  async function reload(keywordsFile) {
    for (const entry of sessions.values()) clearTimeout(entry.timer);
    sessions.clear();
    if (keywordsFile) {
      config.keywordsFile = keywordsFile;
      state.keywordsFile = keywordsFile;
    }
    generation += 1;
    spotters = [];
    cleanupKeywordFiles();
    state.restarts += 1;
    state.state = state.enabled ? 'loading' : 'disabled';
    state.reason = null;
    state.hint = null;
    if (stopped || !state.enabled) return restartResult(false);
    if (loading) await loading;
    if (stopped) return restartResult(false);
    return restartResult(await start());
  }

  async function start() {
    if (stopped || !state.enabled || spotters.length) return spotters.length > 0;
    if (loading) return loading;
    const gen = generation;
    loading = (async () => {
      state.state = 'loading';
      state.reason = null;
      state.hint = null;
      // 本次构建产生的临时词表：成功就转正，失败或过期必须删掉，不能留在磁盘上。
      let localFiles = [];
      try {
        if (!config.modelDir || !existsSync(config.modelDir)) {
          throw new Error('模型目录不存在：' + (config.modelDir || '(未设置)'));
        }
        const files = findModelFiles(config.modelDir);
        if (!files) throw new Error('模型目录缺少 encoder/decoder/joiner 的 .onnx 或 tokens.txt');
        const keywordsFile = materializeKeywords(config);
        if (!keywordsFile || !existsSync(keywordsFile)) throw new Error('未找到 keywords.txt（可用 DSH_PET_KWS_KEYWORDS_FILE 指定）');
        const mod = await loadModule({ modulePath: config.modulePath });
        const KeywordSpotter = mod?.KeywordSpotter ?? mod?.default?.KeywordSpotter;
        if (typeof KeywordSpotter !== 'function') throw new Error('sherpa-onnx-node 未导出 KeywordSpotter');
        // 每一档 boost 各生成一份词表（行内值不同）并各建一个 KeywordSpotter；
        // 音频同时喂给所有实例，任一吐词即触发，覆盖不同语速/节奏/音量。
        const boosts = keywordBoosts(config.keywordsScore);
        const created = boosts.map((boost) => {
          const file = keywordsWithValues(keywordsFile, boost, config.keywordsThreshold);
          localFiles.push(file);
          const instance = new KeywordSpotter(buildSherpaConfig(
            { ...config, keywordsScore: boost }, files, file,
          ));
          if (typeof instance.createStream !== 'function') throw new Error('KeywordSpotter 缺少 createStream');
          return { boost, spotter: instance };
        });
        // reload 期间旧加载可能才完成，不能让它覆盖刚重建出来的新引擎。
        if (gen !== generation) {
          for (const file of localFiles) { try { rmSync(file, { force: true }); } catch {} }
          return false;
        }
        cleanupKeywordFiles();
        keywordTmpFiles = localFiles;
        localFiles = [];
        spotters = created;
        state.keywordsFile = keywordsFile;
        state.keywords = readKeywords(keywordsFile);
        state.modelVariant = files.variant;
        state.boosts = boosts;
        state.state = 'ready';
        log(`KWS 就绪：${files.variant} 模型，唤醒词 ${state.keywords.join('/') || '(未解析)'}，并行档位 ${boosts.join('/')}`);
        return true;
      } catch (error) {
        for (const file of localFiles) { try { rmSync(file, { force: true }); } catch {} }
        if (gen !== generation) return false;
        state.state = 'error';
        state.reason = String(error?.message ?? error);
        state.hint = INSTALL_HINT;
        warn('KWS 初始化失败：' + state.reason);
        return false;
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  /** 每一路并行 spotter 各建一条流；数量不匹配（刚 reload 过）时整体重建。 */
  function ensureStreams(entry) {
    if (entry.streams && entry.streams.length === spotters.length) return true;
    try {
      entry.streams = spotters.map((item) => item.spotter.createStream());
      return true;
    } catch (error) {
      entry.streams = null;
      warn('创建 KWS 流失败：' + String(error?.message ?? error));
      return false;
    }
  }

  function armTimer(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => closeSession(entry.id), config.sessionTimeoutMs);
    entry.timer.unref?.();
  }

  function closeSession(id) {
    const entry = sessions.get(id);
    if (!entry) return { ok: false, reason: 'session-not-found' };
    clearTimeout(entry.timer);
    sessions.delete(id);
    return { ok: true };
  }

  /**
   * options.test=true 开「测试会话」：与真实监听走完全相同的解码与声纹校验，
   * 但不计入诊断计数、不受冷却限制、不触发 onDetect（不会打开对话/朗读）。
   */
  function openSession(options = {}) {
    if (!spotters.length) return { ok: false, reason: state.state === 'error' ? 'engine-error' : 'engine-not-ready' };
    if (sessions.size >= 4) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) closeSession(oldest.id);
    }
    const id = randomUUID();
    const entry = {
      id,
      // 不在建会话时创建流：sherpa-onnx 的 KeywordStream 需要「创建后立刻 acceptWaveform」，
      // 先建流再等音频（哪怕只隔几毫秒）会让 isReady 恒 false，表现为「引擎在解码但永不吐词」。
      // 真正的流在 handleAudio 第一次拿到音频时创建（见 ensureStreams）。
      // 并行多档时每个会话持有与 spotters 一一对应的多条流。
      streams: null,
      lastSeen: now(),
      timer: null,
      // 测试会话预填 3 秒静音作上下文：真实监听已有滚动缓冲，按住录音是从零开始，
      // 不补的话声纹会因「对齐段不足 0.5 秒」被判 audio-too-short，与真实链路不一致。
      recent: options.test === true ? new Float32Array(SPEAKER_WINDOW_SAMPLES) : new Float32Array(0),
      test: options.test === true,
    };
    sessions.set(id, entry);
    armTimer(entry);
    return {
      ok: true,
      sessionId: id,
      sampleRate: KWS_SAMPLE_RATE,
      chunkSamples: KWS_CHUNK_SAMPLES,
      cooldownMs: config.cooldownMs,
    };
  }

  /** 记录「音频到了但引擎没跑到解码」的原因，诊断才能区分静音、会话失效与引擎异常。 */
  function fail(reason, silent = false) {
    if (!silent) {
      state.skips[reason] = (state.skips[reason] || 0) + 1;
      state.lastSkipReason = reason;
      state.lastSkipAt = now();
    }
    return { ok: false, reason };
  }

  function noteSkip(reason, silent = false) {
    if (silent) return;
    state.lastSkipReason = reason;
    state.lastSkipAt = now();
  }

  /** 输入 16kHz 单声道 Int16LE PCM；每次调用后按 isReady/decode 循环取检测结果。 */
  function handleAudio(id, buffer) {
    const entry = sessions.get(id);
    const isTest = entry?.test === true;
    // 先记「收到了多少音频、峰值多大」：不管会话是否有效都算，便于区分「没上传 / 上传但静音 / 正常」。
    // 测试会话不计入真实诊断，避免「按住测试」把电平/解码统计冲掉。
    if (!isTest && Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length % 2 === 0) {
      state.audioChunks += 1;
      state.audioBytes += buffer.length;
      state.lastAudioAt = now();
      let peak = 0;
      let sumSq = 0;
      const count = buffer.length / 2;
      for (let i = 0; i + 1 < buffer.length; i += 2) {
        const v = buffer.readInt16LE(i) / 32768;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
        sumSq += v * v;
      }
      state.lastPeak = peak;
      state.lastRms = Math.sqrt(sumSq / count);
      // maxPeak 是历史最大（设置页沿用），avgPeak 才反映「最近这段时间」的真实电平。
      if (peak > state.maxPeak) state.maxPeak = peak;
      state.avgPeak = state.avgPeak ? state.avgPeak * 0.9 + peak * 0.1 : peak;
      state.voiceRatio = state.voiceRatio * 0.95 + (peak >= 0.01 ? 0.05 : 0);
    }
    if (!entry) return fail('session-not-found', isTest);
    armTimer(entry);
    if (!spotters.length) {
      // 自我恢复：reload / 初始化失败后引擎会变空，客户端此时仍在持续上传音频。
      // 下一次音频到达时尝试重建（5 秒防抖），否则会「一直在上传但永远不检测」。
      if (state.enabled && state.state !== 'loading' && Date.now() - lastStartAttemptAt > 5000) {
        lastStartAttemptAt = Date.now();
        void start();
      }
      return fail(state.state === 'error' ? 'engine-error' : 'engine-not-ready', isTest);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 2 !== 0) {
      return fail('bad-pcm', isTest);
    }
    // 上一次命中后的流重建。实测（真实 int8 模型，同一段录音连续 8 轮）：
    // reset 策略只中 5/8（reset 后流有状态残留），每次 createStream 重建是 8/8。
    // 重建推迟到「下一块音频到达时、acceptWaveform 之前」，所以这一块完整喂给新流，不丢音频。
    // 声纹缓冲一并清空，避免上一次唤醒词混进下一次的端点对齐。
    if (entry.needsReset) {
      entry.needsReset = false;
      // 丢弃全部并行流，下一块音频到达时整体重建：实测 reset 后流有状态残留（8 轮只中 5/8），
      // 每次 createStream 重建是 8/8。
      entry.streams = null;
      entry.recent = new Float32Array(0);
    }
    // 流在「第一次拿到音频」时才创建，并紧接着 acceptWaveform：与官方示例的用法一致。
    if (!ensureStreams(entry)) return fail('stream-create-failed', isTest);
    const samples = new Float32Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2) / 32768;
    // 原始音频同时供 KWS 解码与声纹校验，不做任何幅度调整。
    entry.recent = appendTail(entry.recent, samples, SPEAKER_WINDOW_SAMPLES);
    if (!isTest) listenBuffer = appendTail(listenBuffer, samples, LISTEN_WINDOW_SAMPLES);

    let keyword = '';
    // 同一块音频同时喂给所有并行档位，任一吐词即触发。
    for (let k = 0; k < spotters.length && !keyword; k += 1) {
      const item = spotters[k];
      const stream = entry.streams[k];
      if (!stream) continue;
      try {
        stream.acceptWaveform({ sampleRate: KWS_SAMPLE_RATE, samples });
        let guard = 0;
        while (item.spotter.isReady(stream) && guard < 50) {
          item.spotter.decode(stream);
          const detected = item.spotter.getResult(stream)?.keyword;
          if (typeof detected === 'string' && detected !== '') {
            keyword = detected;
            break;
          }
          guard += 1;
        }
      } catch (error) {
        // 单路失败不能关掉整个会话：其它档位还可能在同一个会话里正常工作。
        warn('KWS 解码失败（档位 ' + item.boost + '）：' + String(error?.message ?? error));
      }
    }

    if (!isTest) {
      state.decodedChunks += 1;
      state.lastDecodeAt = now();
    }
    if (!keyword) {
      // 引擎确实在解码、只是没吐关键词：以前这里零计数，UI 上就是「既不通过也不拒绝」。
      if (!isTest) state.noKeywordChunks += 1;
      return { ok: true, detected: false };
    }

    // 命中后不在原地重建流：打 needsReset 标记，把重置推迟到「下一块音频到达时」。
    // 连续唤醒时第二次的音频一定喂给已重置的流，重建窗口几乎为零；
    // 原来每次命中都 createStream，会丢掉两次唤醒之间的那一块音频，表现为偶发漏一两次。
    const at = now();
    if (!isTest) {
      state.detections += 1;
      state.lastDetection = { keyword, at };
    }
    if (config.wakeKeywords.length > 0 && !config.wakeKeywords.includes(keyword)) {
      entry.needsReset = true;
      noteSkip('not-a-wake-word', isTest);
      return { ok: true, detected: true, keyword, triggered: false, reason: 'not-a-wake-word' };
    }
    // 测试会话不受冷却限制，随时按住都能复现。
    if (!isTest && at - lastTriggerAt < config.cooldownMs) {
      entry.needsReset = true;
      noteSkip('cooldown');
      return { ok: true, detected: true, keyword, triggered: false, reason: 'cooldown' };
    }
    if (verifier) {
      let verification;
      try {
        // 只对「本次触发命中的那句唤醒词」做声纹比对，而不是整段滚动缓冲。
        verification = verifier(extractUtterance(entry.recent, keyword)) ?? { ok: false, reason: 'no-result' };
      } catch (error) {
        verification = { ok: false, reason: String(error?.message ?? error) };
      }
      if (!isTest) state.lastVerification = { ...verification, at: now() };
      if (verification.ok !== true) {
        entry.needsReset = true;
        noteSkip(verification.reason ?? 'voiceprint-rejected', isTest);
        if (!isTest) state.speakerRejections += 1;
        return {
          ok: true,
          detected: true,
          keyword,
          triggered: false,
          reason: verification.reason ?? 'voiceprint-rejected',
          score: verification.score ?? 0,
        };
      }
    }
    entry.needsReset = true;
    if (!isTest) {
      lastTriggerAt = at;
      state.triggers += 1;
      onDetect({ keyword, at, source: 'kws' });
    }
    return { ok: true, detected: true, keyword, triggered: true };
  }

  function stop() {
    stopped = true;
    for (const entry of sessions.values()) clearTimeout(entry.timer);
    sessions.clear();
    spotters = [];
    cleanupKeywordFiles();
    state.state = 'disabled';
  }

  /** 无条件重建（不管当前是否 ready）：设置页「重新初始化引擎」走这条路。 */
  function retry() {
    return reload(config.keywordsFile);
  }

  /** 正式监听最近 6 秒原始音频（16kHz 单声道 Float32），供设置页回放与诊断对比。 */
  function listenAudio() {
    return listenBuffer;
  }

  /**
   * 参数归因：三字词的最优 keywordsScore 会随语速漂移（实测同一句「大肥鱼」：
   * 一段在 boost 2 下各阈值全线命中、boost 3 全灭，另一段恰好相反）。
   * 没检出时对候选值各跑一遍，返回第一个能检出的，设置页据此提示「改成 X 就能过」。
   */
  async function probeBoosts(buffer, candidates, thresholdOverride) {
    if (loading) await loading;
    if (!Buffer.isBuffer(buffer) || buffer.length < KWS_CHUNK_SAMPLES * 2) {
      return { ok: false, reason: 'bad-pcm' };
    }
    const files = findModelFiles(config.modelDir);
    if (!files) return { ok: false, reason: 'model-missing' };
    const base = materializeKeywords(config);
    if (!base) return { ok: false, reason: 'keywords-missing' };
    const mod = await loadModule({ modulePath: config.modulePath });
    const KeywordSpotter = mod?.KeywordSpotter ?? mod?.default?.KeywordSpotter;
    if (typeof KeywordSpotter !== 'function') return { ok: false, reason: 'module-missing' };
    const threshold = Number(thresholdOverride ?? config.keywordsThreshold ?? 0.15);
    const blockBytes = KWS_CHUNK_SAMPLES * 2;
    // 补 1 秒尾部静音：KWS 需要词尾静音才确认关键词，直接用「说完就截断」的录音会全部漏检。
    const padded = Buffer.concat([buffer, Buffer.alloc(KWS_SAMPLE_RATE * 2)]);
    const tried = [];
    for (const boost of candidates) {
      if (!Number.isFinite(boost) || boost <= 0) continue;
      const keywordFile = keywordsWithValues(base, boost, threshold);
      let probe = null;
      try {
        probe = new KeywordSpotter(buildSherpaConfig(
          { ...config, keywordsScore: boost, keywordsThreshold: threshold }, files, keywordFile,
        ));
        const stream = probe.createStream();
        let hit = null;
        for (let at = 0; at + blockBytes <= padded.length && !hit; at += blockBytes) {
          const bytes = padded.subarray(at, at + blockBytes);
          const samples = new Float32Array(KWS_CHUNK_SAMPLES);
          for (let i = 0; i < KWS_CHUNK_SAMPLES; i += 1) samples[i] = bytes.readInt16LE(i * 2) / 32768;
          stream.acceptWaveform({ sampleRate: KWS_SAMPLE_RATE, samples });
          while (probe.isReady(stream)) {
            probe.decode(stream);
            const text = probe.getResult(stream)?.keyword;
            if (typeof text === 'string' && text) { hit = text; break; }
          }
        }
        tried.push({ boost, detected: Boolean(hit) });
        if (hit) return { ok: true, boost, threshold, keyword: hit, tried };
      } catch (error) {
        tried.push({ boost, detected: false, error: String(error?.message ?? error) });
      } finally {
        try { probe?.free?.(); } catch {}
        try { rmSync(keywordFile, { force: true }); } catch {}
      }
    }
    return { ok: true, boost: null, threshold, tried };
  }

  return {
    status,
    start,
    retry,
    reload,
    updateConfig,
    setVerifier,
    setListeningEnabled,
    openSession,
    closeSession,
    handleAudio,
    listenAudio,
    probeBoosts,
    stop,
    noteClient: (info) => { state.client = info; },
  };
}
