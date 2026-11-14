/**
 * 无依赖的冒烟测试：语法、设置页与设置 API、随包模型、唤醒词拼音 token、
 * 声纹门槛与校验、菜单桥接、DSH 设置分区注册与菜单跳转、客户端麦克风采集与打开原聊天标签。
 * 运行：node test/smoke.mjs（sherpa-onnx 用假模块，不需要 native 依赖）
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const pathOf = (relative) => fileURLToPath(new URL(relative, ROOT));
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonPost = (base, path, body) => fetch(base + '/dsh-pet-extend/' + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((res) => res.json());

function checkSyntax() {
  for (const file of [
    'lib/index.js', 'lib/client.js', 'lib/kws.js', 'lib/settings.js',
    'lib/voiceprint.js', 'lib/models.js', 'scripts/install-models.mjs',
  ]) {
    execFileSync(process.execPath, ['--check', pathOf(file)]);
  }
  assert.equal(existsSync(pathOf('lib/pages/settings.html')), true, '设置页缺失');
  const html = readFileSync(pathOf('lib/pages/settings.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, '设置页脚本缺失');
  new Function(script); // 只编译，不执行：语法错误要在这里就报出来
  assert.equal(existsSync(pathOf('lib/pages/index.html')), false, '旧的扩展首页不应存在');
}

async function checkRoute() {
  const { apply, ORIGINAL_CHAT_KIND } = await import(new URL('./lib/index.js', ROOT).href);
  assert.equal(ORIGINAL_CHAT_KIND, 'pet-chat');
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-route-'));
  const routes = [];
  const ctx = {
    webServer: {
      port: 62364,
      register(spec) {
        routes.push(spec);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    logger: { info() {}, warn() {} },
  };
  // 关掉菜单桥接与语音唤醒，避免向 62364 发真实请求 / 加载 native 依赖。
  apply(ctx, { menu: false, dataDir, kws: { enabled: false } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/dsh-pet-extend');

  const server = createServer((req, res) => void routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(base + '/dsh-pet-extend/api/status')).json();
    assert.equal(status.ok, true);
    assert.equal(status.originalChatKind, 'pet-chat');
    assert.equal(status.menuEnabled, false);
    assert.equal(status.menu, null);
    assert.equal(status.settingsPage, '/dsh-pet-extend/settings');
    assert.deepEqual(status.settingsSection, { id: 'pet-extend-config', label: '桌宠扩展设置', order: 31 });
    assert.equal(status.kws.enabled, false);
    assert.equal(status.kws.state, 'disabled');
    assert.equal(status.kws.canEnable, false);
    assert.equal(status.kws.blockedReason, 'voiceprint-required');
    assert.equal(status.kws.runtime.speakerModelPresent, true, '声纹模型路径没有解析到随包模型');
    assert.ok(status.kws.runtime.tokensFile.endsWith('tokens.txt'), 'KWS 词表路径未解析');

    const kwsStatus = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
    assert.equal(kwsStatus.ok, true);
    assert.equal(kwsStatus.ready, false);
    assert.equal(kwsStatus.defaultWakeWord, '大肥鱼');

    const settings = await (await fetch(base + '/dsh-pet-extend/api/kws/settings')).json();
    assert.equal(settings.ok, true);
    assert.deepEqual(settings.settings.wakeWords, ['大肥鱼']);
    assert.equal(settings.canEnable, false);
    assert.match(settings.keywords.lines[0], /@大肥鱼$/);
    assert.equal(settings.model.complete, true, '随包模型不完整');

    const page = await fetch(base + '/dsh-pet-extend/settings');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /语音唤醒设置/);
    assert.match(html, /api\/kws\/enroll/);
    assert.match(html, /body\.embed/, '设置页缺少嵌入 DSH 设置面板的样式');
    assert.match(html, /桌宠扩展设置/, '设置页未说明新的设置入口');
    assert.match(html, /未启用（正常/, 'disabled 状态不应再显示成「缺失」');
    assert.match(html, /\{ audio: true, video: false \}/, '麦克风缺少宽松约束降级');
    assert.match(html, /autoGainControl: false/, '设置页录音不应请求自动增益');
    assert.match(html, /echoCancellation: false/, '设置页录音应关闭回声消除');
    assert.match(html, /noiseSuppression: false/, '设置页录音应关闭降噪');
    assert.match(html, /exact: false/, '关闭音频处理应使用 exact 强制，否则设备会忽略并继续降噪');
    assert.match(html, /captureSummary/, '设置页应读取实际生效的音频处理开关');
    assert.match(html, /getSettings/, '设置页应通过 getSettings 校验降噪是否真的关闭');
    assert.match(html, /callbacks=/, '按住录音应上报音频回调次数以定位采集被节流');
    // 麦克风启动失败必须是可执行的中文提示，且对 NotReadableError 自动重试一次。
    assert.match(html, /micError\(error\)/, '麦克风错误应翻译成可执行提示，而不是直接抛英文');
    assert.match(html, /could not start audio source/i, '应对 NotReadableError（设备被占用）自动重试');
    assert.match(html, /先把它关掉、等 5 秒/, '申请失败时应提示先关闭占用麦克风的语音唤醒');
    assert.match(html, /没有检测到可用麦克风/, '缺少麦克风设备错误的可读提示');
    assert.match(html, /申请麦克风权限/, '缺少手动重试权限的入口');
    assert.match(html, /topMediaDevices|window\.parent\.navigator/, '缺少顶层 frame 权限申请');
    assert.match(html, /ensureMicPermission\(false\)/, '打开设置页没有自动申请权限');
    assert.match(html, /推理依赖不可用/, '设置页缺少推理依赖诊断');
    assert.match(html, /diagText/, '设置页缺少唤醒事件/打开结果诊断');
    assert.match(html, /reactTestBtn/, '设置页缺少唤醒反应测试按钮');
    assert.match(html, /data\.reaction/, '设置页缺少唤醒反应诊断');
    assert.doesNotMatch(html, /id="sensitivity"/, '识别灵敏度下拉框应已移除');
    assert.doesNotMatch(html, /useRecommended|recommendedWords/, '官方样例唤醒词下拉框应已移除');
    assert.doesNotMatch(html, /<option[^>]*>\s*小爱同学/, '官方样例唤醒词下拉框应已移除');
    assert.doesNotMatch(html, /applySensitivity|sensitivityMatch/, '灵敏度预设逻辑应已移除');
    assert.match(html, /voiceprintList/, '设置页缺少逐条声纹列表');
    assert.match(html, /data-vp-index/, '声纹列表缺少逐条播放按钮');
    assert.match(html, /replayTestBtn/, '设置页缺少「回放刚才的录音」按钮');
    assert.match(html, /holdTestBtn/, '设置页缺少「按住录音测试唤醒」按钮');
    assert.match(html, /api\/kws\/voiceprint\/audio/, '声纹回放未接线到音频接口');
    assert.match(html, /api\/kws\/test\/audio/, '测试录音回放未接线');
    assert.match(html, /replayListenBtn/, '设置页缺少「回放最近监听」按钮');
    assert.match(html, /api\/kws\/listen-audio/, '正式监听录音回放未接线');
    assert.match(html, /api\/kws\/test/, '按住录音测试未接线到测试接口');
    assert.match(html, /pointerdown/, '按住录音未接线到 pointer 事件');
    assert.match(html, /micBar/, '设置页缺少麦克风电平条');
    assert.match(html, /startLevelMeter/, '麦克风电平未接线');
    assert.match(html, /--dsw-alias-label-primary/, '设置页未采用 dsh-pet 主题令牌');
    assert.match(html, /引擎已重建/, '重新初始化按钮没有回报真实重建结果');
    assert.match(html, /data\.restarts/, '重新初始化按钮没有显示重建次数');
    assert.match(html, /不会重载插件代码/, '缺少「reload 不重载插件代码」的说明');
    assert.match(html, /引擎一直在解码但从未吐词/, '缺少「解码但从不吐词」的定位提示');
    assert.match(html, /SKIP_LABELS/, '诊断应把跳过原因映射成可读文案');
    assert.match(html, /连续唤醒被冷却挡住/, '缺少冷却导致丢唤醒的定位提示');
    assert.match(html, /data\.amplified/, '缺少「放大后能否检出」的归因提示');
    // 声纹必须逐条模板比对取最高分：均值模板会把 3 次录入的差异平均掉（实测 0.292 vs 逐条 0.622）。
    assert.match(readFileSync(pathOf('lib/voiceprint.js'), 'utf8'), /逐条比对取最像的那条/,
      '声纹校验不应只比均值模板');
    assert.match(html, /captureRealms\(/, '声纹录入没有走顶层 frame');
    assert.match(html, /new capture\.Ctor/, 'AudioContext 未与 MediaStream 保持同一 realm');
    assert.doesNotMatch(html, /桌宠右键/, '页面不应再引导右键菜单里的设置项');
    assert.equal((await fetch(base + '/dsh-pet-extend/settings/')).status, 200);
    const embedded = await fetch(base + '/dsh-pet-extend/settings?embed=1');
    assert.equal(embedded.status, 200);
    assert.match(await embedded.text(), /document\.body\.classList\.add\('embed'\)/);

    assert.equal((await (await fetch(base + '/dsh-pet-extend/api/hello', { method: 'POST' })).json()).ok, true);
    assert.equal((await (await fetch(base + '/dsh-pet-extend/api/menu-event?wait=0')).json()).events.length, 0);
    const posted = await fetch(base + '/dsh-pet-extend/api/open-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, method: 'sidebarRight.openTab' }),
    });
    assert.equal((await posted.json()).ok, true);

    // 除设置页外不提供其它页面资源。
    for (const path of ['/', '/index.html', '/style.css', '/app.js']) {
      const res = await fetch(base + '/dsh-pet-extend' + path);
      assert.equal(res.status, 404, path);
      assert.equal((await res.json()).ok, false);
    }

    // 宿主已剥掉挂载前缀时，req.url 只有 /api/...，同样能处理。
    const stripped = await new Promise((resolve, reject) => {
      const req = { method: 'GET', url: '/api/status' };
      const res = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, body: body?.toString() ?? '' });
        },
      };
      Promise.resolve(routes[0].handler(req, res)).catch(reject);
    });
    assert.equal(stripped.status, 200);
    assert.equal(JSON.parse(stripped.body).originalChatKind, 'pet-chat');
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function checkMenuHost() {
  const { createMenuBridge, MENU_LABELS } = await import(new URL('./lib/index.js?menu-host=1', ROOT).href);
  const calls = [];
  const opened = [];
  let polls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    let body;
    if (url.pathname.endsWith('/menu/item')) {
      body = init.method === 'DELETE' ? { ok: true, removed: 1 } : { ok: true };
    } else if (url.pathname.endsWith('/menu/events')) {
      polls += 1;
      body = polls === 1
        ? { ok: true, events: { 打开桌宠对话: 'main' } }
        : { ok: true, events: { 打开桌宠对话: null } };
    } else {
      body = { ok: true };
    }
    return { ok: true, json: async () => body };
  };

  const bridge = createMenuBridge({
    base: 'http://127.0.0.1:62364',
    fetchImpl,
    onOpen: (event) => opened.push(event),
    log: () => {},
  });
  await tick(400);

  assert.equal(bridge.status.registered, true);
  const registerCall = calls.find(
    (call) => call.url.pathname.endsWith('/menu/item') && call.init.method === 'POST',
  );
  assert.ok(registerCall, '宿主没有注册右键菜单项');
  const payload = JSON.parse(registerCall.init.body);
  assert.equal(payload.owner, 'dsh-pet-extend');
  assert.deepEqual(payload.labels, Object.values(MENU_LABELS));
  assert.deepEqual(payload.labels, ['打开桌宠对话'], '「更多」里不应再有语音唤醒设置项');
  assert.equal(payload.target, 'both');
  const pollCall = calls.find((call) => call.url.pathname.endsWith('/menu/events'));
  assert.ok(pollCall, '宿主没有长轮询菜单事件');
  assert.equal(pollCall.url.searchParams.get('wait'), '5000');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].pet, 'main');

  bridge.noteClient();
  bridge.noteOpenResult({ ok: true, method: 'sidebarRight.openTab' });
  assert.equal(bridge.status.clientSeen, true);
  assert.equal(bridge.status.lastOpenResult.method, 'sidebarRight.openTab');
  bridge.stop();
  await tick(50);
  assert.ok(
    calls.some((call) => call.url.pathname.endsWith('/menu/item') && call.init.method === 'DELETE'),
    '宿主停止时没有注销菜单项',
  );
}

function makeKwsModelDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-kws-'));
  for (const file of ['encoder-epoch-1.onnx', 'decoder-epoch-1.onnx', 'joiner-epoch-1.onnx']) {
    writeFileSync(join(dir, file), 'stub');
  }
  writeFileSync(join(dir, 'tokens.txt'), '<blk> 0\nd 1\nà 2\nf 3\néi 4\ny 5\nú 6\n');
  writeFileSync(join(dir, 'keywords.txt'), 'n ǐ h ǎo x iǎo ch ǒ ng @你好小宠\n');
  return dir;
}

/** 假 sherpa-onnx-node：KeywordSpotter + SpeakerEmbeddingExtractor，hit/vector 可动态改。 */
function makeFakeModule({ keyword = '你好小宠', hit = true, vector = [1, 0, 0, 0] } = {}) {
  const state = { keyword, hit, vector };
  return {
    state,
    KeywordSpotter: class {
      createStream() {
        return { ready: false, acceptWaveform() { this.ready = true; } };
      }
      isReady(stream) { return stream.ready; }
      decode(stream) { stream.ready = false; }
      getResult() { return { keyword: state.hit ? state.keyword : '' }; }
      reset() {}
    },
    SpeakerEmbeddingExtractor: class {
      constructor() { this.dim = 4; }
      createStream() { return { acceptWaveform() {} }; }
      compute(...args) { state.computeArgs = args; return Float32Array.from(state.vector); }
    },
  };
}

async function checkKwsUnit() {
  const {
    resolveKwsConfig, findModelFiles, readKeywords, createKwsEngine,
    KWS_SAMPLE_RATE, extractUtterance,
  } = await import(new URL('./lib/kws.js', ROOT).href);
  const dir = makeKwsModelDir();
  try {
    const files = findModelFiles(dir);
    assert.equal(files.variant, 'fp32');
    assert.ok(files.encoder.endsWith('encoder-epoch-1.onnx'));
    assert.ok(files.tokens.endsWith('tokens.txt'));
    assert.deepEqual(readKeywords(join(dir, 'keywords.txt')), ['你好小宠']);
    assert.equal(KWS_SAMPLE_RATE, 16000);

    // 声纹比对段必须对齐「本次触发的那句唤醒词」，而不是整段缓冲或最响的一段。
    const rate = KWS_SAMPLE_RATE;
    const total = rate * 3;
    const buffer = new Float32Array(total);
    for (let i = 0; i < total; i += 1) buffer[i] = i % 7 === 0 ? 0.001 : -0.001; // 底噪
    const burstStart = total - rate;        // 距末尾 1.0s 开始
    const burstEnd = total - Math.floor(rate * 0.2); // 距末尾 0.2s 结束
    for (let i = burstStart; i < burstEnd; i += 1) buffer[i] = Math.sin(i * 0.08) * 0.5;
    const utterance = extractUtterance(buffer, '大肥鱼', rate);
    assert.ok(utterance.length >= Math.floor(rate * 0.6), '截取段太短，无法做声纹');
    assert.ok(utterance.length < rate * 1.2, '截取段过长，把前面的静音也算进来了');
    assert.ok(utterance.length < total, '不应返回整段缓冲');
    let utterancePeak = 0;
    for (const value of utterance) utterancePeak = Math.max(utterancePeak, Math.abs(value));
    assert.ok(utterancePeak > 0.3, '截取段没有覆盖到唤醒词');

    const config = resolveKwsConfig({ kws: { modelDir: dir, enabled: true } }, {});
    assert.equal(config.enabled, true);
    assert.equal(config.keywordsFile, join(dir, 'keywords.txt'));
    assert.equal(resolveKwsConfig({ kws: false }, {}).enabled, false);
    const disabledConfig = resolveKwsConfig({ kws: false }, {});
    assert.ok(disabledConfig.speakerModel.endsWith('.onnx'), '禁用 KWS 不应抹掉声纹模型路径');
    assert.ok(disabledConfig.modelDir.length > 0, '禁用 KWS 不应抹掉 KWS 模型目录');
    assert.equal(resolveKwsConfig({}, {}).enabled, false, '随包模型不能自动开启语音唤醒');
    // 官方 KeywordSpotter 的召回参数：实测 paths=4/8 时用户真人录音全部漏检，只有 16 能检出。
    assert.equal(config.maxActivePaths, 16, '默认 maxActivePaths 应取实测能检出的 16');
    assert.equal(config.numTrailingBlanks, 4, '默认 numTrailingBlanks 应让词尾多等几帧静音');

    const engine = createKwsEngine({ config, loadModule: () => makeFakeModule() });
    assert.equal(await engine.start(), true);
    assert.equal(engine.status().state, 'ready');
    assert.deepEqual(engine.status().keywords, ['你好小宠']);
    // 并行多档：单档参数一定漏（三字词最优 boost 随语速漂移），实测 1.5+2+2.5 覆盖 60/60。
    assert.deepEqual(engine.status().boosts, [1.5, 2, 2.5], '默认应并行 1.5/2/2.5 三档');
    const boosted = createKwsEngine({ config: { ...config, keywordsScore: 3 }, loadModule: () => makeFakeModule() });
    assert.equal(await boosted.start(), true);
    assert.deepEqual(boosted.status().boosts, [1.5, 2, 2.5, 3], '用户把加成调到 3 时应自动补上该档');
    boosted.stop();
    const session = engine.openSession();
    assert.equal(session.ok, true);
    assert.equal(session.sampleRate, 16000);
    assert.equal(engine.handleAudio(session.sessionId, Buffer.alloc(3200)).keyword, '你好小宠');
    assert.equal(engine.handleAudio(session.sessionId, Buffer.alloc(1)).reason, 'bad-pcm');
    const loud = Buffer.alloc(3200);
    loud.writeInt16LE(Math.round(0.5 * 32767), 0);
    engine.handleAudio(session.sessionId, loud);
    assert.ok(engine.status().lastPeak > 0.4, '音频峰值统计不正确');
    assert.equal(engine.closeSession(session.sessionId).ok, true);
    assert.equal(engine.handleAudio(session.sessionId, Buffer.alloc(3200)).reason, 'session-not-found');

    // 回归：「重新初始化引擎」必须真正重建、可等待、并如实回报结果。
    // 旧实现 fire-and-forget，HTTP 立刻回 ok:true，设置页刷新时状态毫无变化，看起来像「没反应」。
    const restart = createKwsEngine({ config, loadModule: () => makeFakeModule() });
    assert.equal(await restart.start(), true);
    const oldSession = restart.openSession();
    assert.equal(oldSession.ok, true);
    const reloadResult = await restart.reload(config.keywordsFile);
    assert.equal(reloadResult.ok, true, 'reload 必须等引擎真正就绪再返回');
    assert.equal(reloadResult.state, 'ready');
    assert.equal(reloadResult.restarts, 1);
    assert.deepEqual(reloadResult.keywords, ['你好小宠']);
    assert.equal(reloadResult.sessions, 0, 'reload 必须清掉旧会话');
    assert.equal(restart.handleAudio(oldSession.sessionId, Buffer.alloc(3200)).reason, 'session-not-found',
      '重建后旧会话不能继续用旧 spotter 解码');
    const fresh = restart.openSession();
    assert.equal(fresh.ok, true);
    assert.equal(restart.handleAudio(fresh.sessionId, Buffer.alloc(3200)).keyword, '你好小宠',
      '重建后的新会话必须能正常检出');
    const retryResult = await restart.retry();
    assert.equal(retryResult.ok, true, 'retry 在 ready 时也必须重建，不能提前返回 false');
    assert.equal(retryResult.restarts, 2);
    assert.equal(restart.status().restarts, 2);
    restart.stop();

    engine.stop();

    // 关键回归：音频全程原样透传，插件不做任何自动增益/降增益。
    // 曾加过服务端 AGC，让引擎输入电平与麦克风原始电平不一致、旧声纹被全部误拒；
    // 现在 KWS 与声纹收到的都必须是未经缩放的原始 PCM。
    const capture = createKwsEngine({ config, loadModule: () => makeFakeModule() });
    assert.equal(await capture.start(), true);
    let captured = null;
    capture.setVerifier((samples) => { captured = samples; return { ok: true, score: 1 }; });
    const capSession = capture.openSession();
    const rawPcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i += 1) {
      rawPcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 200 * i / 16000) * 0.02 * 32767), i * 2);
    }
    for (let i = 0; i < 6; i += 1) capture.handleAudio(capSession.sessionId, rawPcm);
    assert.ok(captured instanceof Float32Array, '声纹校验没有收到音频');
    let capturedPeak = 0;
    for (const value of captured) capturedPeak = Math.max(capturedPeak, Math.abs(value));
    assert.ok(Math.abs(capturedPeak - 0.02) < 0.002, '音频被自动增益改动了幅度');
    assert.ok(Math.abs(capture.status().lastPeak - 0.02) < 0.002, '服务端峰值统计应与原始输入一致');
    capture.stop();

    // 回归：某些 sherpa 版本 reset 后流报废，必须重建流才能再次检测（否则「只响一次」）。
    const brick = {
      KeywordSpotter: class {
        createStream() { return { ready: false, bricked: false, acceptWaveform() { this.ready = true; } }; }
        isReady(stream) { return stream.ready && !stream.bricked; }
        decode(stream) { stream.ready = false; }
        getResult() { return { keyword: '你好小宠' }; }
        reset(stream) { stream.bricked = true; }
      },
    };
    const repeat = createKwsEngine({ config: { ...config, cooldownMs: 0 }, loadModule: () => brick });
    assert.equal(await repeat.start(), true);
    const repeatSession = repeat.openSession();
    assert.equal(repeat.handleAudio(repeatSession.sessionId, Buffer.alloc(3200)).triggered, true, '第一次应触发');
    // 命中后下一块开头就重建流：实测 reset 策略连续 8 轮只中 5/8，每次 createStream 重建 8/8。
    assert.equal(repeat.handleAudio(repeatSession.sessionId, Buffer.alloc(3200)).triggered, true,
      '命中后应重建流，连续第 2 次不能丢');
    assert.equal(repeat.handleAudio(repeatSession.sessionId, Buffer.alloc(3200)).triggered, true,
      '连续第 3 次也不应丢');
    repeat.stop();

    // 关键回归：KWS 流需要积累几块才 isReady。曾加过「连续 2 块不就绪就重建」的兜底，
    // 结果每 2 块重建一次、永远 ready 不了，表现为「引擎在解码但检测恒 0」。绝不能重建预热中的流。
    let warmInstance = null;
    const warm = {
      KeywordSpotter: class {
        constructor() { this.streams = 0; warmInstance = this; }
        createStream() {
          this.streams += 1;
          const stream = { chunks: 0 };
          stream.acceptWaveform = () => { stream.chunks += 1; };
          return stream;
        }
        isReady(stream) { return stream.chunks >= 3; }
        decode() {}
        getResult() { return { keyword: '你好小宠' }; }
        reset() {}
      },
    };
    const warmEngine = createKwsEngine({ config: { ...config, cooldownMs: 0 }, loadModule: () => warm });
    assert.equal(await warmEngine.start(), true);
    const warmSession = warmEngine.openSession();
    assert.equal(warmEngine.handleAudio(warmSession.sessionId, Buffer.alloc(3200)).detected, false,
      '前 2 块还在预热，不应命中');
    assert.equal(warmEngine.handleAudio(warmSession.sessionId, Buffer.alloc(3200)).detected, false);
    assert.equal(warmEngine.handleAudio(warmSession.sessionId, Buffer.alloc(3200)).detected, true,
      '第 3 块就绪后必须命中');
    assert.equal(warmInstance.streams, 1, '预热中的流不能被重建（会被永久卡在未就绪）');
    warmEngine.stop();

    const broken = createKwsEngine({
      config,
      loadModule: () => { throw new Error('sherpa-onnx-node missing'); },
    });
    assert.equal(await broken.start(), false);
    assert.equal(broken.status().state, 'error');
    assert.ok(broken.status().hint.includes('sherpa-onnx-node'));
    assert.equal(broken.openSession().reason, 'engine-error');
    broken.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function checkSettingsModule() {
  const {
    DEFAULT_WAKE_WORD, DEFAULT_SETTINGS, migrateLegacyDefaults, sanitizeSettings,
    wordToTokens, readTokenSet, buildKeywordLines,
    createSettingsStore, splitPinyin, normalizeWords,
  } = await import(new URL('./lib/settings.js', ROOT).href);
  const { modelStatus } = await import(new URL('./lib/models.js', ROOT).href);
  const tokensFile = pathOf('models/kws/tokens.txt');
  const tokenSet = readTokenSet(tokensFile);
  assert.ok(tokenSet.size > 100, 'KWS tokens.txt 未随包提供');
  assert.equal(modelStatus().complete, true, 'KWS/声纹模型未随包提供');
  assert.equal(DEFAULT_WAKE_WORD, '大肥鱼');
  // 真人完整录音实测：boost 3 / 阈值 0.08~0.15 全部命中，boost 2.5 全漏，boost 4 反而崩。
  assert.equal(DEFAULT_SETTINGS.keywordsScore, 3.0, '默认唤醒加成应取真人实测可检出的值');
  assert.equal(DEFAULT_SETTINGS.keywordsThreshold, 0.15, '默认触发阈值应取真人实测可检出的值');
  const migrated = migrateLegacyDefaults(sanitizeSettings({ keywordsScore: 3, keywordsThreshold: 0.16 }));
  assert.equal(migrated.keywordsScore, 3.0, '更早的旧默认值应自动迁移');
  assert.equal(migrated.keywordsThreshold, 0.15, '更早的旧默认阈值应自动迁移');
  const migrated2 = migrateLegacyDefaults(sanitizeSettings({ keywordsScore: 2, keywordsThreshold: 0.25 }));
  assert.equal(migrated2.keywordsScore, 3.0, '2/0.25 也是旧默认，应迁移到真人更稳的 3/0.15');
  assert.equal(migrated2.keywordsThreshold, 0.15, '2/0.25 的阈值也应迁移');
  const manual = migrateLegacyDefaults(sanitizeSettings({ keywordsScore: 2.7, keywordsThreshold: 0.2 }));
  assert.equal(manual.keywordsScore, 2.7, '用户手动设置不应被迁移覆盖');
  assert.deepEqual(splitPinyin('dà'), ['d', 'à']);
  assert.deepEqual(splitPinyin('ài'), ['ài']);
  assert.deepEqual(normalizeWords('大肥鱼，你好西西'), ['大肥鱼', '你好西西']);

  // 用模型自带的 keywords_raw.txt / keywords.txt 校对拼音拆分规则。
  const raws = readFileSync(pathOf('models/kws/keywords_raw.txt'), 'utf8').trim().split(/\r?\n/);
  const official = readFileSync(pathOf('models/kws/keywords.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(raws.length, official.length);
  for (let i = 0; i < raws.length; i += 1) {
    const expected = official[i].slice(0, official[i].lastIndexOf('@')).trim();
    assert.equal(wordToTokens(raws[i], tokenSet), expected, `唤醒词转换不一致：${raws[i]}`);
  }
  assert.equal(wordToTokens('大肥鱼', tokenSet), 'd à f éi y ú');
  assert.throws(() => wordToTokens('大A鱼', tokenSet), /不是汉字/);
  assert.throws(() => wordToTokens('大', tokenSet), /2~12/);

  const built = buildKeywordLines({ wakeWords: ['大肥鱼'], keywordsScore: 1.5, keywordsThreshold: 0.3 }, tokensFile);
  assert.deepEqual(built.errors, []);
  assert.equal(built.lines[0], 'd à f éi y ú :1.5 #0.3 @大肥鱼');

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-settings-unit-'));
  try {
    const store = createSettingsStore({ dataDir, tokensFile });
    assert.deepEqual(store.loadSettings().wakeWords, ['大肥鱼']);
    assert.equal(store.saveSettings({ enabled: true, wakeWords: '大肥鱼,你好西西' }).wakeWords.length, 2);
    const written = store.buildKeywords(store.loadSettings());
    assert.equal(written.lines.length, 2);
    assert.match(readFileSync(written.path, 'utf8'), /@大肥鱼/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function checkKwsRoute() {
  const { apply } = await import(new URL('./lib/index.js?kws-route=1', ROOT).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-kws-route-'));
  const routes = [];
  let cleanup = () => {};
  const ctx = {
    webServer: {
      port: 62364,
      register(spec) { routes.push(spec); return () => {}; },
    },
    effect(fn) { cleanup = fn(); return cleanup; },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, {
    menu: false,
    dataDir,
    kws: { enabled: true, loadModule: () => makeFakeModule({ keyword: '大肥鱼' }) },
  });
  const server = createServer((req, res) => void routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let status;
    for (let i = 0; i < 30; i += 1) {
      status = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
      if (status.state === 'ready') break;
      await tick(30);
    }
    assert.equal(status.state, 'ready');
    assert.deepEqual(status.keywords, ['大肥鱼']);
    assert.equal(status.sampleRate, 16000);
    assert.equal(status.readyToListen, false, '未录入声纹时不应开始监听');

    const session = await (await fetch(base + '/dsh-pet-extend/api/kws/session', { method: 'POST' })).json();
    assert.ok(session.sessionId);
    assert.equal(session.chunkSamples, 1600);

    // 唤醒事件走原有的 menu-event 长轮询通道。
    const eventPromise = fetch(base + '/dsh-pet-extend/api/menu-event?wait=2000').then((res) => res.json());
    await tick(50);
    const audioUrl = base + '/dsh-pet-extend/api/kws/audio?session=' + encodeURIComponent(session.sessionId);
    const postAudio = () => fetch(audioUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(3200),
    }).then((res) => res.json());

    const first = await postAudio();
    assert.equal(first.detected, true);
    assert.equal(first.triggered, true);
    assert.equal(first.keyword, '大肥鱼');
    const events = await eventPromise;
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].source, 'kws');
    assert.equal(events.events[0].action, 'open');
    assert.equal(events.events[0].keyword, '大肥鱼');

    const second = await postAudio();
    assert.equal(second.detected, true);
    assert.equal(second.triggered, false);
    assert.equal(second.reason, 'cooldown');

    await jsonPost(base, 'api/kws/client-state', { state: 'listening', sampleRate: 48000 });
    const full = await (await fetch(base + '/dsh-pet-extend/api/status')).json();
    assert.equal(full.kws.triggers, 1);
    assert.equal(full.kws.detections, 2);
    assert.ok(full.kws.audioChunks >= 2, '服务端未统计到收到的音频段');
    assert.ok(full.kws.lastAudioAt, '服务端未记录最近音频时间');
    assert.ok(full.kws.decodedChunks >= 2, '未统计已解码音频块，无法区分「没解码」和「没命中」');
    assert.ok(full.kws.lastDecodeAt, '未记录最近一次解码时间');
    assert.equal(full.kws.client.state, 'listening');
    // 代码版本标记：用来确认进程实际加载的是哪一版（reload 不重载 JS，必须重启 DSH）。
    assert.equal(typeof full.kws.codeVersion, 'string', '状态接口应返回代码版本，便于确认是否已重启');
    assert.ok(full.kws.codeVersion.length > 0);
    const level = await (await fetch(base + '/dsh-pet-extend/api/kws/level')).json();
    assert.equal(level.ok, true);
    assert.ok(level.chunks >= 2, '电平接口未报告音频段数');
    assert.equal(typeof level.peak, 'number');
    assert.ok(level.decodedChunks >= 2, '电平接口未报告解码块数');
    assert.equal(typeof level.avgPeak, 'number');
    assert.equal(typeof level.voiceRatio, 'number', '电平接口未报告有效语音占比');
    // 正式监听最近音频必须可回放，才能对比「按住测试」与真实监听收到的声音。
    const listenRes = await fetch(base + '/dsh-pet-extend/api/kws/listen-audio');
    assert.equal(listenRes.status, 200, '正式监听音频应可回放');
    assert.match(listenRes.headers.get('content-type'), /audio\/wav/);
    const listenWav = Buffer.from(await listenRes.arrayBuffer());
    assert.equal(listenWav.toString('ascii', 0, 4), 'RIFF');
    assert.ok(listenWav.length > 44, '正式监听音频 WAV 不应为空');

    // 批量上传：客户端请求积压时会把多块 PCM 合并，服务端必须按 1600 样本逐块解码。
    const before = (await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json()).audioChunks;
    const batch = await fetch(audioUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(3200 * 3),
    }).then((res) => res.json());
    assert.equal(batch.detected, true, '批量 PCM 未被逐块解码');
    const after = (await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json()).audioChunks;
    assert.equal(after - before, 3, '批量请求应拆成 3 块分别喂给 KWS 流');

    const closed = await (await fetch(
      base + '/dsh-pet-extend/api/kws/session?session=' + encodeURIComponent(session.sessionId),
      { method: 'DELETE' },
    )).json();
    assert.equal(closed.ok, true);
    assert.equal((await postAudio()).reason, 'session-not-found');
    const finalStatus = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
    assert.ok(finalStatus.skips['session-not-found'] >= 1, '未记录会话失效次数');
    assert.equal(finalStatus.lastSkipReason, 'session-not-found', '未记录最近跳过原因');

    // 回归：retry 接口必须等重建真正结束、如实回报状态，而不是无条件 200 {ok:true}。
    const retryRes = await fetch(base + '/dsh-pet-extend/api/kws/retry', { method: 'POST' });
    const retryBody = await retryRes.json();
    assert.equal(retryRes.status, 200);
    assert.equal(retryBody.ok, true);
    assert.equal(retryBody.state, 'ready');
    assert.deepEqual(retryBody.keywords, ['大肥鱼']);
    assert.ok(retryBody.restarts >= 1, 'retry 没有回报真实重建次数');
    const afterRetry = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
    assert.equal(afterRetry.restarts, retryBody.restarts, '状态里的重建次数应与响应一致');
  } finally {
    cleanup();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 声纹引擎抛异常时必须返回 JSON 400，否则 DSH 给非 JSON 400，前端只显示「HTTP 400」。 */
async function checkEnrollErrorReply() {
  const { apply } = await import(new URL('./lib/index.js?enroll-error=1', ROOT).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-enroll-err-'));
  const routes = [];
  const ctx = {
    webServer: { port: 0, register(spec) { routes.push(spec); return () => {}; } },
    effect: () => () => {},
    logger: { info() {}, warn() {} },
  };
  apply(ctx, {
    menu: false,
    dataDir,
    kws: { enabled: false, loadModule: () => { throw new Error('sherpa ABI mismatch'); } },
  });
  const server = createServer((req, res) => void routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/dsh-pet-extend/api/kws/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(new Int16Array(16000 * 3).buffer),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'enroll-failed');
    assert.match(body.message, /sherpa ABI mismatch/);
    assert.equal(body.voiceprint.modelPresent, true, '异常响应也应带声纹模型诊断');
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function checkSettingsFlow() {
  const { apply } = await import(new URL('./lib/index.js?settings-flow=1', ROOT).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-flow-'));
  const fake = makeFakeModule({ keyword: '大肥鱼', hit: false });
  const routes = [];
  let cleanup = () => {};
  const ctx = {
    webServer: {
      port: 62364,
      register(spec) { routes.push(spec); return () => {}; },
    },
    effect(fn) { cleanup = fn(); return cleanup; },
    logger: { info() {}, warn() {} },
  };
  apply(ctx, { menu: false, dataDir, kws: { enabled: false, loadModule: () => fake } });
  const server = createServer((req, res) => void routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postAudio = (sessionId, size = 3200) => fetch(
    base + '/dsh-pet-extend/api/kws/audio?session=' + encodeURIComponent(sessionId),
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(size) },
  ).then((res) => res.json());
  try {
    // 1. 未录入声纹时不允许开启。
    const deniedRes = await fetch(base + '/dsh-pet-extend/api/kws/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(deniedRes.status, 409);
    assert.equal((await deniedRes.json()).reason, 'voiceprint-required');

    // 2. 录入声纹（3 秒 16kHz Int16LE PCM）。
    const enrollRes = await fetch(base + '/dsh-pet-extend/api/kws/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(16000 * 3 * 2),
    });
    const enrolled = await enrollRes.json();
    assert.equal(enrollRes.status, 200);
    assert.equal(enrolled.ok, true);
    assert.equal(enrolled.count, 1);
    assert.equal(fake.state.computeArgs?.[1], false, '声纹 compute 必须禁用 external buffer（Electron 不允许）');
    let payload = await (await fetch(base + '/dsh-pet-extend/api/kws/settings')).json();
    assert.equal(payload.canEnable, true);
    assert.equal(payload.voiceprint.present, true);

    // 2.5 逐条声纹回放：每次录入各存一份 WAV，按 index 精确取用。
    const secondPcm = Buffer.alloc(16000 * 3 * 2);
    for (let i = 0; i < secondPcm.length / 2; i += 1) {
      secondPcm.writeInt16LE(Math.round(Math.sin(i / 40) * 3000), i * 2);
    }
    const secondEnroll = await fetch(base + '/dsh-pet-extend/api/kws/enroll', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: secondPcm,
    });
    assert.equal(secondEnroll.status, 200);
    assert.equal((await secondEnroll.json()).count, 2);
    payload = await (await fetch(base + '/dsh-pet-extend/api/kws/settings')).json();
    assert.equal(payload.voiceprint.samples.length, 2, '应逐条列出 2 次录入的声纹');
    assert.deepEqual(payload.voiceprint.samples.map((s) => s.audioAvailable), [true, true]);
    assert.ok(!('file' in payload.voiceprint.samples[0]), '不应把服务端文件路径暴露给前端');

    const wavOf = async (index) => {
      const res = await fetch(base + '/dsh-pet-extend/api/kws/voiceprint/audio' +
        (index === undefined ? '' : '?index=' + index));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /audio\/wav/);
      return Buffer.from(await res.arrayBuffer());
    };
    const wav1 = await wavOf(1);
    const wav2 = await wavOf(2);
    const newest = await wavOf();
    assert.equal(wav1.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav1.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav1.readUInt32LE(24), 16000, '回放 WAV 采样率应为 16kHz');
    assert.equal(wav1.length, 44 + 16000 * 3 * 2, '回放 WAV 应完整保存录入的原始 PCM');
    assert.equal(Buffer.compare(wav1.subarray(44), Buffer.alloc(16000 * 3 * 2)), 0, '第 1 条应是第一次录入的 PCM');
    assert.equal(Buffer.compare(wav2.subarray(44), secondPcm), 0, '第 2 条应是第二次录入的 PCM');
    assert.equal(Buffer.compare(newest.subarray(44), secondPcm), 0, '不带 index 应回放最近一条');
    assert.equal(payload.voiceprint.audioAvailable, true);
    const badIndex = await fetch(base + '/dsh-pet-extend/api/kws/voiceprint/audio?index=9');
    assert.equal(badIndex.status, 404);
    assert.equal((await badIndex.json()).reason, 'no-enrollment-audio');

    // 3. 开启 + 自定义唤醒词，关闭冷却便于连续验证。
    const saved = await jsonPost(base, 'api/kws/settings', {
      enabled: true,
      wakeWords: '大肥鱼,你好西西',
      cooldownMs: 0,
      speakerThreshold: 0.5,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.enabled, true);
    assert.equal(saved.keywords.lines.length, 2);
    assert.deepEqual(saved.keywords.errors, []);

    let status;
    for (let i = 0; i < 30; i += 1) {
      status = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
      if (status.readyToListen) break;
      await tick(30);
    }
    assert.equal(status.readyToListen, true);
    assert.equal(status.canEnable, true);
    assert.equal(status.blockedReason, null);

    // 4. 声纹通过的唤醒：先积累音频窗口，再命中关键词。
    const session = await (await fetch(base + '/dsh-pet-extend/api/kws/session', { method: 'POST' })).json();
    assert.ok(session.sessionId);
    for (let i = 0; i < 8; i += 1) await postAudio(session.sessionId);
    const eventPromise = fetch(base + '/dsh-pet-extend/api/menu-event?wait=2000').then((res) => res.json());
    await tick(40);
    fake.state.hit = true;
    const passed = await postAudio(session.sessionId);
    assert.equal(passed.triggered, true);
    assert.equal(passed.keyword, '大肥鱼');
    const events = await eventPromise;
    assert.equal(events.events[0].source, 'kws');
    assert.equal((await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json()).lastVerification.ok, true);

    // 4.5 按住录音测试：走真实 KWS + 声纹，能激活，但不打开对话、不污染诊断计数。
    const beforeTest = await (await fetch(base + '/dsh-pet-extend/api/status')).json();
    const testRes = await fetch(base + '/dsh-pet-extend/api/kws/test', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(3200 * 3),
    });
    const tested = await testRes.json();
    assert.equal(testRes.status, 200);
    assert.equal(tested.ok, true);
    assert.equal(tested.blocks, 3);
    assert.equal(tested.detected, true);
    assert.equal(tested.keyword, '大肥鱼');
    assert.equal(tested.triggered, true, '测试会话应能激活唤醒');
    const afterTest = await (await fetch(base + '/dsh-pet-extend/api/status')).json();
    assert.equal(afterTest.kws.triggers, beforeTest.kws.triggers, '测试不应增加真实触发计数');
    assert.equal(afterTest.kws.detections, beforeTest.kws.detections, '测试不应增加真实检测计数');
    assert.equal(afterTest.kws.audioChunks, beforeTest.kws.audioChunks, '测试音频不应计入真实诊断');
    // 「完全没响应」的定位信息：音频体检 + 当前词表/参数，以及回放刚才那段录音。
    assert.equal(typeof tested.audio.peak, 'number', '测试接口应回报音频峰值');
    assert.equal(typeof tested.audio.rms, 'number', '测试接口应回报 RMS');
    assert.equal(tested.audio.silentBlocks, 3, '全静音 PCM 应被识别为静音块');
    assert.equal(tested.audio.voiceBlocks, 0);
    assert.equal(tested.audio.totalBlocks, 3, '应回报总块数以计算有效语音占比');
    assert.ok(Array.isArray(tested.keywords) && tested.keywords.includes('大肥鱼'), '应回报当前唤醒词');
    assert.equal(typeof tested.boost, 'number');
    assert.equal(typeof tested.keywordThreshold, 'number');
    assert.equal(tested.tailRetry, false, '第一遍就检出时不应触发尾部静音重放');
    assert.equal(tested.detectedAfterTail, false);
    const testAudio = await fetch(base + '/dsh-pet-extend/api/kws/test/audio');
    assert.equal(testAudio.status, 200);
    assert.match(testAudio.headers.get('content-type'), /audio\/wav/);
    const testWav = Buffer.from(await testAudio.arrayBuffer());
    assert.equal(testWav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(testWav.length, 44 + 3200 * 3, '回放的应是刚才测试用的整段 PCM');

    // 5. 换成别人的声纹向量：命中关键词但被拒绝。
    fake.state.vector = [0, 1, 0, 0];
    fake.state.hit = false;
    const session2 = await (await fetch(base + '/dsh-pet-extend/api/kws/session', { method: 'POST' })).json();
    for (let i = 0; i < 8; i += 1) await postAudio(session2.sessionId);
    fake.state.hit = true;
    const rejected = await postAudio(session2.sessionId);
    assert.equal(rejected.detected, true);
    assert.equal(rejected.triggered, false);
    assert.equal(rejected.reason, 'below-threshold');

    // 5.5 完全没检出时，应自动补 0.5s 尾部静音重放一次，并如实回报结果。
    fake.state.hit = false;
    const missed = await fetch(base + '/dsh-pet-extend/api/kws/test', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(3200 * 3),
    }).then((r) => r.json());
    assert.equal(missed.detected, false);
    assert.equal(missed.tailRetry, true, '没检出来时应补尾部静音重放');
    assert.equal(missed.detectedAfterTail, false);
    fake.state.hit = true;

    // 6. 清除声纹会自动停用。
    const cleared = await (await fetch(base + '/dsh-pet-extend/api/kws/voiceprint', { method: 'DELETE' })).json();
    assert.equal(cleared.ok, true);
    payload = await (await fetch(base + '/dsh-pet-extend/api/kws/settings')).json();
    assert.equal(payload.settings.enabled, false);
    assert.equal(payload.canEnable, false);
    assert.equal((await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json()).readyToListen, false);
    // 清除声纹时原始录音也应一并删除，回放接口给出可读提示。
    const gone = await fetch(base + '/dsh-pet-extend/api/kws/voiceprint/audio');
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).reason, 'no-enrollment-audio');
  } finally {
    cleanup();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function browserStubs() {
  globalThis.window = {
    __ModuleLoader__: { load: (info) => { globalThis.__loaded = info; } },
  };
  globalThis.__docListeners = {};
  globalThis.document = {
    baseURI: 'http://127.0.0.1:62364/app/',
    hidden: false,
    addEventListener(type, fn) { globalThis.__docListeners[type] = fn; },
    removeEventListener(type) { delete globalThis.__docListeners[type]; },
  };
  globalThis.location = { search: '?token=abc' };
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  globalThis.__opened = [];
  globalThis.open = (url) => globalThis.__opened.push(url);
}

async function checkClientWakeAudio(micFallback = false, menuEvents = true) {
  browserStubs();
  let processor = null;
  let micAttempts = 0;
  let lastContext = null;
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.resumeCalls = 0;
      lastContext = this;
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      processor = { onaudioprocess: null, connect() {}, disconnect() {} };
      return processor;
    }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    resume() { this.resumeCalls += 1; this.state = 'running'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          micAttempts += 1;
          if (micFallback && micAttempts === 1) {
            const error = new Error('Requested device not found');
            error.name = 'NotFoundError';
            throw error;
          }
          return { getTracks: () => [] };
        },
      },
    },
    configurable: true,
    writable: true,
  });
  globalThis.AudioContext = FakeAudioContext;

  const calls = [];
  const openedTabs = [];
  let menuPolls = 0;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    let body = { ok: true };
    if (url.pathname.endsWith('/api/kws/status')) {
      body = { ok: true, enabled: true, state: 'ready', readyToListen: true };
    } else if (url.pathname.endsWith('/api/kws/session') && init.method === 'POST') {
      body = { ok: true, sessionId: 's1', sampleRate: 16000 };
    } else if (url.pathname.endsWith('/api/kws/audio')) {
      body = { ok: true, detected: true, keyword: '大肥鱼', triggered: true, reactionText: '我在' };
    } else if (url.pathname.endsWith('/api/menu-event')) {
      menuPolls += 1;
      body = menuEvents && menuPolls === 1
        ? { ok: true, events: [{ label: '打开桌宠对话', pet: 'kws', source: 'kws', keyword: '大肥鱼' }] }
        : { ok: true, events: [] };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  // 本地朗读（Web Speech）桩：失败/无声是因为宿主 Edge 在线合成 429，这里验证改为本地发声。
  const spoken = [];
  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: 'zh-CN', name: 'FakeChinese' }],
    cancel() {},
    speak(utterance) { spoken.push(utterance.text); },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(value) { this.text = value; }
  };

  const tag = `wake-${micFallback ? 'fallback' : 'plain'}-${menuEvents ? 'events' : 'noevents'}=1`;
  await import(new URL(`./lib/client.js?${tag}`, ROOT).href);
  const plugin = globalThis.__loaded.factory();
  const { Resampler, concatBytes, encodePcm, takeChunks, KWS_CHUNK, KWS_RATE } = plugin._internals;
  assert.equal(KWS_RATE, 16000);
  // 回归：AudioWorklet 的 process() 每次只有 128 帧，绝不能每帧 postMessage——
  // 约 375 次/秒的消息会把主线程淹掉，音频抖动/丢帧后 KWS 永远不吐词。
  const clientSource = readFileSync(pathOf('lib/client.js'), 'utf8');
  assert.match(clientSource, /Float32Array\(4096\)/, 'AudioWorklet 应在内部攒够 4096 帧再 postMessage');
  assert.match(clientSource, /this\.offset === this\.buffer\.length/,
    'AudioWorklet 不应每 128 帧就往主线程发一次消息');
  assert.match(clientSource, /uploadBuffer\.unshift\(\.\.\.batch\)/,
    '会话失效（session-not-found）时不能丢弃已采集的音频批次');
  // 关闭语音唤醒必须真正释放麦克风，否则设置页申请权限会撞 NotReadableError。
  assert.match(clientSource, /stopMedia\(\);\s*listening = false;/,
    '关闭语音唤醒时应停止采集并释放麦克风设备');
  assert.equal(new Resampler(48000, KWS_RATE).push(new Float32Array(4800).fill(0.25)).length, 1600);
  assert.equal(encodePcm(new Float32Array([0, 1, -1])).length, 6);
  const unchanged = encodePcm(new Float32Array([0.99, -0.99]));
  const unchangedView = new DataView(unchanged.buffer);
  assert.ok(Math.abs(unchangedView.getInt16(0, true) / 32767 - 0.99) < 0.001,
    'encodePcm 不应缩放音频幅度');
  assert.match(readFileSync(pathOf('lib/client.js'), 'utf8'), /autoGainControl: false/,
    '客户端采集不应请求自动增益');
  const batched = takeChunks(new Float32Array(1), new Float32Array(3), 2);
  assert.equal(batched.chunks.length, 2);
  assert.equal(batched.rest.length, 0);

  const rmsOf = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length));
  const high = new Float32Array(4800);
  const low = new Float32Array(4800);
  for (let i = 0; i < 4800; i += 1) {
    high[i] = Math.sin(2 * Math.PI * 9000 * i / 48000) * 0.5;
    low[i] = Math.sin(2 * Math.PI * 1000 * i / 48000) * 0.5;
  }
  // 48k→16k 若没有低通，9kHz 噪声会折叠成 7kHz 假信号污染 fbank，正是漏检的常见来源。
  assert.ok(rmsOf(new Resampler(48000, KWS_RATE).push(high).slice(200)) < 0.02,
    '48k→16k 缺少抗混叠低通');
  assert.ok(rmsOf(new Resampler(48000, KWS_RATE).push(low).slice(200)) > 0.3,
    '抗混叠低通误伤了语音频带');

  // 电平归一化已移到服务端（由 checkKwsUnit 覆盖），客户端只上传原始 PCM。
  assert.equal(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]).length, 3);

  let cleanup = () => {};
  const ctx = {
    get: (name) => (name === 'sidebarRight' ? { openTab: (kind) => openedTabs.push(kind) } : undefined),
    effect: (fn) => { cleanup = fn(); return cleanup; },
  };
  plugin.apply(ctx);
  await tick(250);
  assert.equal(micAttempts, micFallback ? 2 : 1, '麦克风约束失败后应降级为宽松约束重试');
  assert.ok(processor, '客户端没有创建音频采集节点');
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.2) } });
  await tick(250);

  const audioCall = calls.find((call) => call.url.pathname.endsWith('/api/kws/audio'));
  assert.ok(audioCall, '客户端没有上传麦克风 PCM');
  assert.equal(audioCall.url.searchParams.get('session'), 's1');
  assert.equal(audioCall.url.searchParams.get('rate'), '16000');
  assert.equal(audioCall.init.headers['content-type'], 'application/octet-stream');
  assert.equal(audioCall.init.body.length, KWS_CHUNK * 2);
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/api/kws/session') && call.init.method === 'POST'));
  assert.deepEqual(openedTabs, ['pet-chat'], '语音唤醒没有打开原本的桌宠对话（或重复打开）');
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/api/open-result') &&
    call.init.body && JSON.parse(call.init.body).source === 'audio-reply'),
  '唤醒没有从 /api/kws/audio 响应直接打开对话');
  // 只跟随 dsh-pet 音色；合成失败保持静音，不回退系统 Web Speech。
  assert.deepEqual(spoken, [], '失败时不应回退系统 Web Speech');
  // 朗读前应读取 dsh-pet 的 voiceName/voiceVolume，做到音色跟随其设置。
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/dsh-pet-7340/config')),
    '唤醒回应未读取 dsh-pet 音色设置');
  // 回到前台要能恢复被挂起的 AudioContext（窗口隐藏节流是「时而能唤醒」的根因）。
  assert.equal(typeof globalThis.__docListeners.visibilitychange, 'function', '未监听 visibilitychange');
  assert.equal(typeof globalThis.__docListeners.focus, 'function', '未监听 focus');
  assert.ok(lastContext, '没有创建音频上下文');
  const beforeResume = lastContext.resumeCalls;
  lastContext.state = 'suspended';
  globalThis.__docListeners.visibilitychange();
  assert.ok(lastContext.resumeCalls > beforeResume, '回到前台没有 resume 音频上下文');

  cleanup();
  delete globalThis.AudioContext;
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
}

/** 伪造 DSH 的 slots 服务，验证 settings.section 分区贡献。 */
function settingsUiStubs() {
  const registered = [];
  const slots = {
    inject(name, generator) {
      assert.equal(name, 'settings.section');
      Array.from(generator()); // 消费 generator：register() 已登记贡献
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return { dispose() {} };
    },
  };
  const React = {
    createElement(tag, props, ...children) { return { tag, props, children }; },
  };
  return { slots, registered, require: (name) => (name === 'react' ? React : undefined) };
}

async function checkClientSettingsSection() {
  browserStubs();
  const calls = [];
  const openedTabs = [];
  let eventPolls = 0;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    let body = { ok: true, events: [] };
    if (url.pathname.endsWith('/api/kws/status')) body = { ok: true, enabled: false };
    if (url.pathname.endsWith('/api/menu-event')) {
      eventPolls += 1;
      if (eventPolls === 1) {
        // 旧版残留的 settings 事件应被忽略；open 事件照常打开对话。
        body = {
          ok: true,
          events: [
            { label: '打开桌宠对话', pet: 'main', action: 'open' },
            { label: '语音唤醒设置', pet: 'main', action: 'settings' },
          ],
        };
      }
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const { slots, registered, require } = settingsUiStubs();
  await import(new URL('./lib/client.js?settings-section=1', ROOT).href);
  const plugin = globalThis.__loaded.factory(require);
  const disposers = [];
  const ctx = {
    slots,
    get: (name) => (name === 'sidebarRight' ? { openTab: (kind) => openedTabs.push(kind) } : undefined),
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose; },
  };
  plugin.apply(ctx);
  await tick(250);

  // 1. DSH 设置里新增的分区：同源 iframe 嵌入设置页，保留 token 与麦克风权限。
  assert.equal(registered.length, 1, '没有注册 settings.section 分区');
  const entry = registered[0];
  assert.equal(entry.options.id, 'pet-extend-config');
  assert.equal(entry.options.label(), '桌宠扩展设置');
  assert.equal(entry.options.order, 31);
  assert.equal(plugin._internals.SETTINGS_SECTION.label, entry.options.label());
  const tree = entry.component();
  const iframe = tree.tag === 'iframe' ? tree : tree.children.find((node) => node?.tag === 'iframe');
  assert.ok(iframe, '设置分区没有嵌入设置页 iframe');
  const src = new URL(iframe.props.src);
  assert.match(src.pathname, /\/dsh-pet-extend\/settings$/);
  assert.equal(src.searchParams.get('embed'), '1');
  assert.equal(src.searchParams.get('token'), 'abc');
  assert.match(iframe.props.allow, /microphone/);
  assert.match(iframe.props.allow, /autoplay/);

  // 2. 菜单只保留打开对话：不再弹设置窗口，残留 settings 事件也不会误开聊天标签。
  assert.equal(globalThis.__opened.length, 0, '不应再用 window.open 打开设置页');
  assert.deepEqual(openedTabs, ['pet-chat'], 'open 事件没有打开原本的桌宠对话');
  const resultCall = calls.find((call) => call.url.pathname.endsWith('/api/open-result'));
  assert.ok(resultCall, '客户端没有回报打开结果');
  const result = JSON.parse(resultCall.init.body);
  assert.equal(result.action, undefined, '客户端不再上报 settings 动作');
  assert.equal(result.method, 'sidebarRight.openTab');
  for (const dispose of disposers) dispose();
}

async function checkClientOpensOriginalChat(available = true) {
  browserStubs();
  const calls = [];
  const openedTabs = [];
  let eventPolls = 0;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    let body = { ok: true, events: [] };
    if (url.pathname.endsWith('/api/menu-event')) {
      eventPolls += 1;
      if (eventPolls === 1) body = { ok: true, events: [{ label: '打开桌宠对话', pet: 'main' }] };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const suffix = available ? 'ok' : 'missing';
  await import(new URL(`./lib/client.js?${suffix}=1`, ROOT).href);
  const plugin = globalThis.__loaded.factory();
  assert.equal(globalThis.__loaded.id, 'dsh-pet-extend');
  assert.equal(plugin.name, 'pet-extend');

  const disposers = [];
  const ctx = {
    get: (name) => (name === 'sidebarRight' && available ? { openTab: (kind) => openedTabs.push(kind) } : undefined),
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  plugin.apply(ctx);
  await tick(300);

  const hello = calls.find((call) => call.url.pathname.endsWith('/api/hello') && call.init.method === 'POST');
  assert.ok(hello, '客户端半侧没有上报心跳');
  const resultCall = calls.find(
    (call) => call.url.pathname.endsWith('/api/open-result') && call.init.method === 'POST',
  );
  assert.ok(resultCall, '客户端没有回报打开结果');
  const result = JSON.parse(resultCall.init.body);
  assert.equal(result.pet, 'main');
  if (available) {
    assert.deepEqual(openedTabs, ['pet-chat'], '没有打开原本的桌宠对话标签');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'sidebarRight.openTab');
  } else {
    assert.equal(openedTabs.length, 0);
    assert.equal(result.ok, false);
  }
  for (const dispose of disposers) dispose();
}

/** 命中唤醒词且声纹通过（或无声纹时直接触发）后，应通过 dsh-pet 的 /broadcast 接口播放联动动画+气泡+朗读。 */
async function checkWakeReaction() {
  const broadcasts = [];
  const wakes = [];
  let sleeping = true; // 第一次广播模拟「睡觉中被门禁挡住」，验证叫醒后重试
  const pet = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/dsh-pet-7340/config' && req.method === 'GET') {
      send({ main: { pets: [{ id: 'pet-1', name: '肥鱼', display: 'desktop' }, { id: 'pet-2', name: '喵', display: 'none' }] } });
      return;
    }
    if (url.pathname === '/dsh-pet-7340/wake' && req.method === 'POST') {
      wakes.push(url.searchParams.get('pet'));
      sleeping = false;
      send({ ok: true, sleeping: false });
      return;
    }
    if (url.pathname === '/dsh-pet-7340/broadcast' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const surface = url.searchParams.get('surface');
        broadcasts.push({ pet: url.searchParams.get('pet'), surface, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        // /broadcast 的 ?surface= 必填：缺了就是 bad-request（这正是旧版没反应的根因）。
        if (!surface) return send({ ok: false, reason: 'bad-request' });
        if (sleeping) return send({ ok: false, reason: 'sleeping' });
        send({ ok: true });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => pet.listen(0, '127.0.0.1', resolve));

  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-pet-extend-react-'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    enabled: true, reactEnabled: true, wakeWords: ['大肥鱼'], speakerThreshold: 0.5, cooldownMs: 0,
  }));
  const modelDir = makeKwsModelDir();
  const routes = [];
  const ctx = {
    webServer: { port: pet.address().port, register(spec) { routes.push(spec); return () => {}; } },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  };
  const { apply } = await import(new URL('./lib/index.js', ROOT).href);
  apply(ctx, { menu: false, dataDir, kws: { enabled: true, modelDir, loadModule: () => makeFakeModule({ keyword: '大肥鱼', hit: true }) } });
  const server = createServer((req, res) => void routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let status;
    for (let i = 0; i < 30; i += 1) {
      status = await (await fetch(base + '/dsh-pet-extend/api/kws/status')).json();
      if (status.state === 'ready') break;
      await tick(30);
    }
    assert.equal(status.state, 'ready', '引擎未就绪');
    const session = await (await fetch(base + '/dsh-pet-extend/api/kws/session', { method: 'POST' })).json();
    assert.equal(session.ok, true, '开会话失败');
    const audio = await fetch(base + '/dsh-pet-extend/api/kws/audio?session=' + encodeURIComponent(session.sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(3200),
    }).then((r) => r.json());
    assert.equal(audio.triggered, true, '唤醒未触发');
    await tick(250);
    assert.equal(broadcasts.length, 2, '睡觉时应先叫醒再重发一次广播');
    assert.equal(broadcasts[0].surface, 'desktop', '广播必须带 ?surface=，且按 display 选 desktop');
    assert.equal(broadcasts[1].surface, 'desktop');
    assert.equal(broadcasts[1].pet, 'pet-1', '应发给已显示的那只（display=none 的跳过）');
    assert.equal(broadcasts[1].body.anim, true, '反应应联动动画');
    // 朗读改由客户端本地 Web Speech 完成：不再让宿主走易失败的 Edge 在线合成。
    assert.equal(broadcasts[1].body.speak, false, '不应让宿主合成语音（Edge 常 429）');
    assert.ok(['我在', '你好'].includes(broadcasts[1].body.text), '默认回应应是「我在 / 你好」之一');
    // 回应文案随 audio 响应回传给客户端本地朗读。
    assert.equal(audio.reactionText, broadcasts[1].body.text, 'audio 响应应带回本地朗读文案');
    assert.deepEqual(wakes, ['pet-1'], '睡觉时应先调用 /wake 叫醒');

    // 手动测试端点：不必真的喊唤醒词，也能触发一次反应
    const manual = await fetch(base + '/dsh-pet-extend/api/kws/react', { method: 'POST' }).then((r) => r.json());
    assert.equal(manual.ok, true, '手动测试反应失败');
    assert.ok(['我在', '你好'].includes(manual.text), '手动测试也应随机「我在 / 你好」');
    assert.equal(broadcasts.length, 3, '手动测试应再发一次广播');

    // reactEnabled=false 时不发广播，仅打开对话
    broadcasts.length = 0;
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      enabled: true, reactEnabled: false, wakeWords: ['大肥鱼'], speakerThreshold: 0.5, cooldownMs: 0,
    }));
    const audio2 = await fetch(base + '/dsh-pet-extend/api/kws/audio?session=' + encodeURIComponent(session.sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(3200),
    }).then((r) => r.json());
    assert.equal(audio2.triggered, true);
    await tick(150);
    assert.equal(broadcasts.length, 0, 'reactEnabled=false 时不应发反应广播');
  } finally {
    server.close();
    pet.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(modelDir, { recursive: true, force: true });
  }
}

/** 声纹校验取最响段：静音/回放音不应把 embedding 稀释到误拒。 */
async function checkVoiceprintFocus() {
  const { focusSegment } = await import(new URL('./lib/voiceprint.js', ROOT).href);
  const three = new Float32Array(16000 * 3);
  const loudAt = 16000;
  for (let i = loudAt; i < loudAt + 16000; i += 1) three[i] = 0.5;
  const segment = focusSegment(three, 16000 * 2);
  assert.equal(segment.length, 16000 * 2, '应截取固定 2 秒');
  let peak = 0;
  for (const value of segment) if (Math.abs(value) > peak) peak = Math.abs(value);
  assert.ok(peak > 0.4, '最响段没有覆盖到语音部分');
  const short = new Float32Array(8000);
  assert.equal(focusSegment(short, 16000 * 2).length, 8000, '不足一段时应原样返回');
}

checkSyntax();
await checkRoute();
await checkMenuHost();
await checkSettingsModule();
await checkKwsUnit();
await checkVoiceprintFocus();
await checkKwsRoute();
await checkSettingsFlow();
await checkEnrollErrorReply();
await checkWakeReaction();
await checkClientOpensOriginalChat(true);
await checkClientOpensOriginalChat(false);
await checkClientWakeAudio();
await checkClientWakeAudio(true); // 第一档约束抛 NotFoundError 时降级重试
await checkClientWakeAudio(false, false); // 长轮询事件完全失效时，仍应从 audio 响应打开对话
await checkClientSettingsSection();
console.log('dsh-pet-extend smoke test: OK');
