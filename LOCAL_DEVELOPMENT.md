# Charlie-MausBot 本地开发指南

## 安装依赖

在 `Charlie-MausBot` 仓库根目录运行。项目要求 Node.js 24 或更高版本，仓库指定 pnpm 10.33.0。

```bash
pnpm install --frozen-lockfile
```

以下命令都在仓库根目录执行。标注不同终端的命令需要同时运行。

## 连接 Railway 生产后端

在仓库根目录的 `.env` 中设置生产服务的 HTTPS 地址。`.env` 已被 Git 忽略。

```dotenv
OMB_RAILWAY_ORIGIN=https://openmausbot-server-production.up.railway.app
```

### Web 开发

```bash
pnpm dev:railway
```

打开 [http://127.0.0.1:5200](http://127.0.0.1:5200)。React 在本机运行，修改 `src/` 会热更新，Vite 把 API 请求转发到 Railway。这个模式只需启动 Vite。

### macOS Electron 源码开发

保留上面的 `pnpm dev:railway`，另开一个终端运行：

```bash
ELECTRON_START_URL=http://127.0.0.1:5200 pnpm dev:desktop
```

Electron 加载本地 React 页面，API 通过同一个 Vite 代理连接 Railway。修改 `electron/` 下的主进程或 preload 代码后，重启 Electron 进程。首次启动可能需要下载 Cloudflare Tunnel 组件。

本地浏览器和 Electron 如果出现登录页，各自使用生产服务生成的新配对码。在 Railway 容器里运行 `openmausbot pair` 可生成配对码。发消息、运行 Bot 或修改设置会作用于生产数据。

### 直接使用已部署版本

- **浏览器**直接打开 [Railway 生产站点](https://openmausbot-server-production.up.railway.app)。
- **已安装的 macOS App**在侧栏选择 **＋ → Connect to a server**，粘贴 Railway 生成的配对链接，或分别填写服务地址和配对码。

这两种方式都使用 Railway 已部署的界面，无需启动本地开发进程。

## 使用本地后端

### Web 开发

```bash
# 终端 1
OMB_DATA_DIR="$HOME/.openmausbot-dev" pnpm dev:server
```

```bash
# 终端 2
pnpm dev
```

打开 [http://127.0.0.1:5199](http://127.0.0.1:5199)。后端默认监听 `8799`，开发数据保存到 `~/.openmausbot-dev`。要实际与 Bot 对话，需要在本机安装并登录 Codex、Claude 等受支持的引擎。

### macOS Electron 源码开发

保留上面两个进程，另开一个终端运行：

```bash
OMB_DATA_DIR="$HOME/.openmausbot-dev" pnpm dev:desktop
```

Electron 默认加载 `http://127.0.0.1:5199`。如果已安装的 MausBot 占用了 `8799`，先退出它，再启动本地开发后端。

## 端口和停止方式

- `OMB_UI_PORT` 控制本地 Vite 端口。普通模式默认 `5199`，Railway 模式默认 `5200`。修改后，浏览器访问地址和 `ELECTRON_START_URL` 要填同一个端口。
- `OMB_PORT` 控制本地 Node 后端的端口。普通 Web 模式换端口时，后端和 Vite 两个终端都要设置同一个 `OMB_PORT`。Railway 模式通过 `OMB_RAILWAY_ORIGIN` 选择 API 目标。
- 在对应终端按 `Ctrl+C` 停止 Vite、Electron 或本地后端。
