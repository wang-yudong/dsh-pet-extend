/**
 * dsh-pet-extend 宿主半侧：
 * - 右键菜单：打开桌宠对话（设置统一走 DSH 设置里的「桌宠扩展设置」分区）；
 * - 设置页：由客户端半侧注册进 settings.section，用同源 iframe 嵌入本路由的 /settings；
 * - 客户端上传 16kHz PCM → sherpa-onnx KWS → 声纹校验 → 复用 menu-event 打开 pet-chat。
 *
 * 只依赖 dsh-pet 公开的 /dsh-pet-7340 HTTP 接口与 DSH 的 sidebarRight 服务。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKwsEngine, resolveKwsConfig, loadSherpaModule } from './kws.js';
import {
  DEFAULT_REACT_TEXTS, DEFAULT_SETTINGS, DEFAULT_WAKE_WORD, buildKeywordLines, createSettingsStore, sanitizeSettings,
} from './settings.js';
import { createVoiceprint, MAX_ENROLLMENTS } from './voiceprint.js';
import { installModels, installStatus, modelStatus, KWS_MODEL_DIR, SPEAKER_MODEL_PATH } from './models.js';

export const name = 'pet-extend';
export const inject = ['webServer'];

const ROUTE = '/dsh-pet-extend';
const PET_ROUTE = '/dsh-pet-7340';
/** 「按住录音测试」最多收 12 秒 16kHz 单声道 Int16 PCM。 */
const KWS_TEST_MAX_BYTES = 16000 * 2 * 12;
/**
 * 代码版本标记：服务端在 /api/kws/status 里返回它。
 * 「重新初始化引擎」只重建 native KeywordSpotter，不会重载插件 JS 代码；
 * 改了代码必须重启 DSH。设置页会显示这个标记，用来确认进程实际加载的是哪一版。
 */
const CODE_VERSION = 'kws-warmup-fix-2026-11-13';
const MENU_OWNER = 'dsh-pet-extend';
export const MENU_LABELS = { open: '打开桌宠对话' };
export const ORIGINAL_CHAT_KIND = 'pet-chat';
/** 与 lib/client.js 的 SETTINGS_SECTION 一致：DSH 设置导航里新增的分区。 */
export const SETTINGS_SECTION = Object.freeze({ id: 'pet-extend-config', label: '桌宠扩展设置', order: 31 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE_PATH = fileURLToPath(new URL('./pages/settings.html', import.meta.url));
let pageCache = null;
function settingsPage() {
  if (pageCache === null) {
    try {
      pageCache = readFileSync(PAGE_PATH, 'utf8');
    } catch {
      pageCache = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>设置页缺失</title><body>lib/pages/settings.html 未随插件安装。</body></html>';
    }
  }
  return pageCache;
}

function jsonReply(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function htmlReply(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/** 声纹回放：把录入时保存的 16kHz 单声道 Int16LE PCM 包成标准 WAV 直接返回。 */
function wavReply(res, wav) {
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': String(wav.length),
    'cache-control': 'no-store',
  });
  res.end(wav);
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // 单声道
  header.writeUInt32LE(16000, 24);   // 采样率
  header.writeUInt32LE(32000, 28);   // byteRate
  header.writeUInt16LE(2, 32);       // blockAlign
  header.writeUInt16LE(16, 34);      // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function restOf(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const at = pathname.lastIndexOf(ROUTE);
  const rest = at >= 0 ? pathname.slice(at + ROUTE.length) : pathname;
  return { rest: rest === '' ? '/' : rest, search: url.search };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** 读取 PCM 二进制请求体；超限时仍排空请求，避免占用连接。 */
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return tooLarge ? null : Buffer.concat(chunks);
}

function pcmToFloat(buffer) {
  const samples = new Float32Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2) / 32768;
  return samples;
}

/** 注册菜单项 → 长轮询 /menu/events → 分发点击 → 停止时注销。 */
export function createMenuBridge({ base, getBase, fetchImpl = fetch, onOpen, log = () => {} }) {
  // webServer 端口可能晚于插件加载才就绪，注册与轮询时都取最新值。
  const baseOf = () => (typeof getBase === 'function' ? getBase() : base);
  const controller = new AbortController();
  const status = {
    registered: false,
    polls: 0,
    lastError: null,
    lastEvent: null,
    startedAt: Date.now(),
    clientSeen: false,
    lastOpenResult: null,
  };
  let stopped = false;

  async function call(path, method = 'GET', body, signal = controller.signal) {
    const current = baseOf();
    if (!current) throw new Error('webServer 端口尚未就绪');
    const res = await fetchImpl(current + PET_ROUTE + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    return res.json().catch(() => null);
  }

  async function register() {
    for (let attempt = 0; attempt < 10 && !stopped; attempt += 1) {
      try {
        const body = await call('/menu/item', 'POST', {
          owner: MENU_OWNER,
          labels: Object.values(MENU_LABELS),
          target: 'both',
        });
        if (body?.ok === true) {
          status.registered = true;
          status.lastError = null;
          return true;
        }
        status.lastError = body?.reason ?? 'bad-response';
      } catch (error) {
        status.lastError = String(error?.message ?? error);
        if (controller.signal.aborted) return false;
      }
      if (!stopped) await sleep(1000);
    }
    return false;
  }

  async function loop() {
    if (!(await register())) {
      log('右键菜单注册失败：' + String(status.lastError ?? 'unknown'));
      return;
    }
    while (!stopped && !controller.signal.aborted) {
      try {
        const body = await call('/menu/events?owner=' + encodeURIComponent(MENU_OWNER) + '&wait=5000');
        status.polls += 1;
        if (body?.ok === false && body.reason === 'unknown-owner') {
          if (!(await register())) return;
          continue;
        }
        // 0.4.7 实测回 { ok:true, events:{ label: petId } }；旧文档描述的是顶层 label→petId，两种都兼容。
        const events = body?.events && typeof body.events === 'object' && !Array.isArray(body.events)
          ? body.events
          : body;
        for (const [label, pet] of Object.entries(events ?? {})) {
          if (typeof pet !== 'string' || pet === '' || !Object.values(MENU_LABELS).includes(label)) continue;
          const event = { label, pet, ts: Date.now() };
          status.lastEvent = event;
          onOpen?.(event);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        status.lastError = String(error?.message ?? error);
      }
      await sleep(150);
    }
  }

  void loop();
  return {
    status,
    noteClient() {
      status.clientSeen = true;
    },
    noteOpenResult(result) {
      status.lastOpenResult = { ...result, at: Date.now() };
    },
    stop() {
      stopped = true;
      controller.abort();
      status.registered = false;
      // 传 undefined 信号，避免注销请求被自己的 abort 取消。
      void call('/menu/item?owner=' + encodeURIComponent(MENU_OWNER), 'DELETE', undefined, undefined).catch(() => {});
    },
  };
}

export function apply(ctx, config = {}) {
  // 端口 getter 偶尔会短暂为空；缓存最后一次有效值。
  let lastOrigin = '';
  const originOf = () => {
    const port = ctx.webServer?.port;
    if (typeof port === 'number' && port > 0) lastOrigin = `http://127.0.0.1:${port}`;
    return lastOrigin;
  };
  const log = (message) => ctx.logger?.info?.('[dsh-pet-extend] ' + message);
  const warn = (message) => ctx.logger?.warn?.('[dsh-pet-extend] ' + message) ?? log(message);

  const waiters = [];
  const pending = [];
  let bridge;

  const prelim = resolveKwsConfig(config, process.env, {});
  const tokensFile = join(prelim.modelDir || KWS_MODEL_DIR, 'tokens.txt');
  const store = createSettingsStore({
    dataDir: config.dataDir || process.env.DSH_PET_EXTEND_DATA_DIR || undefined,
    tokensFile,
  });
  let settings = store.loadSettings();
  const speakerModel = () => settings.speakerModel || prelim.speakerModel || SPEAKER_MODEL_PATH;
  let keywords = { lines: [], words: [], errors: [], path: store.keywordsPath };

  const kws = createKwsEngine({
    config: prelim,
    loadModule: prelim.loadModule ?? loadSherpaModule,
    log,
    warn,
    onDetect: ({ keyword, at, source }) => {
      publishOpenEvent({ label: MENU_LABELS.open, pet: 'kws', ts: at, source, keyword });
      log(`语音唤醒「${keyword}」：打开原本的桌宠对话`);
      // 同步选好这句回应：既用于 /broadcast 气泡，也随 audio 响应回传给客户端本地朗读。
      lastWakeText = pickReactText(store.loadSettings());
      void reactToWake(keyword, lastWakeText);
    },
  });

  // ---- 唤醒反应：命中唤醒词且声纹通过后，借 dsh-pet 的 /broadcast 接口让桌宠播放联动动画 + 气泡；
  //      朗读改由客户端本地 Web Speech 完成（dsh-pet 的 Edge 在线合成常被 429 限流，靠不住）。 ----
  let cachedPets = null;
  let cachedPetsAt = 0;
  let lastReaction = null;
  let lastWakeText = '';

  /** 从 dsh-pet 合并配置里收集宠物 { id, display }（display 决定广播该发往哪一端）。 */
  function collectPets(cfg) {
    const out = [];
    if (!cfg || typeof cfg !== 'object') return out;
    for (const conf of Object.values(cfg)) {
      const pets = conf && conf.pets;
      if (!Array.isArray(pets)) continue;
      for (const p of pets) {
        if (!p || typeof p.id !== 'string' || !p.id) continue;
        out.push({ id: p.id, display: typeof p.display === 'string' ? p.display : 'both' });
      }
    }
    return out;
  }

  function displayedPets(pets) {
    const shown = pets.filter((p) => p.display === 'web' || p.display === 'desktop' || p.display === 'both');
    return shown.length ? shown : pets;
  }

  /** /broadcast 的 ?surface= 必填；选具体一端（desktop/web）才会同时朗读，any 只能弹气泡。 */
  function surfaceFor(display) {
    if (display === 'desktop' || display === 'both') return 'desktop';
    if (display === 'web') return 'web';
    return 'any';
  }

  /** 自动发现桌宠：读 dsh-pet 的 /config（无需 pet 参数）。失败回空数组。 */
  async function discoverPets() {
    const origin = originOf();
    if (!origin) return [];
    try {
      const res = await fetch(origin + PET_ROUTE + '/config', { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const cfg = await res.json().catch(() => null);
      return collectPets(cfg);
    } catch {
      return [];
    }
  }

  async function resolveReactPets(settings) {
    const configured = (settings.reactPetId || '').trim();
    if (configured) return [{ id: configured, display: '' }];
    const at = Date.now();
    if (cachedPets && cachedPets.length > 0 && at - cachedPetsAt < 5 * 60 * 1000) return displayedPets(cachedPets);
    cachedPets = await discoverPets();
    cachedPetsAt = at;
    return displayedPets(cachedPets);
  }

  /** 从多行文案里随机挑一句；没配置则用默认候选「我在 / 你好」。 */
  function pickReactText(settings) {
    const lines = String(settings?.reactText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const candidates = lines.length > 0 ? lines : DEFAULT_REACT_TEXTS;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  async function postPet(path, body) {
    const origin = originOf();
    if (!origin) return { ok: false, reason: 'no-origin' };
    try {
      const res = await fetch(origin + PET_ROUTE + path, {
        method: 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      return data && typeof data === 'object' ? data : { ok: false, reason: 'bad-response', status: res.status };
    } catch (error) {
      return { ok: false, reason: 'fetch-error', message: String(error?.message ?? error) };
    }
  }

  /** 触发一次唤醒反应；返回结果并记进 lastReaction（设置页「诊断」可查）。 */
  async function reactToWake(keyword, textOverride) {
    const s = store.loadSettings();
    if (s.reactEnabled === false) {
      lastReaction = { at: Date.now(), ok: false, reason: 'disabled' };
      return lastReaction;
    }
    const text = textOverride || pickReactText(s);
    const body = {
      text,
      anim: s.reactAnim !== false,
      // 不在宿主侧合成语音：dsh-pet 用 Edge 在线 TTS，常被 429 限流而无声；本插件改由客户端本地朗读。
      speak: false,
      duration: Number(s.reactDuration) || 8000,
    };
    const targets = await resolveReactPets(s);
    if (targets.length === 0) {
      lastReaction = { at: Date.now(), ok: false, reason: 'no-pet', text };
      warn('唤醒反应：未发现桌宠（dsh-pet 未运行或配置为空？）');
      return lastReaction;
    }
    let last = { ok: false, reason: 'not-sent' };
    for (const pet of targets) {
      const surface = pet.display ? surfaceFor(pet.display) : 'any';
      const path = '/broadcast?pet=' + encodeURIComponent(pet.id) + '&surface=' + surface;
      let data = await postPet(path, body);
      // 睡觉中会被门禁挡住（reason: sleeping）：先叫醒再重试一次（/wake 幂等）。
      if (data?.ok !== true && data?.reason === 'sleeping') {
        await postPet('/wake?pet=' + encodeURIComponent(pet.id));
        data = await postPet(path, body);
      }
      last = { ...data, petId: pet.id, surface };
      if (data?.ok === true) {
        lastReaction = { at: Date.now(), ok: true, petId: pet.id, surface, text };
        log('唤醒反应已发送给桌宠「' + pet.id + '」（surface=' + surface + '）：' + text);
        return lastReaction;
      }
    }
    lastReaction = {
      at: Date.now(), ok: false, reason: last?.reason || 'unknown', message: last?.message, petId: last?.petId, text,
    };
    if (['unknown-pet', 'pet-required', 'no-pet'].includes(lastReaction.reason)) cachedPets = null;
    warn('唤醒反应未成功：' + lastReaction.reason + (lastReaction.message ? ' · ' + lastReaction.message : ''));
    return lastReaction;
  }
  // 每次录入各存一份原始录音，与 voiceprint.json 里最多 MAX_ENROLLMENTS 条 embedding 一一对齐。
  // voiceprint-audio.json 是索引；voiceprint.wav 是上一版单文件格式的兼容数据。
  const voiceAudioDir = dirname(store.voiceprintPath);
  const voiceAudioIndexPath = join(voiceAudioDir, 'voiceprint-audio.json');
  const legacyVoiceAudioPath = join(voiceAudioDir, 'voiceprint.wav');
  const lastTestAudioPath = join(voiceAudioDir, 'last-test.wav');
  // 正式监听最近 6 秒（测试开始前），落盘用于对比两条采集链路的音频差异。
  const lastListenPath = join(voiceAudioDir, 'last-listen.wav');
  const voiceprint = createVoiceprint({
    modelPath: speakerModel(),
    filePath: store.voiceprintPath,
    loadModule: prelim.loadModule ?? loadSherpaModule,
    getThreshold: () => store.loadSettings().speakerThreshold,
    log,
    warn,
  });

  function readVoiceAudioItems() {
    try {
      const parsed = JSON.parse(readFileSync(voiceAudioIndexPath, 'utf8'));
      if (!Array.isArray(parsed?.items)) throw new Error('bad-index');
      return parsed.items
        .filter((item) => item && typeof item.file === 'string' && item.file)
        .map((item) => ({ at: Number(item.at) || null, file: basename(item.file) }))
        .slice(-MAX_ENROLLMENTS);
    } catch {
      // 兼容上一版：只有单个 voiceprint.wav，也算一条可回放的录入。
      return existsSync(legacyVoiceAudioPath) ? [{ at: null, file: basename(legacyVoiceAudioPath) }] : [];
    }
  }

  const audioPathOf = (item) => (item ? join(voiceAudioDir, basename(item.file)) : '');

  /** 把索引里的录音槽位对齐到 voiceprint.json 的 embedding 样本：旧样本可能没有录音。 */
  function voiceAudioSlots() {
    const count = voiceprint.summary().count || 0;
    const items = readVoiceAudioItems();
    const total = Math.max(count, items.length, 0);
    const slots = [];
    for (let index = 1; index <= total; index += 1) {
      const item = items[items.length - total + (index - 1)] ?? null;
      const file = audioPathOf(item);
      slots.push({
        index,
        at: item?.at ?? null,
        file,
        audioAvailable: Boolean(file && existsSync(file)),
      });
    }
    return slots;
  }

  function voiceSummary() {
    const slots = voiceAudioSlots();
    return {
      ...voiceprint.summary(),
      audioAvailable: slots.some((slot) => slot.audioAvailable),
      samples: slots.map(({ index, at, audioAvailable }) => ({ index, at, audioAvailable })),
    };
  }

  /** index 省略时回放最近一条；返回服务端路径，不暴露给前端。 */
  function resolveVoiceAudio(index) {
    const slots = voiceAudioSlots();
    if (!voiceprint.summary().present || slots.length === 0) return null;
    const wanted = Number(index);
    const chosen = Number.isInteger(wanted) && wanted > 0
      ? slots.find((slot) => slot.index === wanted)
      : [...slots].reverse().find((slot) => slot.audioAvailable);
    return chosen?.audioAvailable ? chosen.file : null;
  }

  function saveEnrollmentAudio(body) {
    const raw = body.subarray(0, Math.floor(body.length / 2) * 2);
    const items = readVoiceAudioItems();
    const at = Date.now();
    let file = `voiceprint-${at}.wav`;
    let suffix = 1;
    while (existsSync(join(voiceAudioDir, file))) file = `voiceprint-${at}-${suffix++}.wav`;
    writeFileSync(join(voiceAudioDir, file), pcmToWav(raw));
    const next = [...items, { at, file }].slice(-MAX_ENROLLMENTS);
    const kept = new Set(next.map((item) => item.file));
    for (const item of items) {
      if (!kept.has(item.file)) rmSync(join(voiceAudioDir, basename(item.file)), { force: true });
    }
    writeFileSync(voiceAudioIndexPath, JSON.stringify({ items: next }, null, 2) + '\n', 'utf8');
  }

  /** 设置/声纹变化后：重建关键词、更新引擎配置、必要时热重载 KeywordSpotter。 */
  function syncEngine({ reloadKeywords = false, restart = false } = {}) {
    settings = store.loadSettings();
    try {
      keywords = store.buildKeywords(settings);
    } catch (error) {
      keywords = { lines: [], words: [], errors: [String(error?.message ?? error)], path: store.keywordsPath };
      warn('唤醒词生成失败：' + keywords.errors.join('；'));
    }
    const baseKws = config.kws && typeof config.kws === 'object' ? { ...config.kws } : {};
    if (keywords.path) baseKws.keywordsFile = keywords.path;
    // 设置页是正常入口；插件 config.kws.enabled 供诊断/测试直接拉起引擎。
    // 无论哪种，真正开始监听仍要求设置页开启且已录入声纹。
    baseKws.enabled = Boolean(settings.enabled || baseKws.enabled === true);
    const next = config.kws === false
      ? resolveKwsConfig(config, process.env, settings)
      : resolveKwsConfig({ ...config, kws: baseKws }, process.env, settings);
    next.keywordsFile = keywords.path;
    next.modelDir = settings.modelDir || prelim.modelDir || KWS_MODEL_DIR;
    next.speakerModel = speakerModel();
    next.cooldownMs = settings.cooldownMs;
    // 灵敏度也写进 keywords.txt 行内；引擎全局值由 resolveKwsConfig 按
    // config.kws > settings > 环境变量 的优先级解析，避免部分 sherpa 版本只认全局值。
    // 保存设置会 reload 重建 spotter，全局参数才真正生效。
    kws.updateConfig(next);
    const hasVoiceprint = voiceprint.summary().present;
    kws.setVerifier(hasVoiceprint ? (samples) => voiceprint.verify(samples) : null);
    kws.setListeningEnabled(Boolean(settings.enabled && hasVoiceprint));
    // rebuild 返回 Promise：retry 接口会 await 它，把真实结果回给设置页。
    if (reloadKeywords || restart) return kws.reload(keywords.path);
    void kws.start();
    return Promise.resolve({ ok: true, restarted: false, state: kws.status().state });
  }
  void syncEngine();

  function publishEvent(event) {
    const entry = { ...event, consumed: false };
    pending.push(entry);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      jsonReply(waiter.res, 200, { ok: true, events: [entry] });
      entry.consumed = true;
    }
    setTimeout(() => {
      if (entry.consumed) return;
      const at = pending.indexOf(entry);
      if (at >= 0) pending.splice(at, 1);
      if (bridge?.status) bridge.status.lastError = '客户端半侧未取走事件（DSH 主窗口可能未加载）';
      warn('事件未被客户端半侧取走');
    }, 3000).unref?.();
  }

  function publishOpenEvent(event) {
    publishEvent({ ...event, action: 'open' });
  }

  function handleMenuEvent(res, search) {
    if (pending.length > 0) {
      const entry = pending.shift();
      entry.consumed = true;
      jsonReply(res, 200, { ok: true, events: [entry] });
      return;
    }
    const rawWait = new URLSearchParams(search).get('wait');
    const parsed = rawWait === null ? 5000 : Number(rawWait);
    const wait = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 5000, 0), 10000);
    const timer = setTimeout(() => {
      const at = waiters.findIndex((item) => item.res === res);
      if (at >= 0) waiters.splice(at, 1);
      jsonReply(res, 200, { ok: true, events: [] });
    }, wait);
    waiters.push({ res, timer });
  }

  function installSummary() {
    const info = installStatus();
    return {
      running: info.running,
      phase: info.phase,
      error: info.error,
      startedAt: info.startedAt,
      finishedAt: info.finishedAt,
    };
  }

  function modelSummary() {
    return { ...modelStatus(), install: installSummary() };
  }

  /** 主动探一次推理依赖：native addon 在 Electron 里可能 ABI 不匹配，静默 400 很难排查。 */
  let runtimeProbe = null;
  function runtimeSummary() {
    if (runtimeProbe?.sherpa?.ok) return runtimeProbe; // 失败时不缓存，装好依赖后自动恢复
    let sherpa = { ok: true, error: null };
    try {
      (prelim.loadModule ?? loadSherpaModule)({ modulePath: prelim.modulePath });
    } catch (error) {
      sherpa = { ok: false, error: String(error?.message ?? error) };
    }
    const path = speakerModel();
    runtimeProbe = {
      sherpa,
      speakerModelPath: path,
      speakerModelPresent: Boolean(path && existsSync(path)),
      tokensFile: store.tokensFile,
    };
    return runtimeProbe;
  }

  function settingsPayload() {
    return {
      ok: true,
      settings: store.loadSettings(),
      defaults: DEFAULT_SETTINGS,
      defaultWakeWord: DEFAULT_WAKE_WORD,
      keywords,
      voiceprint: voiceSummary(),
      model: modelSummary(),
      status: kws.status(),
      runtime: runtimeSummary(),
      reaction: lastReaction,
      canEnable: voiceSummary().present,
      codeVersion: CODE_VERSION,
    };
  }

  function statusPayload() {
    const model = modelStatus();
    const voice = voiceSummary();
    const blockedReason = !model.complete
      ? 'model-missing'
      : (!voice.present ? 'voiceprint-required' : (kws.status().state === 'error' ? 'engine-error' : null));
    return {
      ok: true,
      ...kws.status(),
      settings: store.loadSettings(),
      defaultWakeWord: DEFAULT_WAKE_WORD,
      voiceprint: voice,
      model: { ...model, install: installSummary() },
      runtime: runtimeSummary(),
      menu: bridge?.status ?? null,
      reaction: lastReaction,
      canEnable: voice.present,
      blockedReason,
      codeVersion: CODE_VERSION,
    };
  }

  /** 单独成函数，便于把任何异常转成 JSON 响应：DSH 的默认异常响应是非 JSON 的 400。 */
  async function handleRequest(req, res) {
      let info;
      try {
        info = restOf(req.url);
      } catch {
        jsonReply(res, 400, { ok: false, reason: 'bad-request' });
        return;
      }

      if ((info.rest === '/settings' || info.rest === '/settings/') && req.method === 'GET') {
        htmlReply(res, settingsPage());
        return;
      }
      if (info.rest === '/api/status' && req.method === 'GET') {
        jsonReply(res, 200, {
          ok: true,
          port: ctx.webServer?.port ?? null,
          originalChatKind: ORIGINAL_CHAT_KIND,
          menuEnabled: config.menu !== false,
          menu: bridge?.status ?? null,
          settingsPage: ROUTE + '/settings',
          settingsSection: SETTINGS_SECTION,
          kws: statusPayload(),
        });
        return;
      }
      if (info.rest === '/api/hello' && req.method === 'POST') {
        bridge?.noteClient();
        jsonReply(res, 200, { ok: true });
        return;
      }
      if (info.rest === '/api/open-result' && req.method === 'POST') {
        const result = await readJson(req);
        bridge?.noteOpenResult(result && typeof result === 'object' ? result : { ok: false });
        jsonReply(res, 200, { ok: true });
        return;
      }
      if (info.rest === '/api/menu-event' && req.method === 'GET') {
        handleMenuEvent(res, info.search);
        return;
      }

      if (info.rest === '/api/kws/status' && req.method === 'GET') {
        jsonReply(res, 200, statusPayload());
        return;
      }
      if (info.rest === '/api/kws/level' && req.method === 'GET') {
        // 轻量实时电平：设置页「麦克风电平」每几百毫秒轮询一次，直接反映 KWS 实际收到的音频。
        const s = kws.status();
        jsonReply(res, 200, {
          ok: true,
          state: s.state,
          peak: s.lastPeak,
          max: s.maxPeak,
          chunks: s.audioChunks,
          at: s.lastAudioAt,
          detections: s.detections,
          triggers: s.triggers,
          rejections: s.speakerRejections,
          decodedChunks: s.decodedChunks,
          noKeywordChunks: s.noKeywordChunks,
          avgPeak: s.avgPeak,
          voiceRatio: s.voiceRatio,
          lastRms: s.lastRms,
          lastSkipReason: s.lastSkipReason,
          lastDecodeAt: s.lastDecodeAt,
        });
        return;
      }
      if (info.rest === '/api/kws/react' && req.method === 'POST') {
        // 手动触发一次唤醒反应：设置页「测试反应」按钮与排查用，不必真的喊唤醒词。
        lastWakeText = pickReactText(store.loadSettings());
        const result = await reactToWake(undefined, lastWakeText);
        jsonReply(res, result.ok ? 200 : 400, { ...result, reaction: lastReaction });
        return;
      }
      if (info.rest === '/api/kws/settings' && req.method === 'GET') {
        jsonReply(res, 200, settingsPayload());
        return;
      }
      if (info.rest === '/api/kws/settings' && req.method === 'POST') {
        const patch = await readJson(req);
        if (!patch || typeof patch !== 'object') {
          jsonReply(res, 400, { ok: false, reason: 'bad-request' });
          return;
        }
        const wantsEnable = patch.enabled === true || patch.enabled === 'true';
        if (wantsEnable && !voiceprint.summary().present) {
          jsonReply(res, 409, {
            ok: false,
            reason: 'voiceprint-required',
            message: '请先在设置页录入声纹，再开启语音唤醒',
          });
          return;
        }
        let preview;
        try {
          preview = buildKeywordLines(sanitizeSettings({ ...store.loadSettings(), ...patch }), store.tokensFile);
        } catch (error) {
          jsonReply(res, 400, { ok: false, reason: 'keywords-invalid', message: String(error?.message ?? error) });
          return;
        }
        if (preview.lines.length === 0) {
          jsonReply(res, 400, { ok: false, reason: 'keywords-invalid', errors: preview.errors });
          return;
        }
        store.saveSettings(patch);
        await syncEngine({ reloadKeywords: true });
        jsonReply(res, 200, settingsPayload());
        return;
      }
      if (info.rest === '/api/kws/enroll' && req.method === 'POST') {
        let body;
        try {
          body = await readBody(req, 1024 * 1024);
        } catch (error) {
          warn('读取录入音频失败：' + String(error?.message ?? error));
          jsonReply(res, 400, { ok: false, reason: 'enroll-body-error', message: String(error?.message ?? error) });
          return;
        }
        if (body === null) {
          jsonReply(res, 413, { ok: false, reason: 'payload-too-large' });
          return;
        }
        let result;
        try {
          result = voiceprint.enroll(pcmToFloat(body));
        } catch (error) {
          warn('声纹录入失败：' + String(error?.stack ?? error?.message ?? error));
          jsonReply(res, 400, {
            ok: false,
            reason: 'enroll-failed',
            message: String(error?.message ?? error),
            voiceprint: voiceSummary(),
          });
          return;
        }
        if (result.ok) {
          // 这次录入单独存一个 WAV，供设置页逐条回放；不做任何增益/归一化。
          try { saveEnrollmentAudio(body); } catch (error) {
            warn('声纹录音保存失败：' + String(error?.message ?? error));
          }
          try { syncEngine(); } catch (error) { warn('录入后同步引擎失败：' + String(error?.message ?? error)); }
        }
        jsonReply(res, result.ok ? 200 : 400, {
          ...result,
          message: result.ok ? undefined : '声纹录入未完成：' + (result.reason ?? 'unknown'),
          voiceprint: voiceSummary(),
        });
        return;
      }
      if (info.rest === '/api/kws/voiceprint/audio' && req.method === 'GET') {
        const file = resolveVoiceAudio(Number(new URLSearchParams(info.search).get('index')));
        if (!file) {
          jsonReply(res, 404, {
            ok: false,
            reason: 'no-enrollment-audio',
            message: '这一条声纹没有原始录音（旧版录入只保存了特征向量），请重新录入一次',
          });
          return;
        }
        try {
          wavReply(res, readFileSync(file));
        } catch (error) {
          jsonReply(res, 500, { ok: false, reason: 'audio-read-failed', message: String(error?.message ?? error) });
        }
        return;
      }
      if (info.rest === '/api/kws/listen-audio' && req.method === 'GET') {
        const samples = kws.listenAudio();
        if (!samples || samples.length < 1600) {
          jsonReply(res, 404, {
            ok: false,
            reason: 'no-listen-audio',
            message: '还没收到正式监听的音频（确认语音唤醒已开启、客户端状态是 listening）',
          });
          return;
        }
        const pcm = Buffer.alloc(samples.length * 2);
        for (let i = 0; i < samples.length; i += 1) {
          const v = Math.max(-1, Math.min(1, samples[i]));
          pcm.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2);
        }
        wavReply(res, pcmToWav(pcm));
        return;
      }
      if (info.rest === '/api/kws/test/audio' && req.method === 'GET') {
        if (!existsSync(lastTestAudioPath)) {
          jsonReply(res, 404, { ok: false, reason: 'no-test-audio', message: '还没有按住录音测试过' });
          return;
        }
        try {
          wavReply(res, readFileSync(lastTestAudioPath));
        } catch (error) {
          jsonReply(res, 500, { ok: false, reason: 'audio-read-failed', message: String(error?.message ?? error) });
        }
        return;
      }
      if (info.rest === '/api/kws/test' && req.method === 'POST') {
        const body = await readBody(req, KWS_TEST_MAX_BYTES);
        if (body === null) {
          jsonReply(res, 413, { ok: false, reason: 'payload-too-large' });
          return;
        }
        const blockBytes = kws.status().chunkSamples * 2;
        if (body.length < blockBytes || body.length % 2 !== 0) {
          jsonReply(res, 400, { ok: false, reason: 'bad-pcm' });
          return;
        }
        // 顺手把「本次测试之前、正式监听收到的最近 6 秒」落盘：
        // 按住测试与真实监听的采集/上传链路不同，这份文件用于直接对比两条链路的声音。
        try {
          const live = kws.listenAudio();
          if (live && live.length >= 1600) {
            const livePcm = Buffer.alloc(live.length * 2);
            for (let i = 0; i < live.length; i += 1) {
              const value = Math.max(-1, Math.min(1, live[i]));
              livePcm.writeInt16LE(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), i * 2);
            }
            writeFileSync(lastListenPath, pcmToWav(livePcm));
          }
        } catch (error) {
          warn('监听音频落盘失败：' + String(error?.message ?? error));
        }
        // 音频体检：把「麦克风没拾到 / 削波 / 音量过低」与「有音频但引擎不吐词」分开。
        // 只做统计，绝不改动音频幅度。
        let peak = 0, sumSq = 0, clipped = 0;
        const blockPeaks = [];
        const sampleCount = Math.max(1, Math.floor(body.length / 2));
        for (let at = 0; at + blockBytes <= body.length; at += blockBytes) {
          let blockPeak = 0;
          for (let i = at; i < at + blockBytes; i += 2) {
            const v = body.readInt16LE(i) / 32768;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
            if (abs > blockPeak) blockPeak = abs;
            if (abs >= 0.98) clipped += 1;
            sumSq += v * v;
          }
          blockPeaks.push(blockPeak);
        }
        // 有效语音判定必须用相对阈值：底噪常在 0.03 左右，用绝对 0.01 会把底噪全算成「有声」，
        // 于是「只有 0.5 秒真语音」的录音会显示 100% 有效，掩盖了采集端把语音压掉的事实。
        const blockFloor = Math.max(0.02, peak * 0.1);
        const silentBlocks = blockPeaks.filter((p) => p < blockFloor).length;
        const totalBlocks = blockPeaks.length;
        try { writeFileSync(lastTestAudioPath, pcmToWav(body)); } catch (error) {
          warn('测试录音保存失败：' + String(error?.message ?? error));
        }
        // 每次重放都开一个干净的测试会话，走与正式监听相同的逐块流式解码 + 声纹校验。
        function runDecode(pcm) {
          const session = kws.openSession({ test: true });
          if (!session.ok) return { failed: session };
          const out = { detected: null, triggered: null, error: null, score: null, blocks: 0 };
          try {
            for (let at = 0; at + blockBytes <= pcm.length; at += blockBytes) {
              const one = kws.handleAudio(session.sessionId, pcm.subarray(at, at + blockBytes));
              out.blocks += 1;
              if (one?.ok === false && !out.error) out.error = one;
              if (one?.detected && !out.detected) out.detected = one;
              if (one?.triggered) out.triggered = one;
              if (typeof one?.score === 'number') out.score = one.score;
            }
          } finally {
            kws.closeSession(session.sessionId);
          }
          return out;
        }
        let outcome = runDecode(body);
        if (outcome.failed) {
          jsonReply(res, 503, { ...outcome.failed, ok: false });
          return;
        }
        // 说完立刻松手会把音频正好截在词尾，KWS 来不及收尾；补 0.5 秒静音重放一次，
        // 对齐正式监听里「说完自然停顿」的状态。只在没检出时做，且如实回报是否靠它救回来。
        let tailRetry = false;
        if (!outcome.detected) {
          const padded = Buffer.concat([body, Buffer.alloc(Math.round(16000 * 0.5) * 2)]);
          const aligned = padded.subarray(0, Math.floor(padded.length / blockBytes) * blockBytes);
          if (aligned.length > body.length) {
            tailRetry = true;
            const second = runDecode(aligned);
            if (!second.failed && second.detected) outcome = second;
          }
        }
        // 归因：没检出时再做一次「自适应放大」探测（只在电平确实偏低时，避免削波）。
        // 放大后能检出 → 是电平问题；放大后仍检不出 → 是发音/语速与词表不匹配。
        // 不这样做的话，UI 会把「发音问题」误报成「去调麦克风音量」。
        const current = store.loadSettings();
        let amplified = null;
        if (!outcome.detected && peak > 0.02 && peak < 0.45) {
          const factor = 0.9 / peak;
          const boosted = Buffer.from(body);
          for (let i = 0; i + 1 < boosted.length; i += 2) {
            boosted.writeInt16LE(
              Math.max(-32768, Math.min(32767, Math.round(boosted.readInt16LE(i) * factor))), i,
            );
          }
          const probe = runDecode(boosted);
          if (!probe.failed) {
            amplified = {
              factor: Number(factor.toFixed(1)),
              detected: Boolean(probe.detected),
              keyword: probe.detected?.keyword ?? null,
            };
          }
        }
        const { detected, triggered, error, score, blocks } = outcome;
        // 参数归因：三字词的最优 keywordsScore 会随语速漂移，没检出时扫几个候选值，
        // 找到这段录音能检出的那个，直接告诉用户「改成 X 就能过」，不用瞎试。
        let suggest = null;
        if (!detected && !(amplified && amplified.detected)) {
          const base = Number(current.keywordsScore) || 3;
          try {
            const tuned = await kws.probeBoosts(
              body,
              [base - 1, base - 0.5, base + 0.5, base - 1.5].filter((value) => value > 0),
              current.keywordsThreshold,
            );
            if (tuned.ok && tuned.boost != null && tuned.boost !== base) {
              suggest = { boost: tuned.boost, threshold: tuned.threshold };
            }
          } catch (error) {
            warn('参数归因探测失败：' + String(error?.message ?? error));
          }
        }
        jsonReply(res, 200, {
          ok: true,
          blocks,
          seconds: Number((body.length / 2 / 16000).toFixed(2)),
          detected: Boolean(detected),
          keyword: detected?.keyword ?? null,
          triggered: Boolean(triggered),
          reason: error?.reason ?? detected?.reason ?? (detected ? null : 'no-keyword'),
          score,
          threshold: Number(current.speakerThreshold),
          tailRetry,
          detectedAfterTail: Boolean(tailRetry && detected),
          amplified,
          suggest,
          audio: {
            peak: Number(peak.toFixed(3)),
            rms: Number(Math.sqrt(sumSq / sampleCount).toFixed(3)),
            clippedRatio: Number((clipped / sampleCount).toFixed(4)),
            silentBlocks,
            totalBlocks,
            voiceBlocks: totalBlocks - silentBlocks,
            blockFloor: Number(blockFloor.toFixed(3)),
            callbacks: Number(new URLSearchParams(info.search).get('callbacks')) || null,
          },
          keywords: kws.status().keywords,
          boost: Number(current.keywordsScore),
          keywordThreshold: Number(current.keywordsThreshold),
        });
        return;
      }
      if (info.rest === '/api/kws/voiceprint' && req.method === 'DELETE') {
        const files = [...readVoiceAudioItems().map(audioPathOf), legacyVoiceAudioPath];
        voiceprint.clear();
        for (const file of new Set(files)) {
          try { rmSync(file, { force: true }); } catch (error) {
            warn('清除声纹录音失败：' + String(error?.message ?? error));
          }
        }
        try { rmSync(voiceAudioIndexPath, { force: true }); } catch {}
        store.saveSettings({ enabled: false });
        syncEngine();
        jsonReply(res, 200, { ok: true, voiceprint: voiceSummary() });
        return;
      }
      if (info.rest === '/api/kws/model/install' && req.method === 'POST') {
        const body = await readJson(req);
        void installModels({ force: Boolean(body?.force) });
        jsonReply(res, 200, { ok: true, started: true });
        return;
      }
      if (info.rest === '/api/kws/session' && (req.method === 'POST' || req.method === 'DELETE')) {
        const params = new URLSearchParams(info.search);
        const result = req.method === 'POST' ? kws.openSession() : kws.closeSession(params.get('session'));
        jsonReply(res, result.ok ? 200 : 503, result);
        return;
      }
      if (info.rest === '/api/kws/audio' && req.method === 'POST') {
        const session = new URLSearchParams(info.search).get('session');
        const body = await readBody(req, prelim.maxAudioBytes);
        if (body === null) {
          jsonReply(res, 413, { ok: false, reason: 'payload-too-large' });
          return;
        }
        // 客户端在请求积压时会把连续几块 PCM 合并成一个请求；这里按块拆开逐块解码，
        // 既保持流式顺序，又能用一次 HTTP 往返追上实时音频。
        const blockBytes = kws.status().chunkSamples * 2;
        let result;
        if (blockBytes > 0 && body.length > blockBytes && body.length % blockBytes === 0) {
          let last = null;
          let firstError = null;
          let triggeredResult = null;
          for (let at = 0; at < body.length; at += blockBytes) {
            const one = kws.handleAudio(session, body.subarray(at, at + blockBytes));
            last = one;
            if (one?.ok === false && !firstError) firstError = one;
            if (one?.triggered === true && !triggeredResult) triggeredResult = one;
          }
          result = triggeredResult ?? firstError ?? last ?? { ok: false, reason: 'bad-pcm' };
        } else {
          result = kws.handleAudio(session, body);
        }
        // 命中时把这次回应文案随响应带回，客户端直接用本地 Web Speech 朗读（不依赖宿主在线合成）。
        if (result && result.triggered === true) {
          const s = store.loadSettings();
          if (s.reactEnabled !== false && s.reactSpeak !== false && lastWakeText) result.reactionText = lastWakeText;
        }
        jsonReply(res, 200, result);
        return;
      }
      if (info.rest === '/api/kws/retry' && req.method === 'POST') {
        // 重新读磁盘设置/词表/声纹 → 重建 KeywordSpotter → 等真正结束再回复。
        // 以前 fire-and-forget 地 reload 就回 ok:true，设置页立刻刷新时状态没变化，看起来像「没反应」。
        const result = await syncEngine({ restart: true });
        jsonReply(res, result.ok ? 200 : 503, result);
        return;
      }
      if (info.rest === '/api/kws/client-state' && req.method === 'POST') {
        const body = await readJson(req);
        kws.noteClient(body && typeof body === 'object' ? { ...body, at: Date.now() } : null);
        jsonReply(res, 200, { ok: true });
        return;
      }
      jsonReply(res, 404, {
        ok: false,
        reason: 'not-found',
        message: '未知接口；请在 DSH 设置 → 桌宠扩展设置 中打开，或访问 /dsh-pet-extend/settings',
      });
  }

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => handleRequest(req, res).catch((error) => {
      warn('请求处理异常：' + String(error?.stack ?? error?.message ?? error));
      if (!res.headersSent) {
        jsonReply(res, 500, { ok: false, reason: 'internal-error', message: String(error?.message ?? error) });
      }
    }),
  });

  if (config.menu !== false) {
    bridge = createMenuBridge({
      getBase: originOf,
      log: warn,
      onOpen: (event) => publishOpenEvent(event),
    });
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      bridge?.stop();
      kws.stop();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        jsonReply(waiter.res, 200, { ok: true, events: [] });
      }
      dispose();
    }, 'dsh-pet-extend: cleanup');
  }

  log(`右键菜单「${MENU_LABELS.open}」注册中；设置入口：DSH 设置 → ${SETTINGS_SECTION.label}（页面 ${ROUTE}/settings）`);
  log(`语音唤醒默认词「${DEFAULT_WAKE_WORD}」；需录入声纹后在设置页启用（状态见 ${ROUTE}/api/kws/status）`);
}
