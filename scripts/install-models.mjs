#!/usr/bin/env node
/**
 * 补装/升级随插件提供的模型（正常安装已自带 models/，无需执行）。
 * 用法：
 *   node scripts/install-models.mjs            # 只补缺失的模型
 *   node scripts/install-models.mjs --force   # 强制重新下载
 *   node scripts/install-models.mjs --deps    # 顺便安装可选的 sherpa-onnx-node / pinyin-pro
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installModels, modelStatus } from '../lib/models.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

if (process.argv.includes('--deps')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(npm, ['install', '--no-save', 'sherpa-onnx-node', 'pinyin-pro'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn('[dsh-pet-extend] 可选依赖安装失败：' + String(error?.message ?? error));
  }
}

if (!force && modelStatus().complete) {
  console.log('[dsh-pet-extend] 模型已齐全：' + JSON.stringify(modelStatus()));
  process.exit(0);
}

let lastReport = 0;
const result = await installModels({
  force,
  onProgress: ({ label, received, total }) => {
    const mb = Math.floor(received / (5 * 1048576));
    if (mb <= lastReport) return;
    lastReport = mb;
    console.log(`[dsh-pet-extend] ${label}：${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  },
});
console.log('[dsh-pet-extend] 结果：' + JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
