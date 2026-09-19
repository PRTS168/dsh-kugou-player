# dsh-music-player

```
 track   晴天 — 周杰伦
 quality flac · 320 · 128
 engine  lite (concept client)
 cdn     direct → fallback
 state   playing  01:23 / 04:29
```

DSH 的音乐播放插件。注册几个工具，让模型按歌名搜索并在本机出声。自包含：不依赖 ffplay / mpv / 外部客户端。

![release](https://img.shields.io/badge/release-v0.1.0-2ea44f) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A522-gray) ![platform](https://img.shields.io/badge/platform-windows%20x64-gray)

[是什么](#是什么) · [60 秒上手](#60-秒上手) · [工具](#工具) · [登录](#登录) · [配置](#配置) · [结构](#结构) · [致谢](#致谢)

---

## 是什么

把酷狗的搜索与取流接成 DSH 的一组工具。从一句“放首晴天”到扬声器出声，全程不经过外部播放器：

```
you → play_music → kugou search → lite engine → cdn → node-web-audio-api → speakers
```

- 走酷狗概念版（lite）客户端协议，与正规第三方客户端同路径，非私有接口破解
- 随包引擎负责原版 / VIP；不可用或被风控时回退公开 CDN
- 进程内解码，无缝单曲循环、采样级暂停 / 继续
- 自动跳过试听片段与翻唱，优先完整录音室版本
- 自动识别并避开虚拟音频设备（VB-Cable、VoiceMeeter 等）

## 60 秒上手

```bash
git clone https://github.com/PRTS168/dsh-music-player.git
cd dsh-music-player
npm install
dsh plugin add ./dsh-music-player
```

重启 DSH，然后说“放首晴天”。原版需要登录：调 `music_login` `qr_start` 扫码。

## 工具

| 工具 | 入参 | 作用 |
|---|---|---|
| `play_music` | `query`, `loop?`, `quality?` | 搜索并播放，`loop=true` 单曲循环 |
| `music_control` | `action`, `volume?`, `loop?` | `pause` `resume` `toggle` `stop` `volume` `loop` |
| `music_status` | — | 当前曲目、音质、进度、音量、输出设备 |
| `search_music` | `query`, `limit?` | 列出候选供选择 |
| `music_login` | `action` | `qr_start` `qr_poll` `status` `logout` |

## 登录

未登录只能试听 60 秒。调 `qr_start` 拿二维码，用酷狗 App 扫，再 `qr_poll`。会话写入 `.session.json`（已 gitignore），登录一次长期有效。

命令行等价：

```bash
npm run login
```

## 配置

在 `cordis.patch.yml` 覆盖：

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
lib/index.js    工具注册
lib/kugou.js    搜索、取流、候选排序
lib/engine.js   随包引擎：privilege 预热后取直链
lib/player.js   AudioContext 播放状态机
lib/login.js    扫码登录
lib/session.js  本地会话
lib/sink.js     输出设备选择
```

测试：

```bash
npm test        # 加密 / schema / 匹配 / 注册 回归
npm run smoke   # 全链路静默测试
```

## 致谢

- [MoeKoe Music](https://github.com/MoeKoeMusic/MoeKoeMusic) —— 随包引擎与概念版协议
- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（MIT）—— 设备注册、签名、加密算法
- [node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api) —— 进程内音频解码与播放

仅供个人学习研究，音源版权归原方所有，`bin/app_win.exe` 为第三方二进制。请支持正版。MIT。
