/**
 * dsh-pet-extend 客户端半侧：
 * - 在 DSH 设置里新增「桌宠扩展设置」分区（settings.section slot），嵌入插件自带的设置页；
 * - 接收宿主转发的右键菜单点击 / 语音唤醒事件，打开 dsh-pet 原本的「桌宠对话」标签；
 * - 采集麦克风（getUserMedia + AudioWorklet，失败回退 ScriptProcessor），重采样为
 *   16kHz 单声道 Int16LE PCM，分片上传给宿主的 sherpa-onnx KWS 引擎；
 * - 语音任务：唤醒反应说完后复用同一条 PCM 流继续收一句命令（不额外 getUserMedia），
 *   能量端点检测截断后交给宿主识别，再把文字落到 DSH 会话（草稿 / 直接执行）。
 * 不注册扩展侧栏标签、不弹出独立设置窗口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-extend',
  factory(require) {
    const name = 'pet-extend';
    // 设置分区要等 slots 服务就绪；DSH 客户端内置设置外壳也依赖该服务。
    const inject = ['slots'];
    const CHAT_KIND = 'pet-chat';
    // 与 lib/index.js 的 SETTINGS_SECTION 一致：DSH 设置导航里新增的分区。
    const SETTINGS_SECTION = Object.freeze({ id: 'pet-extend-config', label: '桌宠扩展设置', order: 31 });
    const KWS_RATE = 16000;
    const KWS_CHUNK = 1600;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    const log = (message) => console.warn('[dsh-pet-extend] ' + message);

    /** dsh-pet 的 HTTP 基址（与它自己的客户端同口径：挂载前缀 + /dsh-pet-7340），返回绝对地址。 */
    function petBase() {
      try {
        const base = new URL(document.baseURI);
        return base.origin + base.pathname.replace(/\/+$/, '') + '/dsh-pet-7340';
      } catch {
        return '/dsh-pet-7340';
      }
    }

    /**
     * dsh-pet 的音色现在是「限定 id」（`provider/voice`，如 `edge/zh-CN-XiaoyiNeural`），
     * 而老配置里存的是裸名（`zh-CN-XiaoyiNeural`）。裸名直接交给 /voice/speak 会被判
     * bad-request，表现为「唤醒有动画没声音」。这里用它的 /voice/voices 目录把裸名补全；
     * 老版本 dsh-pet 没有这个目录，原样透传即可。
     */
    function pickDshPetVoiceId(configured, catalog) {
      const name = String(configured || '').trim();
      if (!name) return '';
      if (name.includes('/')) return name;
      const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
      if (providers.length === 0) return name;
      const ids = [];
      for (const provider of providers) {
        for (const voice of provider?.voices ?? []) {
          if (typeof voice?.id === 'string' && voice.id) ids.push(voice.id);
        }
      }
      return ids.find((id) => id === 'edge/' + name)
        || ids.find((id) => id.slice(id.indexOf('/') + 1) === name)
        || '';
    }

    /** 备选音色：目录里 edge 的第一个音色（与当前音色相同则返回空，避免重复失败）。 */
    function pickEdgeFallback(catalog, current) {
      const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
      const edge = providers.find((provider) => provider?.id === 'edge');
      const first = edge?.voices?.[0]?.id;
      if (typeof first !== 'string' || !first) return '';
      return first === current ? '' : first;
    }

    /** 读 dsh-pet 的音色设置（voiceName / voiceVolume），只拉一次。 */
    let voiceCfgPromise = null;
    function loadDshPetVoice() {
      if (!voiceCfgPromise) {
        const jsonOf = (path) => fetch(petBase() + path, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null);
        voiceCfgPromise = Promise.all([jsonOf('/config'), jsonOf('/voice/voices')])
          .then(([cfg, catalog]) => {
            // dsh-pet 0.4.x 的 /config 是扁平的（voiceName 在顶层）；更早的版本按条目分组（main.voiceName）。
            const root = cfg && typeof cfg === 'object' ? cfg : {};
            const main = root.main && typeof root.main === 'object' ? root.main : root;
            const volume = Number(main.voiceVolume);
            const voiceName = pickDshPetVoiceId(typeof main.voiceName === 'string' ? main.voiceName : '', catalog);
            return {
              voiceName,
              // 配置音色整体不可用时的备选：目录里的 edge 音色（免费在线，和 dsh-pet 内置的一致）。
              fallbackVoice: pickEdgeFallback(catalog, voiceName),
              volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
            };
          })
          .catch(() => ({ voiceName: '', fallbackVoice: '', volume: 1 }));
      }
      return voiceCfgPromise;
    }

    /**
     * 用 dsh-pet 的 /voice/speak 合成播放：音色跟随它设置的 voiceName，且能命中它自己的合成缓存
     * （同一句话合成过一次后即使在线 429 也能直接播）；失败返回 false 交给本地兜底。
     * wait=true 时等到播放结束（或超时）才返回——语音任务靠它判断「唤醒反应说完了」。
     *
     * 配置的音色可能整体不可用（例如选了 deepseek/stella 但没配 DEEPSEEK_API_KEY，
     * 合成直接 ms=0 失败）——这种时候整条唤醒反应会变成静音。这里退一步：再用目录里的
     * edge 默认音色试一次，宁可换嗓子也别没声音；两次都失败才真的静音。
     */
    async function playDshPetVoice(text, cfg, options = {}) {
      if (await playDshPetVoiceOnce(text, cfg, cfg.voiceName, options)) return true;
      const fallback = cfg.fallbackVoice;
      if (!fallback || fallback === cfg.voiceName) {
        void reportSpeakFailure(cfg.voiceName, 'generate-error');
        return false;
      }
      log(`音色「${cfg.voiceName || '默认'}」合成失败，改用「${fallback}」重试一次`);
      if (await playDshPetVoiceOnce(text, cfg, fallback, options)) {
        void reportSpeakFailure(cfg.voiceName, 'fallback-used', fallback);
        return true;
      }
      void reportSpeakFailure(cfg.voiceName, 'generate-error');
      return false;
    }

    /** 把朗读失败上报给宿主，设置页「语音任务」诊断里能直接看到原因。 */
    function reportSpeakFailure(voice, reason, fallback) {
      return post('api/voice/speak-failed', { voice, reason, fallback });
    }

    /** 单次合成播放；voice 为空表示交给 dsh-pet 用配置里的默认音色。 */
    async function playDshPetVoiceOnce(text, cfg, voice, { wait = false, timeoutMs = 6000 } = {}) {
      if (typeof fetch !== 'function') return false;
      try {
        const res = await fetch(petBase() + '/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
        });
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
        if (!res.ok || !type.includes('audio')) return false;
        const buf = await res.arrayBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: type || 'audio/mpeg' }));
        const audio = new Audio(url);
        audio.volume = cfg.volume;
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          try { URL.revokeObjectURL(url); } catch {}
        };
        audio.onerror = cleanup;
        await audio.play();
        if (!wait) { audio.onended = cleanup; return true; }
        // 等「真正念完」那一刻：Edge TTS 合成的音频尾部常带几百毫秒~1 秒静音，
        // 直接等 <audio>.onended 会等到整段放完，气泡就多停 1 秒。这里解码算出语音结束的时刻，
        // 到那个时刻就返回去切气泡；尾静音仍由 <audio> 在后台静默放完（不 revoke URL，避免截断尾音）。
        const endMs = await speechEndMs(buf).catch(() => null);
        await new Promise((resolve) => {
          let settled = false;
          const resolveOnce = () => { if (!settled) { settled = true; resolve(); } };
          const timer = endMs && endMs > 0 ? setTimeout(resolveOnce, endMs + 60) : null;
          const safety = setTimeout(resolveOnce, timeoutMs);
          audio.onended = () => { if (timer) clearTimeout(timer); clearTimeout(safety); cleanup(); resolveOnce(); };
          audio.onerror = () => { if (timer) clearTimeout(timer); clearTimeout(safety); cleanup(); resolveOnce(); };
        });
        if (!cleaned) audio.onended = cleanup; // 早返回时尾静音还在放，等它真正结束再回收。
        return true;
      } catch {
        return false;
      }
    }

    /** 解码音频，返回「语音结束」的时刻（毫秒，从缓冲开头算）；裁不出或失败返回 null。 */
    async function speechEndMs(arrayBuffer) {
      try {
        const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!Ctx) return null;
        const ctx = new Ctx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const ch = audioBuffer.getChannelData(0);
        const sr = audioBuffer.sampleRate;
        let peak = 0;
        for (let i = 0; i < ch.length; i += 1) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
        }
        if (peak <= 0) return null;
        const silence = Math.max(0.003, peak * 0.015); // 静音阈值（相对峰值的 1.5%）
        let end = ch.length;
        while (end > 0 && Math.abs(ch[end - 1]) < silence) end -= 1;
        // 留 120ms 词尾，宁可多留也不截到最后一个字。
        const tail = Math.min(end, Math.floor(sr * 0.12));
        end = Math.max(0, end - tail);
        try { ctx.close(); } catch {}
        if (end < Math.floor(sr * 0.1)) return null; // 裁掉超过 90% 就放弃，避免误伤极短语音
        return (end / sr) * 1000;
      } catch {
        return null;
      }
    }

    /**
     * 唤醒回应朗读：只用 dsh-pet 的音色（/voice/speak）。
     * 合成失败（如在线 429）时保持静音，不回退系统 Web Speech——避免出现与 dsh-pet 不同的音色。
     */
    async function speakReaction(text) {
      if (!text) return;
      const cfg = await loadDshPetVoice();
      if (!(await playDshPetVoice(text, cfg))) {
        log('唤醒反应朗读失败：dsh-pet 语音合成不可用（不回退系统语音）');
      }
    }

    /** 等这段回应真正播完再返回（流程要求：反应播完才切「我在听」）。 */
    async function speakReactionAndWait(text) {
      if (!text) return;
      const cfg = await loadDshPetVoice();
      if (!(await playDshPetVoice(text, cfg, { wait: true }))) {
        log('唤醒反应朗读失败：dsh-pet 语音合成不可用（保持静音，照常进入听命令）');
      }
    }

    // 设置分区是 React 组件；react 由 DSH 模块系统作为种子模块提供，取不到就只降级设置分区。
    let ReactLike = null;
    try {
      if (typeof require === 'function') ReactLike = require('react');
    } catch {
      ReactLike = null;
    }

    /** document.baseURI 带 DSH 的挂载前缀（反代子路径）。 */
    function extUrl(path, params = {}) {
      const url = new URL('dsh-pet-extend/' + path, document.baseURI);
      for (const [key, value] of new URLSearchParams(location.search)) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value);
      }
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      return url.href;
    }

    /** 与 dsh-pet 自己的 openPetChatTab 同口径：sidebarRight.openTab('pet-chat')。 */
    function openOriginalChat(ctx) {
      const sidebar = ctx.get?.('sidebarRight');
      if (typeof sidebar?.openTab === 'function') {
        sidebar.openTab(CHAT_KIND);
        return { ok: true, method: 'sidebarRight.openTab', kind: CHAT_KIND };
      }
      return { ok: false, method: 'none', error: 'sidebarRight 服务不可用' };
    }

    let hostCtx = null;
    let lastChatOpenAt = 0;

    /** 唤醒可由「audio 响应」和「菜单事件」两条路径命中，1.5 秒内只开一次；右键菜单不受去重影响。 */
    function openChatOnce({ dedup = false } = {}) {
      const at = Date.now();
      if (dedup && at - lastChatOpenAt < 1500) return { ok: true, method: 'dedup', kind: CHAT_KIND };
      lastChatOpenAt = at;
      if (!hostCtx) return { ok: false, method: 'none', error: '客户端上下文未就绪' };
      const result = openOriginalChat(hostCtx);
      // 桌宠常驻时 DSH 主窗口可能在后台，打开标签后顺带置前，避免看起来「没反应」。
      if (result.ok) {
        try { globalThis.focus?.(); } catch {}
      }
      return result;
    }

    /** 同源嵌入 DSH 设置分区，带上当前页面的 token 等查询参数。 */
    function settingsUrl() {
      return extUrl('settings', { embed: 1 });
    }

    /** settings.section 的贡献组件：把插件设置页装进 iframe。 */
    function makeSettingsSection(React) {
      const url = settingsUrl();
      return function PetExtendSettingsSection() {
        return React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: '560px' },
        },
          React.createElement('iframe', {
            src: url,
            title: SETTINGS_SECTION.label,
            allow: 'microphone; autoplay',
            style: {
              display: 'block', width: '100%', flex: '1 1 auto', minHeight: '560px',
              border: 0, background: 'transparent',
            },
          }));
      };
    }

    /** 注册进 DSH 设置导航；slots/react 缺失时只降级设置分区，不影响菜单与语音唤醒。 */
    function registerSettingsSection(ctx) {
      let stopped = false;
      let timer = null;
      let tries = 0;
      let lastError = '';
      let disposeSection = () => {};

      const attempt = () => {
        if (stopped) return true;
        const slots = ctx?.slots ?? ctx?.get?.('slots');
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false;
        if (!ReactLike || typeof ReactLike.createElement !== 'function') {
          log('react 模块不可用，DSH 设置里的「桌宠扩展设置」未注册');
          return true;
        }
        try {
          const dispose = slots.inject('settings.section', function* () {
            yield slots.register({
              name: 'settings.section',
              id: SETTINGS_SECTION.id,
              order: SETTINGS_SECTION.order,
              // 与官方分区一致用 thunk：resolveSlotLabel 会在语言/账本修订变化时重新解析。
              label: () => SETTINGS_SECTION.label,
            }, makeSettingsSection(ReactLike));
          });
          if (typeof dispose === 'function') disposeSection = dispose;
          return true;
        } catch (error) {
          lastError = String(error?.message ?? error);
          return false;
        }
      };

      // 设置外壳可能晚于本插件才声明 settings.section 类型，失败时有限重试。
      const run = () => {
        if (stopped || attempt()) return;
        tries += 1;
        if (tries >= 12) {
          log('注册 DSH 设置分区失败：' + (lastError || 'slots 服务不可用'));
          return;
        }
        timer = setTimeout(run, 500);
        timer.unref?.();
      };
      run();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        disposeSection();
      };
    }

    async function post(path, body) {
      try {
        await fetch(extUrl(path), {
          method: 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
        });
      } catch {
        // 诊断上报失败不影响打开聊天窗口
      }
    }

    /**
     * 抗混叠重采样：设备采样率 → 16kHz。
     * 原来只在原始采样点上做线性插值，48k→16k 时没有任何低通，8k 以上的噪声会折叠进
     * 语音频带，直接拉低 KWS 的 log-mel 置信度（典型表现就是「喊了但检测数不涨」）。
     * 这里先用 Blackman 窗 FIR 把输入带限到目标 Nyquist 的 85%，再线性插值；输出节奏
     * 与原来完全一致（每 1600 样本一块），服务端仍可按块流式解码。
     */
    const LP_TAPS = 127;
    function makeLowPassTaps(fromRate, toRate) {
      const cutoff = Math.min(fromRate, toRate) * 0.5 * 0.85;
      const fc = cutoff / fromRate;
      const taps = new Float64Array(LP_TAPS);
      const center = (LP_TAPS - 1) / 2;
      let sum = 0;
      for (let i = 0; i < LP_TAPS; i += 1) {
        const d = i - center;
        const ideal = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        const window = 0.42
          - 0.5 * Math.cos(2 * Math.PI * i / (LP_TAPS - 1))
          + 0.08 * Math.cos(4 * Math.PI * i / (LP_TAPS - 1));
        taps[i] = ideal * window;
        sum += taps[i];
      }
      for (let i = 0; i < LP_TAPS; i += 1) taps[i] /= sum || 1;
      return taps;
    }

    class Resampler {
      constructor(fromRate, toRate = KWS_RATE) {
        this.step = fromRate / toRate;
        this.taps = fromRate > toRate ? makeLowPassTaps(fromRate, toRate) : null;
        this.tail = new Float32Array(this.taps ? this.taps.length - 1 : 0);
        this.prev = new Float32Array(0);
        this.prevStart = 0;
        this.cur = new Float32Array(0);
        this.curStart = 0;
        this.cursor = 0;
        this.total = 0;
      }

      at(index) {
        if (index >= this.curStart) return this.cur[index - this.curStart] ?? 0;
        if (index >= this.prevStart) return this.prev[index - this.prevStart] ?? 0;
        return 0;
      }

      /** 逐输入样本卷积，只保留最近 N-1 个样本作为下一块的历史。 */
      lowPass(input) {
        if (!this.taps) return input;
        const taps = this.taps;
        const merged = new Float32Array(this.tail.length + input.length);
        merged.set(this.tail, 0);
        merged.set(input, this.tail.length);
        const out = new Float32Array(input.length);
        const offset = this.tail.length;
        for (let i = 0; i < input.length; i += 1) {
          let acc = 0;
          for (let k = 0; k < taps.length; k += 1) {
            const index = offset + i - k;
            if (index < 0) continue;
            acc += merged[index] * taps[k];
          }
          out[i] = acc;
        }
        const keep = taps.length - 1;
        this.tail = merged.length > keep ? merged.slice(merged.length - keep) : merged.slice();
        return out;
      }

      push(input) {
        const filtered = this.lowPass(input);
        this.prev = this.cur;
        this.prevStart = this.curStart;
        this.cur = filtered;
        this.curStart = this.total;
        this.total += filtered.length;
        const out = [];
        while (this.cursor + 1 < this.total) {
          const index = Math.floor(this.cursor);
          const fraction = this.cursor - index;
          const a = this.at(index);
          out.push(a + (this.at(index + 1) - a) * fraction);
          this.cursor += this.step;
        }
        return Float32Array.from(out);
      }
    }

    // 音频全程不做自动增益：客户端只负责重采样与编码，原始 PCM 直接上传。

    function concatBytes(parts) {
      let length = 0;
      for (const part of parts) length += part.length;
      const merged = new Uint8Array(length);
      let at = 0;
      for (const part of parts) { merged.set(part, at); at += part.length; }
      return merged;
    }

    function encodePcm(samples) {
      // 只做 Float32 → Int16 编码必需的数值限幅，不缩放幅度、不自动增益。
      const bytes = new Uint8Array(samples.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i += 1) {
        const value = Number.isFinite(samples[i])
          ? Math.max(-1, Math.min(1, samples[i]))
          : 0;
        view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
      }
      return bytes;
    }

    function takeChunks(pending, extra, size) {
      const merged = new Float32Array(pending.length + extra.length);
      merged.set(pending, 0);
      merged.set(extra, pending.length);
      const chunks = [];
      let at = 0;
      while (at + size <= merged.length) {
        chunks.push(merged.slice(at, at + size));
        at += size;
      }
      return { chunks, rest: merged.slice(at) };
    }

    // ---- 语音任务：唤醒反应结束后继续听一句命令，识别成文字落到 DSH 会话 ----
    /** 一块 PCM 的时长（1600 样本 / 16kHz = 100ms）；端点检测按它累计时长。 */
    const KWS_CHUNK_MS = (KWS_CHUNK / KWS_RATE) * 1000;
    /** 判定「有声」的绝对下限；环境安静时会随底噪继续下调到这一档，不做任何增益。 */
    const VOICE_MIN_RMS = 0.02;
    /** 预录环形缓冲的块数（1 秒）：只给端点检测器做底噪估计，不进命令音频。 */
    const PREROLL_MAX = Math.ceil(1000 / KWS_CHUNK_MS);
    /** 等识别结果的上限：首次要加载 240MB 模型，超时也必须有结局，不能让状态机一直挂着。 */
    const VOICE_TRANSCRIBE_TIMEOUT_MS = 25000;
    /** 等落地（建会话/发 prompt）的上限：卡住时也把结局报给宿主。 */
    const VOICE_LAND_TIMEOUT_MS = 8000;

    /** 单块 RMS：与 KWS 用同一份原始 PCM、同一个电平口径。 */
    function rmsOf(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      return Math.sqrt(sum / (samples.length || 1));
    }

    /**
     * 端点检测状态机：喂 100ms 块，返回结束原因或 null。
     * - silence   说完（说过话之后连续静音够久）
     * - no-speech 开始听后一直没开口 → 静默放弃，等下一轮唤醒
     * - too-short 有声音但有效语音太短（多半是咳嗽/碰撞）→ 放弃
     * - max       到了安全上限
     *
     * 阈值必须是**相对底噪**的：实测这台机器的底噪 RMS 就有 0.023~0.033，
     * 说话也才 0.048~0.072。旧实现把绝对下限写成 0.02（比底噪还低），于是每一块
     * 都被判成「有声」，静音计数永远是 0，只能等到 60 秒上限 —— 表现就是
     * 「说完判定 / 没开口放弃都要等很久，一直在听命令」。
     *
     * 现在的做法：
     * 1. 先用预录段（或头 500ms）估出底噪 floor（取中位数，抗单块尖峰）；
     * 2. 起音阈值 = floor × 1.55 + 0.006：用来判定「开没开口」，比绝对下限稳；
     * 3. 结束（停嘴）判定用**相对峰值**而非「绝对安静」：记录本次说话的峰值 speechRef，
     *    只要能量掉到峰值的 END_FACTOR（0.5）以下就累计静音。这样嘈杂环境里底噪不低、
     *    噪声偶尔起伏也不会把静音计数清零——不要求房间安静，只要用户停嘴即可；
     * 4. floor 只在没开口和静音段缓慢跟随，且封顶 0.06，避免底噪特别大的房间把阈值抬死；
     * 5. 另外加 maxSpeechMs（默认 20 秒）兜底，避免一直说不停时又拖到 60 秒。
     */
    function createEndpointDetector({
      silenceMs = 2000, noSpeechMs = 2000, maxMs = 60000,
      maxSpeechMs = 20000, minRms = VOICE_MIN_RMS, minSpeechMs = 300, seedRms = [],
    } = {}) {
      const bootstrap = (Array.isArray(seedRms) ? seedRms : []).filter((value) => Number.isFinite(value)).slice(-6);
      let floor = bootstrap.length >= 3 ? medianOf(bootstrap) : null;
      const pending = [];
      let elapsed = 0;
      let speechMs = 0;
      let quietMs = 0;
      let sawSpeech = false;
      // 本次说话的峰值（只增不减）：结束判定用「相对它」而非「绝对安静」，
      // 这样嘈杂环境里底噪不低也能正常判停——只要能量明显低于刚才说话的水平就算停嘴。
      let speechRef = 0;
      // 能量掉到峰值的这个比例以下，才算「没在说了」。0.65 对常见信噪比（嘈杂环境里说话约为
      // 底噪的 1.5~2 倍）稳健：既不会因底噪偏高而永远判不出静音，也不会把说话中的自然起伏误判成停嘴。
      const END_FACTOR = 0.65;

      /** 把 floor 收进合理区间：太低会被数字静音带偏，太高会把细声说话当静音。 */
      const calibrate = (value) => Math.min(Math.max(value, minRms * 0.5), 0.06);
      const speechThresholdOf = (value) => Math.max(minRms, calibrate(value) * 1.55 + 0.006);

      return {
        get state() {
          return {
            elapsed, speechMs, quietMs, floor, sawSpeech, speechRef,
            threshold: floor === null ? minRms : speechThresholdOf(floor),
          };
        },
        push(rms, ms = KWS_CHUNK_MS) {
          elapsed += ms;
          if (floor === null) {
            // 没有预录种子时，用头 5 块（500ms）估底噪；期间照常分类，不丢判定。
            pending.push(rms);
            if (pending.length >= 5) floor = medianOf(pending);
          }
          const startThresh = floor === null ? minRms : speechThresholdOf(floor);
          if (rms >= startThresh) {
            sawSpeech = true;
            speechMs += ms;
            quietMs = 0;
            if (rms > speechRef) speechRef = rms; // 仅增长：代表本次说话的峰值
          } else {
            // 底噪跟随必须非对称：往下快、往上只允许在「贴着底噪」的窄带里慢慢爬。
            // 否则说话时的中等电平块（本例 0.048~0.053）被判成静音后会反过来抬高低噪，
            // 阈值一路升到 0.06，把自己刚检出的语音又判成静音——那是个正反馈死循环。
            if (rms < floor) floor = floor * 0.7 + rms * 0.3;
            else if (rms < floor * 1.45) floor = floor * 0.992 + rms * 0.008;
            if (sawSpeech) {
              // 结束判定：相对峰值，不要求房间安静。嘈杂环境里只要用户停嘴（能量明显
              // 低于刚才说话的水平）就累计静音；噪声偶尔起伏但若仍低于峰值一半就不影响。
              if (rms < speechRef * END_FACTOR) quietMs += ms;
              else quietMs = 0;
            }
          }
          if (!sawSpeech && elapsed >= noSpeechMs) return 'no-speech';
          if (sawSpeech && quietMs >= silenceMs) return speechMs >= minSpeechMs ? 'silence' : 'too-short';
          if (sawSpeech && speechMs >= maxSpeechMs) return 'max';
          if (elapsed >= maxMs) return 'max';
          return null;
        },
      };
    }

    /** 一组数的中位数（用于底噪估计，抗单块尖峰）。 */
    function medianOf(values) {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /** 最近 1 秒编码后的 PCM：只用来给端点检测器做底噪估计，不进命令音频。 */
    const preroll = [];
    const voice = {
      active: false,
      config: null,
      /** 本次唤醒要朗读的回应文案（收音与朗读并行，收官时从转写里剥掉）。 */
      reactionText: '',
      chunks: [],
      bytes: 0,
      detector: null,
      startedAt: 0,
      timer: null,
      probeAt: 0,
      probeOk: false,
      generation: 0,
    };
    /** 当前挂载的输入面板（conversation.input.activity）：current 目标与 auto 模式靠它落地。 */
    let inputBridge = null;

    /** 黑名单：auto 模式下命中就降级成草稿，必须人工按回车。 */
    function blockedByKeywords(text, list) {
      const words = String(list || '').split(/[,，\s]+/).map((word) => word.trim()).filter(Boolean);
      const lower = String(text || '').toLowerCase();
      for (const word of words) if (lower.includes(word.toLowerCase())) return word;
      return '';
    }

    /** 官方转写是否可用（30 秒缓存，避免每次唤醒都多一次请求）。 */
    async function speechAvailable() {
      if (Date.now() - voice.probeAt < 30000) return voice.probeOk;
      let ok = false;
      try {
        const res = await fetch(extUrl('api/voice/status'), { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        ok = body?.speech?.available === true;
      } catch {
        ok = false;
      }
      voice.probeAt = Date.now();
      voice.probeOk = ok;
      return ok;
    }

    /**
     * 进入听命令：从这一刻起才开始录（不在命令里混入唤醒词之前的尾音）。
     * 仍拿预录环里最近几块的 RMS 给端点检测器做底噪估计，让它一开机就出判定，
     * 但这几块音频不进命令（所以「あれ？」之类不会录进去）。
     */
    function beginListening(config, reactionText) {
      voice.active = true;
      voice.config = config;
      // 记住这次要朗读的回应：反应播放期间麦克风仍在采，收官时用它把混进来的那句剥掉。
      voice.reactionText = String(reactionText || '');
      voice.chunks = [];
      voice.bytes = 0;
      voice.startedAt = Date.now();
      voice.generation += 1;
      const floorSeed = preroll.slice(-6).map((entry) => entry.rms).filter(Number.isFinite);
      voice.detector = createEndpointDetector({
        silenceMs: Number(config?.silenceMs) || 2000,
        noSpeechMs: Number(config?.noSpeechMs) || 2000,
        maxMs: Number(config?.maxMs) || 60000,
        // 预录环最近几块的 RMS（不含音频）：让底噪估计秒级收敛，比头 500ms 更准。
        seedRms: floorSeed,
      });
      log(`开始听命令（静音 ${Number(config?.silenceMs) || 2000}ms 结束，${Number(config?.noSpeechMs) || 2000}ms 没开口就放弃）`);
      announceListening(config);
      // 麦克风被别的路径停掉时不会有新块进来，用一个兜底定时器保证状态复位。
      const limit = (Number(config?.maxMs) || 60000) + 2000;
      voice.timer = setTimeout(() => { void finishListening('max'); }, limit);
      voice.timer.unref?.();
    }

    /** 丢弃当前命令（页面隐藏/设备重启/用户取消）。 */
    function cancelListening(reason) {
      if (!voice.active) return;
      voice.active = false;
      voice.generation += 1;
      voice.chunks = [];
      voice.bytes = 0;
      voice.detector = null;
      if (voice.timer !== null) { clearTimeout(voice.timer); voice.timer = null; }
      // 告诉宿主「这次听命令结束了」：宿主用它解除唤醒反应抑制窗口，否则下一次唤醒会静默。
      void post('api/voice/result', { ok: false, reason: 'cancelled', verdict: reason });
      log('放弃这次语音命令：' + reason);
    }

    /** 说完/放弃：静音或太短就静默收场，其余情况送去转写并落地。 */
    async function finishListening(verdict) {
      if (!voice.active) return;
      const config = voice.config;
      const generation = voice.generation;
      const pcm = concatBytes(voice.chunks);
      const bytes = voice.bytes;
      const elapsedMs = Date.now() - voice.startedAt;
      voice.active = false;
      voice.chunks = [];
      voice.bytes = 0;
      voice.detector = null;
      if (voice.timer !== null) { clearTimeout(voice.timer); voice.timer = null; }

      if (verdict === 'no-speech' || verdict === 'too-short' || pcm.length < 3200) {
        // 静默放弃：不朗读、不弹新气泡，等下一轮唤醒。
        void post('api/voice/result', { ok: false, reason: 'no-speech', verdict, ms: elapsedMs, bytes });
        return;
      }

      // 收音已经结束：先解除宿主的「听命令」状态，否则设置页会一直停在「正在听命令」。
      void post('api/voice/transcribing', { ms: elapsedMs, bytes });
      // 模型可能还没加载完：这里发一次预热，不阻塞后面的转写请求。
      void fetch(extUrl('api/voice/prepare'), { method: 'POST', cache: 'no-store' }).catch(() => {});
      let body = null;
      const abort = new AbortController();
      // 首次识别要加载 240MB 模型，但再慢也不该无限等：超时后按失败收场，
      // 保证宿主一定能收到结局（否则状态机会一直挂着）。
      const timer = setTimeout(() => abort.abort(), VOICE_TRANSCRIBE_TIMEOUT_MS);
      try {
        const res = await fetch(extUrl('api/voice/command', { language: config?.language }), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: pcm,
          cache: 'no-store',
          signal: abort.signal,
        });
        body = await res.json().catch(() => null);
      } catch (error) {
        body = { ok: false, reason: abort.signal.aborted ? 'transcribe-timeout' : 'transcribe-failed', message: String(error?.message ?? error) };
      } finally {
        clearTimeout(timer);
      }
      if (generation !== voice.generation) return;

      if (!body || body.ok !== true) {
        const reason = body?.reason || 'transcribe-failed';
        log('语音命令识别失败：' + reason + (body?.message ? ' · ' + body.message : ''));
        void post('api/voice/result', { ok: false, reason, ms: elapsedMs, bytes, message: body?.message });
        return;
      }
      // 收音与朗读并行：开头会把「我在听」录进去，预录段还会带上唤醒词的尾巴，先剥掉再当命令。
      const text = stripWakeWordPrefix(stripReactionText(body.text, voice.reactionText), config?.wakeWords);
      if (!text) {
        // 只录到唤醒回应、用户其实没说话：静默收场。
        void post('api/voice/result', { ok: false, reason: 'empty-transcript', ms: elapsedMs, bytes });
        return;
      }

      const landed = await Promise.race([
        landVoiceTask(text, config),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ landed: false, reason: 'land-timeout' }), VOICE_LAND_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      void post('api/voice/result', {
        ok: true,
        text,
        ms: elapsedMs,
        bytes,
        inferMs: body.ms ?? null,
        mode: config?.mode,
        target: config?.target,
        ...landed,
      });
    }

    /** 落地到 DSH：新建/当前会话 × 草稿/直接执行。 */
    async function landVoiceTask(text, config) {
      const ctx = hostCtx;
      if (!ctx) return { landed: false, reason: 'context-unavailable' };
      const auto = config?.mode === 'auto';
      const target = config?.target === 'current' ? 'current' : 'new';
      const blocked = blockedByKeywords(text, config?.blockedKeywords);
      if (auto && blocked) log(`语音任务命中黑名单「${blocked}」，降级为草稿`);
      const run = auto && !blocked;

      if (target === 'current') {
        const actions = inputBridge?.actions;
        if (actions && typeof actions.setDraft === 'function') {
          try {
            if (run) {
              // 直接执行：整条替换成这句命令再发送，绝不把用户写到一半的草稿一起发出去。
              actions.setDraft(text);
              actions.submit();
            } else if (typeof actions.insertText === 'function' && typeof actions.captureInsertion === 'function') {
              // 草稿确认：插到光标处，不覆盖用户自己正在写的内容。
              actions.insertText(text, actions.captureInsertion());
            } else {
              actions.setDraft(text);
            }
          } catch (error) {
            return { landed: false, reason: 'set-draft-failed', message: String(error?.message ?? error) };
          }
          try { globalThis.focus?.(); } catch {}
          return { landed: true, run, target, mode: run ? 'auto' : 'draft' };
        }
        // 当前会话拿不到输入面板（旧版 DSH 没有这个槽位时会这样）：退回新会话，
        // 至少别让这句命令丢掉；诊断里记下退回来的原因。
        log('当前会话的输入面板不可用，这句命令改为落到新会话');
        return { ...(await landNewSession(ctx, text, run)), fallbackFrom: 'current' };
      }

      return landNewSession(ctx, text, run);
    }

    /** 新建会话落地：草稿走 startSession，直接执行走 sessions.create + prompt。 */
    async function landNewSession(ctx, text, run) {
      const ui = ctx.get?.('uiWorkspace');
      if (!run) {
        if (typeof ui?.startSession !== 'function') return { landed: false, reason: 'ui-workspace-unavailable' };
        try {
          ui.startSession(undefined, { prompt: text, clearPreviousDraft: true });
        } catch (error) {
          return { landed: false, reason: 'start-session-failed', message: String(error?.message ?? error) };
        }
        try { globalThis.focus?.(); } catch {}
        return { landed: true, run: false, target: 'new', mode: 'draft' };
      }

      // 直接执行：自己建会话 + 发 prompt，不依赖界面是否挂载完。
      const sessions = ctx.get?.('sessions');
      if (!sessions || typeof sessions.create !== 'function' || typeof sessions.retain !== 'function') {
        return { landed: false, reason: 'sessions-unavailable' };
      }
      try {
        const workspaceId = currentWorkspaceId(ctx);
        const id = await sessions.create(workspaceId ? { workspaceId } : {});
        const ref = sessions.retain(id, { source: 'petVoice' });
        try {
          const binding = await ref.ready;
          const result = await binding.session.prompt([{ type: 'text', text }], 'queue');
          if (!result || result.ok !== true) {
            return { landed: false, reason: result?.error?.code || 'prompt-failed' };
          }
          // 先跳过去再释放引用：释放后这一代会话的客户端作用域可能立刻被回收。
          ui?.openSession?.(id);
          try { globalThis.focus?.(); } catch {}
        } finally {
          try { ref.release?.(); } catch {}
        }
        return { landed: true, run: true, target: 'new', mode: 'auto', sessionId: String(id) };
      } catch (error) {
        return { landed: false, reason: 'auto-run-failed', message: String(error?.message ?? error) };
      }
    }

    /** 当前会话所属工作区：优先用它，避免新建的会话掉进 Ungrouped。 */
    function currentWorkspaceId(ctx) {
      try {
        const snapshot = ctx?.get?.('workspaces')?.list?.getSnapshot?.();
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const sessionId = inputBridge?.sessionId;
        if (sessionId) {
          const hit = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
          if (hit?.workspaceId) return hit.workspaceId;
        }
        return items.length === 1 ? items[0].workspaceId : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 唤醒命中后的主流程（用户指定顺序，不预录）：
     *   唤醒词 → 唤醒反应念完「我在」→ 语音播放一结束，立刻切「我在听」并开始录音。
     * 命令只在反应播完之后录，所以不会把唤醒词之前的尾音（例：「あれ？」）带进来。
     */
    async function runVoiceTask(config, reactionText) {
      if (voice.active) return;
      if (voice.probeAt === 0 || Date.now() - voice.probeAt >= 30000) {
        // 预热与可用性探测并行：模型懒加载时这一步能省掉几百毫秒。
        void fetch(extUrl('api/voice/prepare'), { method: 'POST', cache: 'no-store' }).catch(() => {});
      }
      if (!(await speechAvailable())) {
        // 官方转写不可用：退回老行为，至少把桌宠对话打开，并留下可查的原因。
        log('语音任务不可用：官方语音识别服务缺失，回退为打开桌宠对话');
        openChatOnce({ dedup: false });
        void post('api/voice/result', { ok: false, reason: 'speech-service-unavailable' });
        return;
      }
      // 先念完「我在」（反应播放结束才返回），再立刻切「我在听」并开录音——零等待衔接。
      await speakReactionAndWait(reactionText);
      beginListening(config, reactionText);
    }

    /** 唤醒反应播完：把气泡切「我在听」，并让宿主开启「正在听命令」窗口。 */
    function announceListening(config) {
      void post('api/voice/listen', { text: config?.listenText });
    }

    /**
     * 剥掉转写结果开头的唤醒词残片（预录段会带上「大肥鱼」的尾巴，例如「鱼帮我…」）。
     * 只认唤醒词本身与它的 2 字以上后缀，且必须出现在开头 2 个字以内。
     */
    function stripWakeWordPrefix(text, wakeWords) {
      let out = String(text || '').trim();
      if (!out) return out;
      for (const raw of Array.isArray(wakeWords) ? wakeWords : []) {
        const word = String(raw || '').replace(/\s+/g, '');
        if (word.length < 2) continue;
        const candidates = [word];
        for (let len = word.length - 1; len >= 2; len -= 1) candidates.push(word.slice(-len));
        for (const candidate of candidates) {
          const at = out.indexOf(candidate);
          if (at >= 0 && at <= 2) {
            out = (out.slice(0, at) + out.slice(at + candidate.length))
              .replace(/^[\s，。！？、,.!?~…]+/, '')
              .trim();
            break;
          }
        }
      }
      return out;
    }

    /**
     * 从转写结果里剥掉开头那句唤醒回应（朗读被麦克风录进去的部分）。
     * 只处理开头 4 个字符以内出现的整句匹配，避免误删用户真说的话。
     */
    function stripReactionText(text, reactionText) {
      const body = String(text || '').trim();
      const spoken = String(reactionText || '').trim();
      if (!body || !spoken) return body;
      const candidates = [spoken, ...spoken.split(/[\n，,。！？、/]+/).map((item) => item.trim())]
        .filter((item) => item.length >= 2);
      const cleaned = body.replace(/^[\s，。！？、,.!?~…]+/, '');
      for (const candidate of candidates) {
        const at = cleaned.indexOf(candidate);
        if (at >= 0 && at <= 4) {
          return (cleaned.slice(0, at) + cleaned.slice(at + candidate.length))
            .replace(/^[\s，。！？、,.!?~…]+/, '')
            .trim();
        }
      }
      return body;
    }

    /** conversation.input.activity 的隐形组件：只为了拿到当前会话的 inputActions。 */
    function makeInputBridge(React) {
      return function PetExtendInputBridge(props) {
        const sessionId = props?.sessionId;
        const inputActions = props?.inputActions;
        React.useEffect(() => {
          inputBridge = { sessionId, actions: inputActions };
          return () => {
            if (inputBridge?.actions === inputActions) inputBridge = null;
          };
        }, [sessionId, inputActions]);
        return null;
      };
    }

    /** 注册输入桥（槽位类型可能晚于本插件声明，失败时有限重试）。 */
    function registerInputBridge(ctx) {
      let stopped = false;
      let timer = null;
      let tries = 0;
      let disposeBridge = () => {};
      const attempt = () => {
        if (stopped) return true;
        const slots = ctx?.slots ?? ctx?.get?.('slots');
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false;
        if (!ReactLike || typeof ReactLike.useEffect !== 'function') {
          log('react 不可用，当前会话模式（voiceTaskTarget=current）不可用');
          return true;
        }
        try {
          const dispose = slots.inject('conversation.input.activity', function* () {
            yield slots.register({ name: 'conversation.input.activity' }, makeInputBridge(ReactLike));
          });
          if (typeof dispose === 'function') disposeBridge = dispose;
          return true;
        } catch {
          return false;
        }
      };
      const run = () => {
        if (stopped || attempt()) return;
        tries += 1;
        if (tries >= 20) {
          log('注册输入桥失败：conversation.input.activity 槽位不可用');
          return;
        }
        timer = setTimeout(run, 500);
        timer.unref?.();
      };
      run();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        disposeBridge();
        inputBridge = null;
      };
    }

    // AudioWorklet 的 process() 每次只有 128 帧（48k 下约 2.7ms）。如果每帧都 postMessage，
    // 主线程每秒要处理约 375 条消息，实测会造成音频延迟/丢帧/顺序抖动，表现为「引擎在解码但
    // 永远不吐词」。这里在 worklet 内部攒到 4096 帧（约 85~93ms）再发一次，与 ScriptProcessor
    // 的 4096 缓冲同量级，把消息频率降到约 12 次/秒。
    const WORKLET_SOURCE = [
      'class DshPetPcmProcessor extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super();',
      '    this.buffer = new Float32Array(4096);',
      '    this.offset = 0;',
      '  }',
      '  process(inputs) {',
      '    const channel = inputs[0] && inputs[0][0];',
      '    if (!channel || !channel.length) return true;',
      '    let read = 0;',
      '    while (read < channel.length) {',
      '      const take = Math.min(channel.length - read, this.buffer.length - this.offset);',
      '      this.buffer.set(channel.subarray(read, read + take), this.offset);',
      '      this.offset += take;',
      '      read += take;',
      '      if (this.offset === this.buffer.length) {',
      '        const copy = new Float32Array(this.buffer);',
      '        this.port.postMessage(copy, [copy.buffer]);',
      '        this.offset = 0;',
      '      }',
      '    }',
      '    return true;',
      '  }',
      '}',
      "registerProcessor('dsh-pet-pcm-processor', DshPetPcmProcessor);",
    ].join('\n');

    function installEventListener(ctx) {
      const controller = new AbortController();
      let stopped = false;

      async function loop() {
        await post('api/hello');
        while (!stopped && !controller.signal.aborted) {
          // 桌面宠物右键时 DSH 主窗口常在后台，不能因 document.hidden 暂停消费。
          try {
            const res = await fetch(extUrl('api/menu-event', { wait: 5000 }), {
              cache: 'no-store',
              signal: controller.signal,
            });
            const body = await res.json().catch(() => null);
            for (const event of body?.events ?? []) {
              // 宿主只发布 open；忽略旧版本/残留的设置事件，避免误开聊天标签。
              if (event.action && event.action !== 'open') continue;
              const result = openChatOnce({ dedup: event.source === 'kws' });
              if (!result.ok) log(result.error ?? '打开桌宠对话失败');
              await post('api/open-result', { ...result, pet: event.pet });
            }
          } catch {
            if (controller.signal.aborted) break;
          }
          await sleep(150);
        }
      }

      void loop();
      return () => {
        stopped = true;
        controller.abort();
      };
    }

    /** 麦克风 → KWS 会话 → PCM 上报；KWS 命中的事件由上面的 menu-event 循环消费。 */
    function installWakeWord() {
      const controller = new AbortController();
      const signal = controller.signal;
      let stopped = false;
      let sessionId = null;
      let mediaStream = null;
      let audioContext = null;
      let graphDispose = null;
      let gestureDispose = null;
      let resampler = null;
      let pending = new Float32Array(0);
      let queue = Promise.resolve();
      let uploadBuffer = [];
      const AUDIO_TIMEOUT_MS = 1500;
      const MAX_BATCH_CHUNKS = 4;
      let listening = false;
      let lastChunkAt = 0;
      let lastUploadAt = 0;
      let watchdogTimer = null;
      let restarting = false;
      let lastRestartAt = 0;

      async function fetchJson(path, params = {}, init = {}) {
        const res = await fetch(extUrl(path, params), { cache: 'no-store', signal, ...init });
        return res.json().catch(() => null);
      }

      function report(state, extra = {}) {
        return post('api/kws/client-state', { state, ...extra });
      }

      async function ensureSession() {
        if (sessionId) return sessionId;
        const body = await fetchJson('api/kws/session', {}, { method: 'POST' });
        if (!body?.ok || !body.sessionId) throw new Error(body?.reason ?? 'kws-session-failed');
        sessionId = body.sessionId;
        return sessionId;
      }

      /** 单次音频请求带超时：原来挂在队列里的一个挂起请求会一直阻塞后续全部音频。 */
      async function postAudioChunk(id, body) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal.aborted) controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);
        try {
          const res = await fetch(extUrl('api/kws/audio', { session: id, rate: KWS_RATE }), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
            cache: 'no-store',
            signal: controller.signal,
          });
          return res.json().catch(() => null);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        }
      }

      function sendPcm(bytes) {
        if (stopped) return;
        uploadBuffer.push(bytes);
        // 极端积压时丢最旧的块：宁可少 100ms 旧音频，也不能让唤醒响应排到几秒之后。
        if (uploadBuffer.length > 24) uploadBuffer.shift();
        // 串行上报保证流式解码顺序；正常时每块一个请求（100ms 延迟），请求变慢导致
        // 积压时一次任务合并多块发送，快速追上实时音频，不让队列越排越长。
        queue = queue.then(async () => {
          if (stopped) return;
          const batch = uploadBuffer.splice(0, MAX_BATCH_CHUNKS);
          if (batch.length === 0) return;
          const id = await ensureSession();
          const body = batch.length === 1 ? batch[0] : concatBytes(batch);
          const response = await postAudioChunk(id, body);
          lastUploadAt = Date.now();
          if (response?.ok === false && response.reason === 'session-not-found') {
            sessionId = null;
            // 服务端明确说这个会话不存在 = 这批音频没有被解码。放回队列重发，不能直接丢：
            // 「重新初始化引擎」清空会话、或会话超时，正好赶上说话时会把整段唤醒词截断。
            uploadBuffer.unshift(...batch);
            if (uploadBuffer.length > 48) uploadBuffer.length = 48;
          }
          // 主路径：唤醒命中会随这次 audio 响应返回，不依赖长轮询事件能否被及时取走。
          if (response?.triggered === true) {
            // 已经在听命令时再次命中，说明是命令音频里的同名词被 KWS 捞到，忽略。
            if (voice.active) return;
            const voiceConfig = response.voiceTask;
            if (voiceConfig?.enabled === true) {
              // 语音任务：不打开 pet-chat，改为「播放完唤醒反应 → 继续听一句命令」。
              void post('api/open-result', { ok: true, method: 'voice-task', kind: CHAT_KIND, pet: 'kws', source: 'audio-reply' });
              void runVoiceTask(voiceConfig, response.reactionText);
              return;
            }
            const result = openChatOnce({ dedup: true });
            void post('api/open-result', { ...result, pet: 'kws', source: 'audio-reply' });
            // 回应文案随响应带回，按 dsh-pet 音色朗读，失败再本地兜底。
            if (response.reactionText) void speakReaction(response.reactionText);
          }
        }).catch(() => {});
      }

      /** 每块 PCM 都顺手记进预录环形缓冲；听命令期间同时参与端点判定。 */
      function noteVoiceChunk(samples, bytes) {
        const rms = rmsOf(samples);
        preroll.push({ bytes, rms });
        if (preroll.length > PREROLL_MAX) preroll.shift();
        if (!voice.active) return;
        voice.chunks.push(bytes);
        voice.bytes += bytes.length;
        const verdict = voice.detector?.push(rms);
        if (verdict) void finishListening(verdict);
      }

      function onChunk(chunk) {
        if (stopped || !resampler || !(chunk instanceof Float32Array)) return;
        lastChunkAt = Date.now();
        const batched = takeChunks(pending, resampler.push(chunk), KWS_CHUNK);
        pending = batched.rest;
        for (const part of batched.chunks) {
          const bytes = encodePcm(part);
          noteVoiceChunk(part, bytes);
          sendPcm(bytes);
        }
      }

      async function attachWorklet(context, source) {
        if (!context.audioWorklet?.addModule || typeof globalThis.AudioWorkletNode !== 'function'
          || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') return null;
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
          await context.audioWorklet.addModule(url);
          const node = new globalThis.AudioWorkletNode(context, 'dsh-pet-pcm-processor');
          // event.data 已经是转移过来的 Float32Array（4096 帧），不要再复制一次。
          node.port.onmessage = (event) => onChunk(
            event.data instanceof Float32Array ? event.data : new Float32Array(event.data),
          );
          source.connect(node);
          const sink = context.createGain();
          sink.gain.value = 0; // 只把输出汇点静音防回授，不改变采集到的电平
          node.connect(sink);
          sink.connect(context.destination);
          return () => {
            node.port.onmessage = null;
            try { node.disconnect(); } catch {}
            try { sink.disconnect(); } catch {}
          };
        } catch {
          return null;
        } finally {
          // addModule 的模块加载是异步的，立刻 revoke 在部分 Electron 版本会让模块加载失败、
          // worklet 静默不工作；延后释放。
          setTimeout(() => { try { URL.revokeObjectURL?.(url); } catch {} }, 1000);
        }
      }

      function attachScriptProcessor(context, source) {
        if (typeof context.createScriptProcessor !== 'function') {
          throw new Error('浏览器不支持 AudioWorklet 或 ScriptProcessor');
        }
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
        const sink = context.createGain();
        sink.gain.value = 0; // 只把输出汇点静音防回授，不改变采集到的电平
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
        return () => {
          node.onaudioprocess = null;
          try { node.disconnect(); } catch {}
          try { sink.disconnect(); } catch {}
        };
      }

      async function startGraph(stream) {
        const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctor) throw new Error('AudioContext 不可用');
        // 用设备默认采样率，再交给 Resampler 转 16k：部分 Electron/Windows 组合下把
        // sampleRate 强设成 16000 的 MediaStreamSource 会稳定输出静音，表现为「在监听但永不唤醒」。
        const context = new Ctor();
        audioContext = context;
        if (context.state === 'suspended') await context.resume?.();
        const rate = Number(context.sampleRate) || KWS_RATE;
        resampler = new Resampler(rate, KWS_RATE);
        pending = new Float32Array(0);
        const source = context.createMediaStreamSource(stream);
        const dispose = (await attachWorklet(context, source)) ?? attachScriptProcessor(context, source);
        graphDispose = () => {
          try { source.disconnect(); } catch {}
          dispose();
        };
        return rate;
      }

      function waitForGesture() {
        const doc = globalThis.document;
        if (!doc?.addEventListener) return Promise.resolve();
        return new Promise((resolve) => {
          const types = ['pointerdown', 'keydown', 'touchstart'];
          const done = () => {
            for (const type of types) doc.removeEventListener(type, done, true);
            signal.removeEventListener('abort', done);
            resolve();
          };
          for (const type of types) doc.addEventListener(type, done, true);
          signal.addEventListener('abort', done, { once: true });
          gestureDispose = done;
        });
      }

      // 不请求任何自动增益：麦克风电平完全由用户和操作系统决定，插件不改动音量。
      // 部分 Windows 驱动开启降噪/回声消除后会输出静音，所以首选全关的约束，
      // 采集失败再依次降级（最后一档才启用驱动侧处理，但仍不请求自动增益）。
      const MIC_CONSTRAINTS = [
        // WebRTC 里这三项默认就是 true，写 false 只是 ideal、设备可以忽略并继续降噪。
        // 开启后 Windows 驱动会把持续人声压到底噪水平（实测前 0.9 秒只剩 0.03），
        // 所以首选 exact:false 强制关闭；不支持会抛 OverconstrainedError 走下一档。
        { audio: { channelCount: 1, echoCancellation: { exact: false }, noiseSuppression: { exact: false }, autoGainControl: { exact: false } }, video: false },
        { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false },
        { audio: { autoGainControl: false }, video: false },
        { audio: true, video: false },
      ];
      const MIC_PERMISSION_ERRORS = ['NotAllowedError', 'SecurityError', 'PermissionDeniedError'];
      const MIC_DEVICE_ERRORS = ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'];

      /** 设备/约束导致的 NotFoundError 换成最宽松约束再试；权限被拒则等一次用户手势。 */
      async function requestMicrophone(allowGesture) {
        const devices = globalThis.navigator?.mediaDevices;
        if (!devices?.getUserMedia) {
          throw new Error('navigator.mediaDevices.getUserMedia 不可用（需要安全上下文与麦克风权限）');
        }
        let lastError = null;
        for (const constraints of MIC_CONSTRAINTS) {
          try {
            return await devices.getUserMedia(constraints);
          } catch (error) {
            lastError = error;
            const denied = MIC_PERMISSION_ERRORS.includes(error?.name);
            if (denied && allowGesture) {
              await waitForGesture();
              if (stopped) return null;
              return requestMicrophone(false);
            }
            if (denied) throw error;
          }
        }
        throw lastError ?? new Error('麦克风不可用');
      }

      async function openMicrophone() {
        return requestMicrophone(true);
      }

      function stopMedia() {
        try { graphDispose?.(); } catch {}
        graphDispose = null;
        for (const track of mediaStream?.getTracks?.() ?? []) {
          // 先摘掉 ended 回调：部分 Chromium 在 track.stop() 时会触发 ended，
          // 若不清掉会被当成「掉线」再次重启，形成重启风暴导致彻底采集不到。
          try { track.onended = null; } catch {}
          try { track.stop(); } catch {}
        }
        mediaStream = null;
        if (audioContext) void Promise.resolve(audioContext.close?.()).catch(() => {});
        audioContext = null;
        resampler = null;
        pending = new Float32Array(0);
        // 采集停了就不会再有音频块进来，正在听的命令必须显式收尾，否则会一直挡住下一次唤醒。
        cancelListening('media-stopped');
        if (sessionId) {
          void fetch(extUrl('api/kws/session', { session: sessionId }), {
            method: 'DELETE',
            cache: 'no-store',
          }).catch(() => {});
          sessionId = null;
        }
      }

      /** 打开麦克风并建立音频图；成功即进入监听，之后由 watchdog 与事件负责恢复。 */
      async function captureOnce() {
        while (!stopped) {
          try {
            const stream = await openMicrophone();
            if (stopped) {
              for (const track of stream?.getTracks?.() ?? []) track.stop?.();
              return;
            }
            mediaStream = stream;
            const track = stream?.getAudioTracks?.()[0] ?? stream?.getTracks?.()[0];
            if (track) {
              // 轨道结束（设备被拔/被系统收回）时重开采集，避免「一次掉线永久失效」。
              track.onended = () => { if (!stopped) void restartCapture('track-ended'); };
            }
            await ensureSession();
            const rate = await startGraph(stream);
            listening = true;
            lastChunkAt = Date.now();
            lastUploadAt = Date.now();
            startWatchdog();
            await report('listening', { sampleRate: rate, targetRate: KWS_RATE });
            return;
          } catch (error) {
            stopMedia();
            const reason = String(error?.message ?? error);
            const denied = MIC_PERMISSION_ERRORS.includes(error?.name);
            const noDevice = MIC_DEVICE_ERRORS.includes(error?.name);
            await report(denied ? 'permission-denied' : (noDevice ? 'no-microphone' : 'error'), { reason });
            log('语音唤醒未启动：' + (noDevice
              ? '没有检测到可用麦克风，请检查系统默认录音设备与隐私授权'
              : reason));
            if (denied || stopped) return;
            await wait(15000);
          }
        }
      }

      /** 后台/隐藏时浏览器可能挂起 AudioContext 或让音频图停摆：重开一次采集。 */
      async function restartCapture(reason) {
        if (stopped || restarting) return;
        // 冷却：避免多个事件（ended / stalled / 上传卡住）在同一时间互相触发重启风暴。
        const at = Date.now();
        if (at - lastRestartAt < 2000) return;
        lastRestartAt = at;
        restarting = true;
        listening = false;
        log('重新开始麦克风采集：' + reason);
        try {
          // 解除可能卡住的串行上传队列，避免一次挂起的请求永久阻塞后续音频。
          queue = Promise.resolve();
          uploadBuffer = [];
          stopMedia();
          await report('restarting', { reason });
          await captureOnce();
        } finally {
          restarting = false;
        }
      }

      /**
       * 采集守护：窗口隐藏时 Chromium 会挂起/节流音频图，导致「有时能唤醒、有时不能」。
       * 每 3 秒检查一次——被挂起就 resume，彻底停摆（8 秒无音频回调）就重开采集。
       */
      function startWatchdog() {
        if (watchdogTimer !== null) return;
        watchdogTimer = setInterval(() => {
          if (stopped || !listening) return;
          const ctx = audioContext;
          if (!ctx) { void restartCapture('graph-missing'); return; }
          if (ctx.state === 'suspended') {
            void ctx.resume?.().catch(() => {});
          } else if (ctx.state === 'closed') {
            void restartCapture('audio-context-closed');
          } else if (lastChunkAt > 0 && Date.now() - lastChunkAt > 8000) {
            void restartCapture('audio-stalled');
          } else if (lastUploadAt > 0 && Date.now() - lastUploadAt > 12000) {
            // 图在出数据但上传卡住（会话建不起来 / 请求挂起）：重开采集并重建会话。
            void restartCapture('upload-stalled');
          }
        }, 3000);
        watchdogTimer.unref?.();
      }

      function stopWatchdog() {
        if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
      }

      async function run() {
        while (!stopped) {
          const status = await fetchJson('api/kws/status').catch(() => null);
          if (stopped) return;
          if (status && status.enabled === false) {
            // 关掉后仍保持轮询：用户随时可能在设置页重新开启，无需刷新 DSH 页面。
            // 必须真正释放麦克风，否则设置页申请权限/录入会撞上 NotReadableError
            //（Windows 很多设备不允许两路同时打开，报「Could not start audio source」）。
            stopWatchdog();
            stopMedia();
            listening = false;
            await report('disabled');
            await wait(5000);
            continue;
          }
          // 只有录入声纹并在设置页启用后，宿主才会把 readyToListen 置为 true。
          if (status?.readyToListen === true) break;
          await report(status?.state === 'error' ? 'engine-error' : 'waiting-engine', {
            reason: status?.reason ?? null,
          });
          await wait(5000);
        }
        await captureOnce();
      }

      /** 回到前台/获得焦点时立即恢复被挂起的音频上下文（隐藏期间 Chromium 会挂起它）。 */
      const resumeAudio = () => {
        if (stopped) return;
        if (audioContext && audioContext.state !== 'running') {
          void audioContext.resume?.().catch(() => {});
        }
      };
      const doc = globalThis.document;
      doc?.addEventListener?.('visibilitychange', resumeAudio);
      doc?.addEventListener?.('focus', resumeAudio);
      doc?.addEventListener?.('resume', resumeAudio);
      globalThis.addEventListener?.('pageshow', resumeAudio);

      void run();
      return () => {
        stopped = true;
        controller.abort();
        gestureDispose?.();
        stopWatchdog();
        doc?.removeEventListener?.('visibilitychange', resumeAudio);
        doc?.removeEventListener?.('focus', resumeAudio);
        doc?.removeEventListener?.('resume', resumeAudio);
        globalThis.removeEventListener?.('pageshow', resumeAudio);
        stopMedia();
      };
    }

    function apply(ctx) {
      hostCtx = ctx;
      const disposeMenu = installEventListener(ctx);
      const disposeWake = installWakeWord();
      const disposeSection = registerSettingsSection(ctx);
      const disposeInput = registerInputBridge(ctx);
      ctx.effect?.(() => () => {
        disposeMenu();
        disposeWake();
        disposeSection();
        disposeInput();
      }, 'dsh-pet-extend: cleanup');
    }

    return {
      name, inject, apply,
      _internals: {
        Resampler, concatBytes, encodePcm, takeChunks,
        KWS_RATE, KWS_CHUNK, SETTINGS_SECTION,
        KWS_CHUNK_MS, rmsOf, createEndpointDetector, blockedByKeywords, PREROLL_MAX,
        pickDshPetVoiceId, pickEdgeFallback, stripReactionText, stripWakeWordPrefix,
      },
    };
  },
});
