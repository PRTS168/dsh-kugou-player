# dsh-music-player

让 DSH 自己放网络音乐。给模型五个工具：**按歌名搜索并播放、单曲循环、暂停/继续、音量与状态、扫码登录**。

**不依赖任何外部软件** —— 不需要 ffplay、mpv、MoeKoe 或任何伴随程序。插件自己下载音频、
自己解码、自己把声音送到本机扬声器。

## 五个工具

| 工具 | 用途 |
|---|---|
| `play_music` | 按歌名（可带歌手）搜索并播放；`loop: true` 即单曲循环 |
| `music_control` | `pause` / `resume` / `toggle` / `stop` / `volume` / `loop` |
| `music_status` | 当前曲目、歌手、音质、进度、音量、循环状态 |
| `search_music` | 列出候选（曲名、歌手、时长、可用音质），供模型挑版本 |
| `music_login` | 扫码登录酷狗账号以播放原版 / VIP 曲 |

模型说「放首晴天」「单曲循环」「暂停一下」「声音小点」都会直接落到这些工具上，
不需要你给链接，也不需要它承认"我放不了音乐"。

## 它怎么出声的

音频由 [`node-web-audio-api`](https://github.com/ircam-ismm/node-web-audio-api)
在插件进程内渲染 —— 这是 Web Audio API 的 Node 实现，**自带 Windows x64 预编译二进制**，
所以不需要编译器、不需要 Rust、不需要 MSVC Build Tools。

选它而不是 ffplay/mpv 的原因是需求本身：

| 需求 | ffplay / mpv | Web Audio |
|---|---|---|
| 单曲循环 | 要重建进程 | `source.loop = true`，**无缝**，且不重新下载 |
| 暂停 / 继续 | 要 IPC 或杀进程 | `AudioContext.suspend()` / `resume()`，**样本级精确** |
| 安装成本 | 装一个外部程序 | 一个 npm 依赖，随包带二进制 |

代价是整首歌会先下载并解码进内存（4 分钟立体声约 100MB PCM），换来的是一次下载、无限次无缝循环。
`maxTrackMinutes` 就是给这个开销兜底的。

## 音源

搜索走 `songsearch.kugou.com/song_search_v2`，取直链走 `trackercdn.kugou.com/i/v2/`，
两个都是酷狗自己的公开网页接口，**不需要账号、不需要 cookie、不需要签名**。

取链接口只用 `md5(hash + 'kgcloudv2')` 这个固定常量把关，**不校验登录、也不校验 VIP**，
所以 128 / 320 / 无损三档都能免登录拿到（默认取该曲可用的最高档）。

### 搜索：`platform` 参数是必须的

搜索请求**必须带 `platform=WebFilter`**。这个参数不是可有可无的调优项，去掉它结果集会被降级：

| 请求 | 「水手 郑智化」的第一个干净歌名条目 |
|---|---|
| 不带 `platform` | `水手` **120s**，专辑名/AlbumID **全空** ← 占位试听条目 |
| `platform=WebFilter` | `水手` **292s**，专辑 **《私房歌》** ← 原版录音室版 |

实测 2026-09-19，差异只来自这一个参数（`AndroidFilter` 同样有效）。早期版本的插件漏了它，
于是错误地得出了"曲库没有原版"的结论 —— 那是**调用姿势的问题，不是曲库的问题**。

### 播放：搜索是公开的，听歌要登录

这是两件事，必须分开看：

- ✅ **搜索**：完全公开，免登录就能搜到原版，包括专辑、时长等完整元数据
- ❌ **播放**：原版 / VIP 曲目免登录**只能试听 60 秒**

未登录时解析原版《水手》，酷狗返回的是：

```json
{ "priv_status": 0, "auth_through": [], "fail_process": ["pkg","buy"],
  "hash_offset": { "start_ms": 0, "end_ms": 60000 } }
```

`fail_process: ["pkg","buy"]` = 需要购买/会员；`end_ms: 60000` = 只给 60 秒试听。
换句话说：**能搜到 ≠ 能听完整**。

第三方客户端如 MoeKoe 之所以能放，靠的是**账号登录态**（手机号+验证码或扫码），
请求里带上 `token`/`userid`，酷狗才放行。跟"签到"无关。

### 登录（这样才能放原版）

**首选：扫码。** 因为酷狗的短信接口在风控后面——**发码前会要求图形验证码**，
插件在无浏览器环境下解不了。而**扫码本身就是人工验证**，完全绕开这道门（实测无 `ssa-code`）。

> ⚠️ 短信路径实测返回：`ssa-code: bj_tx_event_...` + `{"error_code":20028,"data":"请先通过验证"}`。
> 这是酷狗的风控门，不是签名问题（签名已验证被接受）。

**方式一：对话里扫码**（`music_login` 工具）

```
你：放首水手
AI：原版需要登录才能播，现在放的是现场版。要登录吗？
你：好
AI：（调 music_login qr_start）二维码已生成并打开，请用酷狗 App 扫码
你：（扫码）
AI：（调 music_login qr_poll）✅ 扫码登录成功（userid 12345）
```

| action | 作用 |
|---|---|
| `qr_start` | 生成登录二维码，渲染成 PNG 并自动打开 |
| `qr_poll` | 轮询扫码结果，授权成功后保存会话 |
| `status` | 查询是否已登录 |
| `logout` | 清除本地会话 |

**方式二：终端扫码**（推荐，不进对话、不出图）

```bash
cd D:/deepseek/dsh-music-player
npm run login          # 在终端里直接画出二维码（仅支持扫码）
```

终端会直接画出 ASCII 二维码，用酷狗 App 扫即可，之后自动轮询到登录成功。

---

两种方式都把 `token`/`userid` + 设备身份写进 `.session.json`（已列入 `.gitignore`）。
登录后插件会**自动重读**该文件（按 mtime 判断），通常不用重启。

**为什么扫码能过、短信不能**：扫码给你的手机 App 授权，本身就是强人工验证；
短信接口则是酷狗防刷号的重点，`send_mobile_code` 会带 `ssa-code` 要求腾讯图形验证码，
官方客户端是在浏览器里弹验证码解决的——插件做不到，所以走扫码。

**关于登录的实现（全部在本插件内，不依赖任何其他软件）**

酷狗自己的登录接口裹了好几层加密，插件把它们**完整移植了进来**（`lib/kugou-crypto.js`）：

| 环节 | 做法 |
|---|---|
| 设备身份 | `mid = MD5(guid)` 按十六进制读成十进制大整数；`dfid`/`dev`/`mac` 用酷狗客户端的同一套字母表生成，持久化在 `.session.json` |
| 请求签名 | `MD5(salt + 排序后的 k=v 拼接 + body + salt)`，概念版专属 salt |
| 凭据加密 | 手机号+验证码用一次性 AES-256-CBC 加密；该 AES 密钥再用 **RSA 无填充裸加密**（`m^e mod n`，左补零到模长）封进 `pk` 字段 |
| 反刷字段 | `t1`/`t2` 用固定密钥的 AES 生成 |
| 会话回传 | 响应里的 `secu_params` 用同一个一次性密钥解开，取出 token |

这些算法是从 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（MIT）移植的，
常数与构造都属于该项目的工作，不是本插件的发明——这一点在源码注释里也写明了。

**移植正确性有真实向量验证**：`scripts/crypto-test.mjs` 里拿一条从**实际运行的
KuGouMusicApi 服务** cookie 中观测到的 `guid → mid` 对应关系做断言。
如果移植错了，这条就会失败，而所有签名请求都会被酷狗拒绝。

登录仅支持扫码，本身只用到三个酷狗端点：
`userservice.kugou.com/risk/v2/r_register_dev`（设备身份）、
`login-user.kugou.com/v2/qrcode`（取二维码 key）和
`login-user.kugou.com/v2/get_userinfo_qrcode`（轮询扫码结果）。

未登录时插件照常工作，只是原版会走回退（免费版本能放，需要会员的会跳过并说明）。

### 免费可播的部分

- ✅ 免登录就能完整播放的曲目：128kbps / 320kbps / **无损 FLAC** 都能拿
- ⚠️ 需要购买或登录的原版：会走**回退**，改放同曲可免费播放的版本（通常是现场版）
- ℹ️ 回退时 `play_music` 会明确说明"原版需要付费或登录，现在播放的是备选版本"，
  而不是把现场版当成原版塞给你

回退是有深度的：`晴天 周杰伦` 排名前 9 全是付费版，第 10 位才是可播的；
所以解析按**分批并发**向下探测（每批 4 个，最多 12 个），而不是只试第一名。

### 试听片段防护

免登录搜索还会混进 120 秒的占位条目。它的歌名最"干净"，所以会拿到无括号加分，
**被选中后播 2 分钟就结束，用户还不知道为什么** —— 这是个真 bug。

现在的规则是**相对长度**，不是绝对阈值：

- 以同曲候选里**最长的那条**为基准
- 短于基准 60% 的条目判为疑似试听，重罚
- 达到基准 85% 的给加分
- 万一还是选中了偏短条目，`play_music` 会明确告知"疑似试听片段"

配套的变体惩罚也分成两档：**DJ/remix/改编/伴奏 -25**，**Live/现场 -10**。
原版不可得时，现场版比 DJ 混音更接近"这首歌"。

接口可能随时被上游改掉。改掉时这五个工具会返回明确的中文原因，而不是静默失效。

## 输出设备（本机踩过的坑，务必看）

这台机器上装了三个**虚拟声卡**：`VB-Audio Virtual Cable`、`网易虚拟音频设备`、`WO Mic Device`。
如果 Windows 的默认播放设备落在其中任何一个，会出现最迷惑的故障：

> 音频渲染完全正常、`AudioContext` 报 `running`、音频时钟正常推进、所有测试全绿 —— **但一点声音都没有**。
> 因为样本被送进了一条没人听的虚拟通道。

所以插件默认 `sink: auto`：枚举输出设备、**跳过虚拟设备**、优先选真声卡。当前会选中
`扬声器 (Realtek High Definition Audio)`。

`music_status` 会一并返回实际使用的输出设备，所以"在放但没声"时一眼能看出是不是设备选错了。

配置项：

```yaml
sink: auto      # 默认：跳过虚拟声卡，自动选真设备
sink: default   # 交给 Windows 决定
sink: Realtek   # 按设备名片段指定
```

排查工具：

```bash
node scripts/list-devices.mjs        # 列出所有输出设备，标注 virtual / real
node scripts/tone-probe.mjs          # 在自动选中的设备上放 1.6 秒提示音
node scripts/tone-probe.mjs --all    # 逐个设备放音，用耳朵找出能听到的那个
node scripts/tone-probe.mjs --sink=Realtek
```

## 工具 schema 的两种方言（踩过的坑）

这个插件用**原生 JSON Schema** 注册工具，不是 `defineTool` DSL。两者写法不同，混用会炸：

```js
// defineTool DSL —— required 写在属性里
parameters: { mode: { type: 'string', required: true } }

// 原生 JSON Schema —— required 是顶层数组
parameters: { properties: { mode: { type: 'string' } }, required: ['mode'] }
```

开发时我把 DSL 的 `required: true` 抄进了原生 schema，结果：

> `invalid schema for function 'music_control': true is not of type 'array'`

**provider 会拒掉整个请求**，不是拒掉那一个工具调用 —— 所以整轮对话直接失败，
DSH 还会因此进入**安全模式**并禁用全部第三方插件。一个关键字就能造成停机，不是小瑕疵。

现在有三道防线：

- `scripts/lib/schema-check.mjs` —— 递归严格校验，逐节点检查 `required` 类型、`type` 合法性、
  `required` 是否指向已声明属性等
- `scripts/schema-check-test.mjs` —— 22 项单元测试，**把导致上述故障的那个 schema 当作反例**，
  证明校验器真的会拒绝它
- `scripts/registration-test.mjs` —— 用真实工具定义跑同一个校验器

`npm test` 会跑这四套（crypto + schema + registration + match），改 schema 前先跑一遍。

## 安装

```bash
# 1. 依赖（只有一个）
cd D:/deepseek/dsh-music-player && npm install

# 2. 接入 web profile：把包加进 dependencies 与 dsh.profile.bundles
#    （或在 profile 目录执行 dsh plugin --profile web add D:/deepseek/dsh-music-player）

# 3. 重启 dsh web 并刷新浏览器 —— profile 是 patchReload: startup，必须重启
```

挂载后用工具冒烟测试一下：

```bash
npm run test:registration   # 60 项：工具注册、schema 合法性、空闲状态行为
npm run test:match          # 10 项：歌名 + 歌手双重匹配
npm run smoke               # 静默全链路：搜索→解析→开音频设备→解码→循环/暂停状态机
npm run smoke:audible       # 同上，并真的放出约 3 秒声音
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖默认值：

```yaml
- id: dsh-music-player
  config:
    volume: 60          # 主音量百分比
    quality: auto       # auto | 128 | 320 | flac
    searchLimit: 8      # 参与匹配的候选数量
    timeoutMs: 20000    # 搜索/解析单次请求预算
    maxTrackMinutes: 12 # 超过这个时长的曲目拒绝播放
```

## 实现说明

```
lib/index.js   五个工具的定义与注册（纯 JSON Schema，不引入 dsh-tools 依赖）
lib/kugou.js   搜索、直链解析、候选排序
lib/player.js  AudioContext 单例、解码、播放状态机
```

几个刻意的设计决定：

- **歌名相关性是门槛，不是加分项。** 开发中踩过两次：歌手分高了会选中同歌手的**另一首歌**
  （搜「晴天 周杰伦」放成《简单爱》），歌手分低了会选中**别人的翻唱**。所以先按歌名相关性
  过滤掉"根本不是这首歌"的候选，再在剩下的里面用歌手、录音室版本、音质、时长排序。
- **同一时刻只有一个播放器。** 放新歌先拆掉旧的，两首歌不可能叠着响。
- **卸载即静音。** 用 `ctx.effect` 注册清理，profile 重载或重启时关闭音频设备，
  不会留下一个没人管的进程还在放歌。
- **只 inject `tools`。** `systemPrompt` 用 `ctx.get()` 兜着读：cordis 的 `inject` 是等待门，
  把一个本机没挂载的服务写进去会让整个插件静默失活 —— 丢一句提示语，远比丢掉播放能力可接受。
- **失败不抛异常，返回中文原因。** 搜不到、解析失败、超时都会变成一条可读的 `❌ ...`，
  模型转述给你，而不是把整轮对话打挂。

## License

MIT。音源来自酷狗公开接口，仅供个人学习研究，请支持正版。
