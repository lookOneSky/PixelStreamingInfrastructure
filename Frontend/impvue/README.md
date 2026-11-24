# UE 5.8 像素流送 Vue 示例

在仓库根目录安装依赖并生成示例使用的本地库。

```sh
npm ci
npm run build:esm -w Common
npm run build:esm -w Frontend/library
npm run build:esm -w Frontend/ui-library
```

启动信令服务后，在示例目录运行开发服务器。

```sh
cd Frontend/impvue
npm ci
npm run dev
```

打开 `http://localhost:3000`。HTTP 页面默认连接同一主机的玩家端口 `6888`，HTTPS 页面默认使用同源 WSS。可用 `?ss=ws://localhost:其他端口` 指定同主机的其他玩家端口。数据通道就绪后，“发送给 UE”会通过 UIInteraction 将输入内容发送给 UE。运行 `npm run build` 可生成静态页面到 `dist/`。
