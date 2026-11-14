/**
 * 语音唤醒设置：持久化、自定义唤醒词 → sherpa-onnx ppinyin token 行。
 *
 * 中文 KWS 模型用「声母 + 带调韵母」建模（如 你好 → `n ǐ h ǎo`），keywords.txt
 * 每行格式：`<tokens> :boost #threshold @原始词`。本模块用内置常用字拼音表生成，
 * 若插件目录装了可选的 pinyin-pro 则用其全量词库；生成的每个 token 都会用模型
 * tokens.txt 校验，避免用户写出模型无法识别的唤醒词。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KWS_MODEL_DIR, SPEAKER_MODEL_PATH } from './models.js';

export const DEFAULT_WAKE_WORD = '大肥鱼';
/** 唤醒回应的默认候选（每次随机一句）。 */
export const DEFAULT_REACT_TEXTS = Object.freeze(['我在', '你好']);
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  wakeWords: [DEFAULT_WAKE_WORD],
  keywordLines: [],
  // 按「真人发音」实测（真实 int8 模型 + 用户本机按住测试录音，完整音频含前后静音）：
  // boost 3 / 阈值 0.08~0.15 全部命中；boost 2.5 全部漏检；boost 4 反而崩（流式解码过早重建）。
  // 中文 TTS 在 2/0.25 也能过，但真人发音更轻更快，所以默认取 3/0.15；误触多可自行回调。
  // 电平由用户自己调麦克风/系统音量，插件不做任何自动增益，也不靠堆灵敏度补偿。
  keywordsScore: 3.0,
  keywordsThreshold: 0.15,
  speakerThreshold: 0.5,
  cooldownMs: 1500,
  modelDir: '',
  speakerModel: '',
  modulePath: '',
  numThreads: 1,
  provider: 'cpu',
  debug: false,
  // 唤醒反应：命中唤醒词且声纹通过后，通过 dsh-pet 的 /broadcast 接口让桌宠播放联动动画 + 气泡 + 朗读。
  reactEnabled: true,
  reactPetId: '',
  reactText: '我在\n你好',
  reactAnim: true,
  reactSpeak: true,
  reactDuration: 8000,
});

const INITIALS = [
  'zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k',
  'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
];

/** 常用汉字 → 带调拼音；覆盖官方示例词、默认唤醒词与常见桌宠用语。 */
const CHAR_PINYIN_TEXT = `
大:dà 肥:féi 鱼:yú 你:nǐ 好:hǎo 军:jūn 哥:gē 蛋:dàn 小:xiǎo 爱:ài 同:tóng 学:xué
问:wèn 艺:yì 米:mǐ 林:lín 美:měi 丽:lì 西:xī 一:yī 二:èr 三:sān 四:sì 五:wǔ 六:liù
七:qī 八:bā 九:jiǔ 十:shí 零:líng 嘿:hēi 喂:wèi 哈:hā 嗨:hāi 请:qǐng 听:tīng 见:jiàn
醒:xǐng 来:lái 启:qǐ 动:dòng 开:kāi 始:shǐ 帮:bāng 忙:máng 主:zhǔ 人:rén 朋:péng 友:yǒu
宝:bǎo 贝:bèi 桌:zhuō 宠:chǒng 物:wù 白:bái 喵:miāo 汪:wāng 乖:guāi 快:kuài 起:qǐ 床:chuáng
吃:chī 饭:fàn 玩:wán 睡:shuì 的:de 了:le 我:wǒ 他:tā 她:tā 它:tā 们:men 是:shì 在:zài
有:yǒu 和:hé 就:jiù 不:bù 都:dōu 个:gè 上:shàng 也:yě 很:hěn 到:dào 说:shuō 要:yào 去:qù
会:huì 没:méi 看:kàn 这:zhè 那:nà 中:zhōng 叫:jiào 只:zhǐ 家:jiā 天:tiān 地:dì 日:rì
月:yuè 星:xīng 云:yún 风:fēng 雨:yǔ 花:huā 草:cǎo 树:shù 山:shān 水:shuǐ 火:huǒ 光:guāng
早:zǎo 晚:wǎn 安:ān 您:nín 猫:māo 狗:gǒu 鸟:niǎo 龙:lóng 虎:hǔ 兔:tù 牛:niú 羊:yáng
猪:zhū 鸡:jī 鸭:yā 鹅:é 红:hóng 蓝:lán 绿:lǜ 黄:huáng 黑:hēi 紫:zǐ 橙:chéng 跑:pǎo
跳:tiào 走:zǒu 坐:zuò 站:zhàn 唱:chàng 笑:xiào 摸:mō 抱:bào 举:jǔ 转:zhuàn 停:tíng 出:chū
进:jìn 回:huí 给:gěi 拿:ná 找:zhǎo 想:xiǎng 知:zhī 道:dào 吧:ba 吗:ma 呢:ne 啊:ā
豆:dòu 包:bāo 糖:táng 果:guǒ 茶:chá 电:diàn 脑:nǎo 手:shǒu 机:jī 声:shēng 音:yīn 语:yǔ
唤:huàn 命:mìng 令:lìng 设:shè 置:zhì 对:duì 行:xíng 乖:guāi 鱼:yú 儿:ér 子:zǐ 女:nǚ
`;
export const CHAR_PINYIN = Object.freeze(
  Object.fromEntries(CHAR_PINYIN_TEXT.trim().split(/\s+/).map((pair) => pair.split(':'))),
);

let pinyinPro = undefined;
function pinyinOf(char) {
  if (pinyinPro === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const mod = require('pinyin-pro');
      pinyinPro = typeof mod?.pinyin === 'function' ? mod.pinyin : null;
    } catch {
      pinyinPro = null;
    }
  }
  if (pinyinPro) {
    try {
      const list = pinyinPro(char, { toneType: 'symbol', type: 'array', nonZh: 'removed' });
      if (Array.isArray(list) && typeof list[0] === 'string' && list[0]) return list[0];
    } catch {
      // 回退内置表
    }
  }
  return CHAR_PINYIN[char];
}

export function splitPinyin(pinyin) {
  for (const initial of INITIALS) {
    if (!pinyin.startsWith(initial)) continue;
    const final = pinyin.slice(initial.length);
    return final ? [initial, final] : [initial];
  }
  return [pinyin];
}

export function readTokenSet(tokensFile) {
  if (!tokensFile || !existsSync(tokensFile)) return new Set();
  return new Set(
    readFileSync(tokensFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
}

/** 把中文唤醒词转成 `d à f éi y ú` 这样的 token 串。 */
export function wordToTokens(word, tokenSet, pinyinFn = pinyinOf) {
  const chars = [...String(word).replace(/\s+/g, '')];
  if (chars.length < 2 || chars.length > 12) throw new Error('唤醒词需要 2~12 个汉字');
  const tokens = [];
  for (const char of chars) {
    if (!/[\u4e00-\u9fff]/.test(char)) throw new Error(`「${char}」不是汉字`);
    const pinyin = pinyinFn(char);
    if (!pinyin) throw new Error(`「${char}」缺少拼音数据，请换一个词或用高级 token 行`);
    for (const part of splitPinyin(pinyin)) {
      if (tokenSet.size > 0 && !tokenSet.has(part)) {
        throw new Error(`「${char}」的 token「${part}」不在模型词表中`);
      }
      tokens.push(part);
    }
  }
  return tokens.join(' ');
}

/**
 * 默认灵敏度随实测演进：
 * - 0.3.0 曾用 3/0.16，后因 TTS 慢速漏检改回 2.0/0.25；
 * - 真人按住测试录音实测：2.0/0.25 全部漏检，boost 3 + 阈值 0.08~0.15 全部命中，boost 4 反而崩。
 * 因此 2.0/0.25 与 3/0.16 都视作旧默认，统一迁移到当前的 3/0.15。
 * 只迁移「完全等于旧默认值」的情况，不动用户手动调过的其他参数，也不改写磁盘文件
 * （下次保存设置时自然写入新值）。
 */
export function migrateLegacyDefaults(value) {
  if (!value) return value;
  const legacy =
    (value.keywordsScore === 2 && value.keywordsThreshold === 0.25) ||
    (value.keywordsScore === 3 && value.keywordsThreshold === 0.16);
  if (!legacy) return value;
  return {
    ...value,
    keywordsScore: DEFAULT_SETTINGS.keywordsScore,
    keywordsThreshold: DEFAULT_SETTINGS.keywordsThreshold,
  };
}

export function normalizeWords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export function sanitizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const wakeWords = normalizeWords(source.wakeWords);
  return {
    enabled: source.enabled === true,
    wakeWords: wakeWords.length > 0 ? wakeWords.slice(0, 8) : [DEFAULT_WAKE_WORD],
    keywordLines: Array.isArray(source.keywordLines)
      ? source.keywordLines.map((line) => String(line).trim()).filter(Boolean).slice(0, 16)
      : [],
    keywordsScore: bounded(source.keywordsScore, DEFAULT_SETTINGS.keywordsScore, 0, 10),
    keywordsThreshold: bounded(source.keywordsThreshold, DEFAULT_SETTINGS.keywordsThreshold, 0, 1),
    speakerThreshold: bounded(source.speakerThreshold, DEFAULT_SETTINGS.speakerThreshold, 0, 1),
    cooldownMs: bounded(source.cooldownMs, DEFAULT_SETTINGS.cooldownMs, 0, 60000),
    modelDir: typeof source.modelDir === 'string' ? source.modelDir : '',
    speakerModel: typeof source.speakerModel === 'string' ? source.speakerModel : '',
    modulePath: typeof source.modulePath === 'string' ? source.modulePath : '',
    numThreads: bounded(source.numThreads, DEFAULT_SETTINGS.numThreads, 1, 8),
    provider: typeof source.provider === 'string' && source.provider ? source.provider : 'cpu',
    debug: source.debug === true,
    reactEnabled: source.reactEnabled !== false,
    reactPetId: typeof source.reactPetId === 'string' ? source.reactPetId.trim().slice(0, 40) : '',
    // 多行候选：每行一句，触发时随机选一条；空行忽略。缺省给「我在 / 你好」。
    reactText: typeof source.reactText === 'string'
      ? source.reactText.trim().slice(0, 500)
      : DEFAULT_REACT_TEXTS.join('\n'),
    reactAnim: source.reactAnim !== false,
    reactSpeak: source.reactSpeak !== false,
    reactDuration: bounded(source.reactDuration, DEFAULT_SETTINGS.reactDuration, 1000, 60000),
  };
}

/** 生成 keywords.txt 内容；单个词失败不影响其它词，错误返回给设置页提示。 */
export function buildKeywordLines(settings, tokensFile, pinyinFn = pinyinOf) {
  const current = sanitizeSettings(settings);
  const tokenSet = readTokenSet(tokensFile);
  const words = current.wakeWords;
  const lines = [];
  const errors = [];
  for (const word of words) {
    try {
      const tokens = wordToTokens(word, tokenSet, pinyinFn);
      lines.push(`${tokens} :${current.keywordsScore} #${current.keywordsThreshold} @${word}`);
    } catch (error) {
      errors.push(`${word}：${error?.message ?? error}`);
    }
  }
  for (const line of current.keywordLines) lines.push(line);
  if (lines.length === 0) throw new Error(errors.join('；') || '没有可用的唤醒词');
  return { lines, words, errors, text: lines.join('\n') + '\n' };
}

export function defaultDataDir() {
  return process.env.DSH_PET_EXTEND_DATA_DIR || join(homedir(), '.dsh', 'dsh-pet-extend');
}

export function createSettingsStore({ dataDir = defaultDataDir(), tokensFile = join(KWS_MODEL_DIR, 'tokens.txt') } = {}) {
  const dir = dataDir;
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, 'settings.json');
  const keywordsPath = join(dir, 'keywords.txt');
  const voiceprintPath = join(dir, 'voiceprint.json');

  function loadSettings() {
    try {
      return migrateLegacyDefaults(sanitizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8'))));
    } catch {
      return sanitizeSettings(DEFAULT_SETTINGS);
    }
  }

  function saveSettings(patch) {
    const next = sanitizeSettings({ ...loadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  function buildKeywords(settings = loadSettings(), tokens = tokensFile, pinyinFn = pinyinOf) {
    const result = buildKeywordLines(settings, tokens, pinyinFn);
    writeFileSync(keywordsPath, result.text, 'utf8');
    return { ...result, path: keywordsPath };
  }

  return {
    dir,
    settingsPath,
    keywordsPath,
    voiceprintPath,
    tokensFile,
    defaultModelDir: KWS_MODEL_DIR,
    defaultSpeakerModel: SPEAKER_MODEL_PATH,
    loadSettings,
    saveSettings,
    buildKeywords,
  };
}
