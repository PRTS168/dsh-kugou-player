# dsh-music-player

DSH 的音乐播放插件。给模型注册几个工具，按歌名搜索并播放网络音乐。

不需要 ffplay / mpv，也不需要另装一个音乐客户端。插件自己带取流引擎，自己解码，自己出声。

## 安装

要求 Node.js >= 22、Windows x64。

```bash
git clone <your-repo>
cd dsh-music-player
npm install
```

把它加到你的 DSH profile：

```bash
dsh plugin add ./dsh-music-player
```

重启 DSH 后生效。

## 工具

| 工具 | 说明 |
|---|---|
| `play_music` | 按歌名（可带歌手）搜索并播放，`loop: true` 单曲循环 |
| `music_control` | pause / resume / toggle / stop / volume / loop |
| `music_status` | 当前曲目、歌手、音质、进度、音量、循环、输出设备 |
| `search_music` | 列出候选，供模型挑版本 |
| `music_login` | 扫码登录酷狗账号（qr_start / qr_poll / status / logout） |

直接用自然语言说就行，比如"放首晴天"、"暂停"、"声音小点"、"单曲循环"。

## 登录

原版 / VIP 曲目未登录只能试听片段。需要时调 `music_login` 的 `qr_start`，用酷狗 App 扫二维码确认，再 `qr_poll` 拿结果。会话存在 `.session.json`（已 gitignore），登录一次长期有效。

没登录也能搜索和播放免费 / 低音质曲目，只是原版会回退到可播的版本。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-music-player
  config:
    volume: 60
    quality: auto       # auto | 128 | 320 | flac
    searchLimit: 8
    timeoutMs: 20000
    maxTrackMinutes: 12
```

## 实现

```
lib/index.js    工具定义与注册
lib/kugou.js    搜索、取流、候选排序
lib/engine.js   自包含取流引擎：privilege 预热后取直链
lib/player.js   AudioContext 播放状态机
lib/login.js    扫码登录
lib/session.js  本地会话
lib/sink.js      输出设备选择
```

取流走随包自带的本地引擎，先 `/privilege/lite` 再 `/song/url`；引擎不可用或被风控时回退到公开免费源。

## 测试

```bash
npm test          # 单元与回归
npm run smoke     # 全链路静默测试
```

## 致谢

- [MoeKoe Music](https://github.com/MoeKoeMusic/MoeKoeMusic) —— 本地取流引擎与概念版协议的逆向来自它。
- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（MIT）—— 登录设备注册、签名、加密算法移植自此。
- [node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api) —— 音频解码与播放。

## 免责

仅供个人学习研究，音源来自酷狗公开接口，版权归原方所有。`bin/app_win.exe` 为第三方二进制，版权归其原作者，下载即代表你遵守酷狗用户协议。请支持正版。

## License

MIT
