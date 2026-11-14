# dsh-pet-extend

DSH（dsh-pet 桌宠）的语音唤醒扩展：在桌宠右键菜单里直接打开对话，并用**完全离线**的中文语音唤醒词 + 声纹校验把它叫起来。

识别与声纹推理全部在本机跑（sherpa-onnx），不上传任何音频。

- 唤醒引擎：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 中文 KWS（`sherpa-onnx-kws-zipformer-wenetspeech-3.3M`）
- 声纹模型：[3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker)（`campplus_sv_zh-cn_16k-common`）
- 宿主：DSH + dsh-pet（不修改 dsh-pet 源码，也不改 DSH 内核）

## 特性

| 能力 | 说明 |
| --- | --- |
| 离线语音唤醒 | 默认唤醒词「大肥鱼」，可自定义任意中文词 |
| 声纹二次校验 | 最多 3 条声纹模板，逐条比对取最高分，别人喊不醒 |
| 并行多档灵敏度 | 同一句词同时用 3~4 档关键词加成解码，覆盖不同语速/节奏/音量 |
| 声纹逐条回放 | 每次录入单独存一份原始录音，可逐条播放对比 |
| 按住录音测试 | 走与正式监听完全相同的解码 + 声纹链路，但不真的打开对话 |
| 唤醒反应 | 打开对话 + 桌宠联动动画 + 气泡 + 朗读（音色跟随 dsh-pet 设置） |
| 诊断面板 | 检测/触发/拒绝/解码/未命中、音频峰值、有效语音占比、并行档位、最近跳过原因 |
| 不做的事 | 不自动调节麦克风音量、不做 AGC、不缩放音频幅度、不上传音频 |

## 环境要求

- 已安装 DSH，并且 dsh-pet 桌宠可正常使用
- Node.js **>= 22.12.0**
- 可用的麦克风
- Windows / macOS / Linux（依赖 `sherpa-onnx-node` 的预编译包）

## 安装

### 1. 作为 DSH 插件安装

```bash
# <profile> 换成你的 DSH profile 名；路径用本目录的绝对路径
dsh plugin --profile <profile> add file:/absolute/path/to/dsh-pet-extend
```

Windows 示例：

```powershell
dsh plugin --profile default add file:E:\path\to\dsh-pet-extend
```

### 2. 安装依赖

```bash
cd dsh-pet-extend
npm install
# 若 DSH 没有自动装可选依赖，再执行一次：
npm run install:deps
```

`package.json` 里 `sherpa-onnx-node` 与 `pinyin-pro` 是 `optionalDependencies`：
前者负责 KWS 与声纹推理，后者提供全量汉字拼音（缺失时退回内置常用字表）。

### 3. 模型

仓库内的 `models/` 已附带模型（约 32 MB）：

```
models/kws/       encoder / decoder / joiner (.int8.onnx) + tokens.txt
models/speaker/   3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
```

若缺失或损坏：

```bash
npm run install:models          # 补装
npm run install:models -- --force   # 强制重下
```

### 4. 重启 DSH

插件代码在 DSH 启动时加载，**改完代码或首次安装都必须重启 DSH**（`dsh web` 就重启 `dsh web`）。设置页上的「重新初始化引擎」只会重建 native 语音引擎，不会重载插件 JS。

## 首次使用

1. 打开设置页：DSH 设置 → **桌宠扩展设置**，或直接访问
   `http://127.0.0.1:<DSH端口>/dsh-pet-extend/settings`
2. 点「申请麦克风权限」，允许授权
3. 点「开始录入（3 秒）」，等提示「麦克风已就绪」后连续清晰地念 3 秒唤醒词；建议录 2~3 次
4. 在「唤醒词」里填写（默认「大肥鱼」），点保存
5. 打开「语音唤醒」开关
6. 正常喊唤醒词即可

> 未录入声纹时开关不可用。数据保存在 `~/.dsh/dsh-pet-extend/`。

## 设置项

| 项目 | 默认 | 说明 |
| --- | --- | --- |
| 唤醒词 | 大肥鱼 | 中文即可，多个词用逗号/换行分隔；会转成模型需要的拼音 token |
| 唤醒加成 `keywordsScore` | 3.0 | 数值越高越灵敏，但过高会让流式解码过早重建，反而漏检 |
| 触发阈值 `keywordsThreshold` | 0.15 | 越低越容易触发 |
| 声纹阈值 `speakerThreshold` | 0.5 | 越高越严格；0.3 明显更松，误触也会变多 |
| 唤醒冷却 `cooldownMs` | 1500 | 两次唤醒的最小间隔，低于它会被「冷却」挡掉 |
| 语音唤醒 | 关闭 | 总开关；关闭后会真正释放麦克风 |

**并行档位**：引擎实际会同时跑 `1.5 / 2 / 2.5` 三档（把加成设成 3 时再加一档 3），
同一块音频喂给所有档位，任一档吐词就触发。原因是三字词的最优加成会随语速漂移——
单档参数一定会在某些语速下漏检。

## 诊断与排错

设置页「诊断」会显示：

```
引擎 ready · 并行档位 1.5 / 2 / 2.5
检测 12 / 触发 11 / 拒绝 1
解码 3109 段 · 未命中 3096 段 · 最近跳过 冷却中
音频 3113 段 · 峰值 0.088/1.000 · 有效语音 99%
```

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `解码` 不涨 | 引擎没在跑 | 看引擎状态与「重新初始化引擎」 |
| `解码` 在涨但 `检测 0` | 引擎没识别出唤醒词 | 换成四字/叠词、放慢、加大音量；或看「按住录音测试」的归因 |
| `检测` 在涨但 `触发 0` | 识别到了但没通过 | 看「最近跳过」：`冷却中` / `声纹未通过` / `分数低于阈值` |
| 有效语音占比很低 | 采集端把声音吃掉了 | 检查系统「音频增强/降噪」；靠近麦克风 |
| 峰值接近 1.000 | 电平过高已削波 | 调低系统麦克风音量 |
| `Could not start audio source` | `NotReadableError`：麦克风启动不了 | 多为设备被占用：先关掉「语音唤醒」开关、等 5 秒再申请；再查 Windows 隐私里的「允许桌面应用访问麦克风」 |

「按住录音测试」会在没检出时给出归因：

- 放大后能检出 → **电平问题**，提示调高系统麦克风音量
- 放大也检不出 → **发音/语速与词表不匹配**
- 换个加成能检出 → 直接告诉你「把加成改成 X 再试」

还可以点「回放刚才的录音」听引擎实际收到的声音，点「回放最近监听」对比正式监听收到的声音。

## 工作原理

```
麦克风 ──getUserMedia（关闭降噪/回声消除/AGC）──► AudioContext
   └─ 127 抽头 Blackman 窗 FIR 抗混叠低通 ──► 16 kHz Int16 PCM
        └─ 每 100 ms 一块 ──► POST /api/kws/audio（串行队列，带超时与合并）
             └─ KeywordSpotter × 3~4 档（并行）──► 命中
                  └─ 按唤醒词对齐截取 ──► 声纹余弦相似度 ──► 触发
```

几个关键取舍：

- **不做任何自动增益**。`getUserMedia` 各档都显式 `autoGainControl: false`，编码只做
  Float32→Int16 的数值限幅，KWS 与声纹、录入与监听四条路径电平完全一致。
- **首选 `{ exact: false }` 强制关闭降噪与回声消除**。WebRTC 里这三项默认就是 `true`，
  写 `false` 只是 ideal，设备可以忽略；Windows 驱动一旦开启会把持续人声压到底噪。
- **命中后重建流而不是 `reset`**。实测 `reset` 连续 8 轮只中 5/8，每次 `createStream` 是 8/8。
- **流在第一次收到音频时才创建**。sherpa-onnx 的 KeywordStream 需要「创建后立刻
  `acceptWaveform`」，先建流再等音频会让 `isReady` 恒为 false。
- **AudioWorklet 内部攒到 4096 帧再发给主线程**。每 128 帧发一次（约 375 次/秒）会把主线程淹没。

## 常见问题

**为什么一定要录声纹？**
插件是「唤醒词 + 声纹」双重校验，避免别人或电视里的一句话把桌宠叫出来。未录入声纹时开关不可用。

**换唤醒词后不灵敏？**
模型自带词表全是 4 字/叠词，2~3 字短词对语速和发音很敏感。可以：
1. 把「唤醒加成」在 1.5~3 之间微调（或看按住测试给出的建议值）；
2. 换成四字词（如模型自带的「小爱同学」）；
3. 放慢、字间稍分开，说完停 0.2~0.3 秒再松手。

**多条声纹有什么好处？**
最多保留 3 条模板，比对时取最高分。3 次录入的音色/音量差异很大，只比均值会把分数稀释
（实测同一段录音均值 0.292、逐条最高 0.622）。

**模型 32 MB 会一直占内存吗？**
KWS 是 3.3M 的小模型，常驻内存很小；声纹模型只在录入/校验时用。并行多档实测每 100 ms
音频约 6 ms CPU。

**支持哪些平台？**
取决于 `sherpa-onnx-node` 的预编译包。Windows x64 已验证；macOS / Linux 理论上可用，未逐一实测。

## 开发

```bash
npm test                 # 烟雾 + 回归测试（含假推理模块，不需要真模型）
```

```
lib/
  index.js              服务端：HTTP 路由、设置、声纹、模型装配
  client.js             DSH 客户端：菜单、麦克风采集、上传、唤醒反应
  kws.js                KWS 引擎：并行多档、会话、诊断统计
  voiceprint.js         声纹录入与校验
  settings.js           设置持久化、唤醒词 → 拼音 token
  models.js             模型路径与下载地址
  pages/settings.html   设置页（原生 JS，无框架）
scripts/install-models.mjs
test/smoke.mjs
```

常用调试接口（同源）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/kws/status` | 引擎/客户端/诊断计数 |
| `POST /api/kws/retry` | 重建引擎（等真正结束再返回） |
| `POST /api/kws/test` | 按住录音测试（body 为 16 kHz Int16LE PCM） |
| `GET /api/kws/test/audio` | 回放刚才的测试录音 |
| `GET /api/kws/listen-audio` | 回放正式监听最近 6 秒 |
| `GET /api/kws/voiceprint/audio?index=N` | 逐条回放声纹录音 |
| `GET /api/kws/level` | 麦克风电平/有效语音占比 |

## 数据与隐私

所有数据都在本机 `~/.dsh/dsh-pet-extend/`：

```
settings.json           设置
keywords.txt            当前唤醒词 token
voiceprint.json         声纹特征向量
voiceprint-*.wav        每次录入的原始录音（用于回放）
voiceprint-audio.json   录音索引
```

音频不离开本机，也不写入插件目录之外的任何位置。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

模型来自 sherpa-onnx / 3D-Speaker 社区发布，遵循其各自的许可证；仓库内仅为方便安装而附带。
