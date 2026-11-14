/**
 * 声纹录入与校验：sherpa-onnx SpeakerEmbeddingExtractor + 余弦相似度。
 * 声纹向量存到数据目录的 voiceprint.json，最多保留最近 3 次录入并取归一化均值。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadSherpaModule } from './kws.js';

export const MIN_ENROLL_SAMPLES = 16000;
export const MIN_VERIFY_SAMPLES = 8000;
export const MAX_ENROLLMENTS = 3;

export function normalize(vector) {
  const values = Array.from(vector, Number);
  const norm = Math.hypot(...values);
  return norm > 0 ? values.map((value) => value / norm) : values;
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function meanVectors(list) {
  const size = list[0].length;
  const sum = new Array(size).fill(0);
  for (const vector of list) {
    for (let i = 0; i < size; i += 1) sum[i] += vector[i];
  }
  return normalize(sum.map((value) => value / list.length));
}

/**
 * 取最响的一段（默认 2 秒）用于声纹 embedding。
 *
 * 唤醒时校验窗口是「最近 3 秒」，其中常混有静音或反应回放音；直接对整段算 embedding
 * 会被稀释，导致同一人偶发掉到阈值以下被误拒。取能量最高的一段让语音占据主导，分数更稳。
 */
export function focusSegment(samples, span = 16000 * 2) {
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  if (src.length <= span) return src;
  const hop = Math.max(1, Math.floor(16000 / 20)); // 50ms 步进
  let bestStart = 0;
  let bestEnergy = -1;
  for (let start = 0; start + span <= src.length; start += hop) {
    let energy = 0;
    for (let i = start; i < start + span; i += 4) energy += src[i] * src[i];
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return src.subarray(bestStart, bestStart + span);
}

export function createVoiceprint({
  modelPath,
  filePath,
  loadModule = loadSherpaModule,
  getThreshold = () => 0.5,
  log = () => {},
  warn = () => {},
} = {}) {
  let extractor = null;
  let extractorError = null;
  let record = null;

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed?.vector) || parsed.vector.length === 0) return null;
      return {
        version: 1,
        dim: parsed.vector.length,
        vector: normalize(parsed.vector),
        samples: Array.isArray(parsed.samples) ? parsed.samples.filter((item) => Array.isArray(item)) : [],
        enrolledAt: Number(parsed.enrolledAt) || Date.now(),
        count: Number(parsed.count) || 1,
      };
    } catch {
      return null;
    }
  }
  record = read();

  function ensureExtractor() {
    if (extractor) return extractor;
    if (extractorError) throw new Error(extractorError);
    if (!modelPath || !existsSync(modelPath)) {
      extractorError = '声纹模型不存在：' + (modelPath || '(未设置)');
      throw new Error(extractorError);
    }
    try {
      const mod = loadModule({ modulePath: '' });
      const Extractor = mod?.SpeakerEmbeddingExtractor ?? mod?.default?.SpeakerEmbeddingExtractor;
      if (typeof Extractor !== 'function') throw new Error('sherpa-onnx-node 未导出 SpeakerEmbeddingExtractor');
      extractor = new Extractor({ model: modelPath, numThreads: 1, provider: 'cpu', debug: 0 });
      log('声纹模型已加载：' + modelPath);
      return extractor;
    } catch (error) {
      extractorError = String(error?.message ?? error);
      warn('声纹模型加载失败：' + extractorError);
      throw new Error(extractorError);
    }
  }

  function embeddingOf(samples) {
    const source = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    // 先复制成当前 realm 的普通 ArrayBuffer，别把 external-backed 数组交给 addon。
    const floats = new Float32Array(source.length);
    floats.set(source);
    const stream = ensureExtractor().createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: floats });
    // compute() 默认 enableExternalBuffer=true，用 native 外部内存返回向量；
    // Electron 的 V8 会抛「External buffers are not allowed」，传 false 让它复制成普通 ArrayBuffer。
    let vector;
    try {
      vector = extractor.compute(stream, false);
    } catch (error) {
      if (/external buffer/i.test(String(error?.message ?? error))) {
        throw new Error('sherpa-onnx-node 版本过旧，不支持禁用 external buffer，请升级到 2.0.1+：' +
          String(error?.message ?? error));
      }
      throw error;
    }
    if (!vector || vector.length === 0) throw new Error('声纹向量为空');
    return normalize(vector);
  }

  function persist() {
    if (record) writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    else rmSync(filePath, { force: true });
  }

  function enroll(samples) {
    const length = samples?.length ?? 0;
    if (length < MIN_ENROLL_SAMPLES) {
      return { ok: false, reason: 'audio-too-short', samples: length, minSamples: MIN_ENROLL_SAMPLES };
    }
    const vector = embeddingOf(focusSegment(samples));
    const list = [...(record?.samples ?? []), vector].slice(-MAX_ENROLLMENTS);
    record = {
      version: 1,
      dim: vector.length,
      vector: meanVectors(list),
      samples: list,
      enrolledAt: Date.now(),
      count: list.length,
    };
    persist();
    return { ok: true, count: record.count, dim: record.dim, samples: length };
  }

  function verify(samples) {
    if (!record) return { ok: false, score: 0, reason: 'no-voiceprint' };
    if ((samples?.length ?? 0) < MIN_VERIFY_SAMPLES) {
      return { ok: false, score: 0, reason: 'audio-too-short' };
    }
    try {
      const source = samples instanceof Float32Array ? samples : Float32Array.from(samples);
      const threshold = Number(getThreshold()) || 0.5;
      const templates = [record.vector, ...(record.samples ?? [])].filter(Boolean);
      // 多模板取最高分：3 次录入的音色/音量/距离本来就不同，用均值会把差异平均掉，
      // 对任何一次都不够像（实测同一人 0.292，与阈值 0.30 只差 0.008）。逐条比对取最像的那条更合理。
      const best = (embedding) => {
        let top = 0;
        for (const template of templates) {
          const one = cosine(embedding, template);
          if (one > top) top = one;
        }
        return top;
      };
      const focused = focusSegment(source);
      let score = best(embeddingOf(focused));
      // 二次判定：聚焦段没过阈值时，再用整段算一次取较高分。窗口选择本身会带来波动，
      // 单次没过就判「不是本人」误拒偏多；两次取高分能明显降低同一人被拒的概率。
      if (score < threshold && focused.length < source.length) {
        try {
          const full = best(embeddingOf(source));
          if (full > score) score = full;
        } catch {
          // 第二次失败就保留第一次的分数
        }
      }
      return { ok: score >= threshold, score, threshold, reason: score >= threshold ? 'ok' : 'below-threshold' };
    } catch (error) {
      return { ok: false, score: 0, reason: String(error?.message ?? error) };
    }
  }

  function clear() {
    record = null;
    persist();
    return { ok: true };
  }

  function summary() {
    return {
      present: Boolean(record),
      count: record?.count ?? 0,
      dim: record?.dim ?? 0,
      enrolledAt: record?.enrolledAt ?? null,
      modelPath,
      modelPresent: Boolean(modelPath && existsSync(modelPath)),
      extractorError,
      threshold: Number(getThreshold()) || 0.5,
    };
  }

  return { enroll, verify, clear, summary, reload: () => { record = read(); }, current: () => record };
}
