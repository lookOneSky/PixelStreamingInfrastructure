# DasPixel58 信令服务

本分支将 DasPixel 的 UE 进程管理、播放器配置和 Windows 启动入口移植到了 UE5.8 的 Wilbur。信令入口在 `src/index.ts`，会话与 UE 子进程的生命周期在 `src/ueProgram.ts`。

## 本地启动

使用仓库根目录 `NODE_VERSION` 指定的 Node.js 版本，在根目录运行以下命令。

```bat
npm ci
start.bat
```

首次启动会构建 Common、Signalling 和 Wilbur。修改信令代码后可用 `npm run build:signalling` 重新构建。根目录和本目录的 `start.bat` 均接受 Wilbur 参数。配置默认从本目录的 `config.json` 读取，命令行参数优先。

| 连接方 | 默认地址或端口 |
| --- | --- |
| 浏览器播放器 | `ws://127.0.0.1:6888` |
| UE 推流实例 | `ws://127.0.0.1:8888` |
| SFU | `8889` |

默认只提供信令，玩家端口绑定本地回环地址。Vue 示例可单独启动，步骤见 [Vue 示例](../Frontend/impvue/README.md)。如需让 Wilbur 托管参考播放器，先在仓库根目录运行 `npm run build:all:cjs`，再运行 `start.bat --serve`。远程浏览器直连时，将 `Localhost` 设为 `false`。

## UE 进程与订阅

| 配置项 | 随分支提供的设置 |
| --- | --- |
| `UEProgram` | 默认空。填入本机已打包 UE 可执行文件的绝对路径，可在浏览器连接时自动启动。 |
| `MultiIProgress` | `false` 让所有浏览器共享实例，最后一个浏览器断开时回收。设为 `true` 则每个玩家独占实例，断开后单独回收。 |
| `ResX`、`ResY` | `1920 × 1080`。 |
| `PixelStreamingEncoderCodec` | `VP9`。 |
| `SimulcastParameters` | 旧版插件的单层缩放参数，默认为 `1`。Pixel Streaming 2 使用单层编码。 |

多人独占模式下，自动启动的 UE 使用 `PlayerStreamer-<playerId>-Session`。服务器按归属筛选播放器可见、可订阅的流。手动启动 UE 时留空 `UEProgram`，独占模式会分配空闲的流。服务器退出时清理它启动的 UE 进程。

## Matchmaker

需要沿用旧版 Matchmaker 时，先启动 [Matchmaker 快捷入口](../Matchmaker/README.md)，再运行 `start.bat --UseMatchmaker --PublicIp <玩家可访问的主机名>`。Wilbur 默认向 `127.0.0.1:9999` 登记，可通过 `MatchmakerAddress` 和 `MatchmakerPort` 修改。登记使用玩家 HTTP 端口，启用 HTTPS 时使用 `https_port`。

Matchmaker 会将玩家重定向到已有 UE 流送端连接且没有浏览器玩家的服务器。通过 Matchmaker 打开播放器页面时，请预先启动 UE，并在 Wilbur 启用 `--serve` 或配置反向代理提供页面。

## 打包

在本目录运行 `pack.bat`，可将 `app.cjs`、REST API 描述和默认配置输出到仓库旁的 `Pack\SignallingWebServer`。已有输出配置会保留。若已生成 `www`，脚本也会复制播放器页面。可用 `pack.bat "目标目录"` 指定另一处输出。在输出目录运行 `node app.cjs` 启动。
