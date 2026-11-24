### DasPixel58 在 Windows 上启动

安装 Git 和 Node.js 后，双击本目录的 `stat.bat`。首次启动会从 DasPixel 的 Git 历史提取原版 Matchmaker 并安装锁定依赖。之后可以修改 `.daspixel-runtime/config.json`，或运行 `stat.bat --HttpPort=8080` 临时指定端口。已有安装可通过环境变量 `DASPIXEL_MATCHMAKER_DIR` 指向含有 `matchmaker.js` 的目录。

### Where is matchmaker?
The matchmaker has been removed. It was not a good refernce for how to handle Pixel Streaming at scale and was adding to maintenance work, so we made the decision to remove it and discontinue its support.

### What if I still need Matchmaker?
You can still obtain it from older revisions of this repo. It is removed for UE5.5, but any previous version of the Infrastructure repo will still have it, latest one being [UE 5.4 matchmaker](https://github.com/EpicGames/PixelStreamingInfrastructure/tree/UE5.4/Matchmaker).
