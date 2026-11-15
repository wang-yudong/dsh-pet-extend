/**
 * DSH 官方语音识别（`@deepseek-ai/dsh-experimental-speech-to-text`，默认 provider
 * `sensevoice-local`）的可选桥接层。
 *
 * 为什么不用官方「语音输入」那个麦克风按钮：
 * 那个插件（`@deepseek-ai/dsh-experimental-client-ui-voice-input`）只是一个挂在
 * `conversation.input.activity` 槽位里的 React 组件，状态全在组件内部，既没有注册
 * Cordis 服务，也没有快捷键，外部无法「触发」它。但它背后的识别能力是开放的：
 * 宿主服务 `ctx.speechToText` 提供 `resolve()` + `transcribe()`，任何插件都能调用。
 *
 * 本模块只做三件事：
 * 1. 用 `ctx.get('speechToText')` 探测服务/provider 是否可用（缺失就优雅降级）；
 * 2. 把 16 kHz 单声道 Int16LE PCM 包成规范 WAV（官方 provider 用 validateWave 校验）；
 * 3. 调用 `transcribe()`，并把耗时/错误归一成可 JSON 化的结构给设置页和诊断用。
 *
 * 该服务属于 experimental 包，跨 DSH 版本可能变动，因此所有访问都在 try/catch 里，
 * 任何异常都只降级为 `{ ok: false, reason }`，不抛到 HTTP 层。
 */

/** SenseVoice 接受的语言提示（与官方 provider 的 languages 契约一致）。 */
export const SPEECH_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);

/** 单次语音命令的安全上限：100 秒 ≈ 3.2 MB，落在官方 4 MB / 120 秒的限额内。 */
export const MAX_COMMAND_SECONDS = 100;
export const MAX_COMMAND_BYTES = 16000 * 2 * MAX_COMMAND_SECONDS;

const DEFAULT_TIMEOUT_MS = 30000;

/** 16 kHz 单声道 Int16LE PCM → 规范 WAV（44 字节头）。 */
export function pcmToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                          // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);                         // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 读一段 provider 就绪状态，任何异常都当作「未知」。 */
function phaseOf(provider) {
  const phase = provider?.preparation?.phase;
  return typeof phase === 'string' ? phase : 'unknown';
}

/** provider 处于这些阶段时，需要显式 `prepare()` 才会真正加载模型。 */
const NEEDS_PREPARE = new Set(['unprepared', 'failed', 'cancelled']);

function plainProvider(provider) {
  return {
    id: String(provider?.info?.id ?? ''),
    name: String(provider?.info?.name ?? ''),
    location: String(provider?.info?.location ?? ''),
    languages: Array.isArray(provider?.info?.languages) ? [...provider.info.languages] : [],
    phase: phaseOf(provider),
    step: typeof provider?.preparation?.step === 'string' ? provider.preparation.step : null,
  };
}

/**
 * createSpeechBridge
 * @param {object} options
 * @param {() => any} options.getContext 取宿主 ctx 的函数（延迟取，避免加载顺序问题）
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.warn]
 * @param {number} [options.timeoutMs] 单次转写超时
 */
export function createSpeechBridge({ getContext, log = () => {}, warn = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const stats = { calls: 0, failures: 0, lastAt: 0, lastMs: 0, lastReason: '' };
  let lastResult = null;

  /** 取服务的当前实例；不可用时返回 null（不抛）。 */
  function service() {
    let ctx = null;
    try {
      ctx = typeof getContext === 'function' ? getContext() : null;
    } catch {
      return null;
    }
    let candidate = null;
    try {
      candidate = typeof ctx?.get === 'function' ? ctx.get('speechToText') : ctx?.speechToText;
    } catch {
      return null;
    }
    if (!candidate || typeof candidate.resolve !== 'function' || typeof candidate.transcribe !== 'function') return null;
    return candidate;
  }

  /** 只读快照：provider 列表 + 当前选择；服务缺失时给出原因。 */
  function summary() {
    const svc = service();
    const base = {
      calls: stats.calls,
      failures: stats.failures,
      lastAt: stats.lastAt,
      lastMs: stats.lastMs,
      lastReason: stats.lastReason,
      last: lastResult,
      timeoutMs,
      maxSeconds: MAX_COMMAND_SECONDS,
    };
    if (!svc) {
      return {
        ...base,
        available: false,
        reason: 'speech-service-unavailable',
        hint: '需要启用 DSH 官方语音输入插件（@deepseek-ai/dsh-experimental-voice-input-bundle）',
        providers: [],
        selection: null,
      };
    }
    let snap = null;
    try {
      snap = svc.snapshot();
    } catch (error) {
      warn('读取语音服务快照失败：' + String(error?.message ?? error));
    }
    const providers = Array.isArray(snap?.providers) ? snap.providers.map(plainProvider) : [];
    const selection = snap?.selection
      ? { providerId: String(snap.selection.providerId ?? ''), language: String(snap.selection.language ?? 'auto') }
      : null;
    const picked = providers.find((item) => item.id === selection?.providerId) ?? providers[0] ?? null;
    return {
      ...base,
      available: providers.length > 0,
      reason: providers.length > 0 ? null : 'speech-provider-unavailable',
      providers,
      selection,
      provider: picked,
      phase: picked?.phase ?? 'unknown',
      language: selection?.language ?? 'auto',
    };
  }

  /**
   * 预热：选中 provider 处于 unprepared/failed/cancelled 时发起官方 prepare()。
   * 唤醒瞬间并行调用，让模型加载与用户说话重叠。
   */
  function prepare() {
    const svc = service();
    if (!svc) return { ok: false, reason: 'speech-service-unavailable' };
    let snap = null;
    try {
      snap = svc.snapshot();
    } catch {
      return { ok: false, reason: 'speech-snapshot-failed' };
    }
    const providers = Array.isArray(snap?.providers) ? snap.providers : [];
    const id = snap?.selection?.providerId;
    const picked = providers.find((item) => item?.info?.id === id) ?? providers[0];
    if (!picked) return { ok: false, reason: 'speech-provider-unavailable' };
    const providerId = String(picked.info?.id ?? '');
    const phase = phaseOf(picked);
    if (!NEEDS_PREPARE.has(phase)) return { ok: true, started: false, providerId, phase };
    try {
      svc.prepare(providerId);
      log(`语音识别预热已发起：${providerId}（原阶段 ${phase}）`);
      return { ok: true, started: true, providerId, phase };
    } catch (error) {
      const message = String(error?.message ?? error);
      warn('语音识别预热失败：' + message);
      return { ok: false, reason: 'speech-prepare-failed', message, providerId, phase };
    }
  }

  /**
   * 把一段 PCM 交给官方 SenseVoice 转写。
   * @param {Buffer|Uint8Array} pcm 16 kHz 单声道 Int16LE
   * @param {{ language?: string, signal?: AbortSignal }} [options]
   */
  async function transcribePcm(pcm, { language, signal } = {}) {
    const tags = { language: language ?? null, bytes: pcm?.length ?? 0 };
    const fail = (reason, extra = {}) => {
      stats.failures += 1;
      stats.lastReason = reason;
      stats.lastAt = Date.now();
      const result = { ok: false, reason, ...tags, ...extra };
      lastResult = { ...result, text: null };
      return result;
    };

    if (!pcm || pcm.length < 3200) return fail('audio-too-short', { minBytes: 3200 });
    if (pcm.length % 2 !== 0) return fail('bad-pcm');
    if (pcm.length > MAX_COMMAND_BYTES) return fail('audio-too-long', { maxBytes: MAX_COMMAND_BYTES });

    const svc = service();
    if (!svc) return fail('speech-service-unavailable');

    const wav = pcmToWav(pcm);
    let spec;
    try {
      spec = svc.resolve({
        audio: new Uint8Array(wav.buffer, wav.byteOffset, wav.length),
        ...(language === undefined || language === null || language === '' ? {} : { language }),
      });
    } catch (error) {
      // 语言不在 provider 支持列表里、或选中的 provider 已被卸载，都在这里。
      return fail('speech-provider-unavailable', { message: String(error?.message ?? error) });
    }

    const startedAt = Date.now();
    stats.calls += 1;
    const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
    const combined = signal && timeout && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout ?? new AbortController().signal);

    try {
      const transcript = await svc.transcribe(spec, combined);
      const ms = Date.now() - startedAt;
      stats.lastAt = Date.now();
      stats.lastMs = ms;
      stats.lastReason = '';
      const text = typeof transcript?.text === 'string' ? transcript.text.trim() : '';
      lastResult = {
        ok: true,
        text,
        ms,
        audioSeconds: Number(transcript?.audioSeconds ?? 0),
        inferenceSeconds: Number(transcript?.inferenceSeconds ?? 0),
        seconds: Number((pcm.length / 32000).toFixed(2)),
        providerId: String(spec?.provider?.info?.id ?? ''),
        language: String(spec?.language ?? 'auto'),
      };
      if (!text) {
        stats.lastReason = 'empty-transcript';
        lastResult.reason = 'empty-transcript';
      }
      log(`语音命令转写完成：${lastResult.seconds}s 音频 / ${ms}ms` + (text ? '' : '（无语音内容）'));
      return lastResult;
    } catch (error) {
      const ms = Date.now() - startedAt;
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      return fail(aborted ? 'transcribe-timeout' : 'transcription-failed', {
        message: String(error?.message ?? error),
        ms,
      });
    }
  }

  return { service, summary, prepare, transcribePcm };
}
