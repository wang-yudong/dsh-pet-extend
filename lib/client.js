/**
 * dsh-pet-extend 客户端半侧：
 * - 在 DSH 设置里新增「桌宠扩展设置」分区（settings.section slot），嵌入插件自带的设置页；
 * - 接收宿主转发的右键菜单点击 / 语音唤醒事件，打开 dsh-pet 原本的「桌宠对话」标签；
 * - 采集麦克风（getUserMedia + AudioWorklet，失败回退 ScriptProcessor），重采样为
 *   16kHz 单声道 Int16LE PCM，分片上传给宿主的 sherpa-onnx KWS 引擎。
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

    /** 读 dsh-pet 的音色设置（voiceName / voiceVolume），只拉一次。 */
    let voiceCfgPromise = null;
    function loadDshPetVoice() {
      if (!voiceCfgPromise) {
        voiceCfgPromise = fetch(petBase() + '/config', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((cfg) => {
            const main = (cfg && cfg.main) || {};
            const volume = Number(main.voiceVolume);
            return {
              voiceName: typeof main.voiceName === 'string' ? main.voiceName : '',
              volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
            };
          })
          .catch(() => ({ voiceName: '', volume: 1 }));
      }
      return voiceCfgPromise;
    }

    /**
     * 用 dsh-pet 的 /voice/speak 合成播放：音色跟随它设置的 voiceName，且能命中它自己的合成缓存
     * （同一句话合成过一次后即使在线 429 也能直接播）；失败返回 false 交给本地兜底。
     */
    async function playDshPetVoice(text, cfg) {
      if (typeof Audio !== 'function' || typeof URL.createObjectURL !== 'function') return false;
      try {
        const res = await fetch(petBase() + '/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...(cfg.voiceName ? { voice: cfg.voiceName } : {}) }),
        });
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
        if (!res.ok || !type.includes('audio')) return false;
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audio.volume = cfg.volume;
        audio.onended = () => URL.revokeObjectURL(url);
        audio.onerror = () => URL.revokeObjectURL(url);
        await audio.play();
        return true;
      } catch {
        return false;
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
            const result = openChatOnce({ dedup: true });
            void post('api/open-result', { ...result, pet: 'kws', source: 'audio-reply' });
            // 回应文案随响应带回，按 dsh-pet 音色朗读，失败再本地兜底。
            if (response.reactionText) void speakReaction(response.reactionText);
          }
        }).catch(() => {});
      }

      function onChunk(chunk) {
        if (stopped || !resampler || !(chunk instanceof Float32Array)) return;
        lastChunkAt = Date.now();
        const batched = takeChunks(pending, resampler.push(chunk), KWS_CHUNK);
        pending = batched.rest;
        for (const part of batched.chunks) sendPcm(encodePcm(part));
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
      ctx.effect?.(() => () => {
        disposeMenu();
        disposeWake();
        disposeSection();
      }, 'dsh-pet-extend: cleanup');
    }

    return {
      name, inject, apply,
      _internals: {
        Resampler, concatBytes, encodePcm, takeChunks,
        KWS_RATE, KWS_CHUNK, SETTINGS_SECTION,
      },
    };
  },
});
