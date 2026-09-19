# dsh-music-player

DSH 的音乐播放插件。注册几个工具，让模型按歌名搜索并在本机出声。

自包含：不依赖 ffplay / mpv / 外部客户端，随包带取流引擎，进程内解码。

## 特性

- 自包含取流：随包引擎 + 公开 CDN 兜底，无外部播放器依赖
- 走酷狗概念版（lite）客户端协议，与正规第三方客户端同路径，非私有接口破解
- 扫码登录获取原版 / VIP，设备身份本地持久化
- 进程内 AudioContext 播放：无缝单曲循环、采样级暂停 / 继续
- 自动跳过试听片段、Live / 翻唱，优先完整录音室版本
- 自动识别并避开虚拟音频设备（VB-Cable、VoiceMeeter 等）
- 全部工具 schema 经严格校验，坏 schema 不会拖垮整个对话轮次

## 要求

- Node.js >= 22
- Windows x64

## 安装

```bash
git clone https://github.com/PRTS168/dsh-music-player.git
cd dsh-music-player
npm install
dsh plugin add ./dsh-music-player
```

重启 DSH。

## 工具

| 工具 | 入参 | 作用 |
|---|---|---|
| `play_music` | `query`, `loop?`, `quality?` | 搜索并播放，`loop=true` 单曲循环 |
| `music_control` | `action`, `volume?`, `loop?` | `pause` `resume` `toggle` `stop` `volume` `loop` |
| `music_status` | — | 当前曲目、音质、进度、音量、输出设备 |
| `search_music` | `query`, `limit?` | 列出候选供选择 |
| `music_login` | `action` | `qr_start` `qr_poll` `status` `logout` |

自然语言即可：“放首晴天”“暂停”“声音小一点”“单曲循环”。

## 登录

原版 / VIP 曲目未登录仅试听片段。调用 `music_login` `qr_start`，用酷狗 App 扫码确认，再 `qr_poll`。会话写入 `.session.json`（已 gitignore），登录一次长期有效。

命令行等价方式：

```bash
npm run login
```

未登录也能搜索和播放免费 / 低音质曲目，原版会自动回退到可播版本。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dsh-music-player
  config:
    volume: 60            # 0-100
    quality: auto         # auto | 128 | 320 | flac
    searchLimit: 8
    timeoutMs: 20000
    maxTrackMinutes: 12
    sink: auto            # auto | default | 设备名片段 | deviceId
```

## 结构

```
lib/index.js     工具注册
lib/kugou.js     搜索、取流、候选排序
lib/engine.js    随包引擎：privilege 预热后取直链
lib/player.js    AudioContext 播放状态机
lib/login.js     扫码登录
lib/session.js   本地会话
lib/sink.js      输出设备选择
```

取流顺序：随包引擎先尝试（`/privilege/lite` 授权预热 → `/song/url` 取直链），不可用或被风控时回退公开 CDN。

## 测试

```bash
npm test        # 加密 / schema / 匹配 / 注册 回归
npm run smoke   # 全链路静默测试
```

## 致谢

- [MoeKoe Music](https://github.com/MoeKoeMusic/MoeKoeMusic) —— 随包引擎与概念版协议
- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（MIT）—— 设备注册、签名、加密算法
- [node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api) —— 进程内音频解码与播放

## 免责

仅供个人学习研究。音源来自酷狗公开接口，版权归原方所有。`bin/app_win.exe` 为第三方二进制，版权归原作者。请支持正版。

## License

MIT
