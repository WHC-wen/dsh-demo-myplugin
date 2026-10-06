# DSH 提示词优化插件（dsh-demo-myplugin）

运行于 **DeepSeek Harness** 的提示词优化插件：在聊天输入框工具行右端嵌入一个常驻星星图标，点击即可读取当前草稿，调用 **大模型润色** 或 **规则重写** 增强提示词，以悬浮层预览、一键替换原文（或取消），全程不打断输入流程。

本仓库是一个**正式的 Cordis 插件包（bundle）**：通过 `dsh.bundle.patch` 向组合层插入一行，宿主半区用 `webServer` 注册同源 HTTP 路由，客户端半区（Web 平台）注册输入框入口。安装进 profile 后随 DSH 启动自动加载，重启不丢失。

- **零依赖**：`dependencies` / `devDependencies` / `peerDependencies` 全为空，不需要 `npm install`，克隆即可构建与测试。
- **产物由源码生成**：`lib/` 是 `src/` 的构建输出（`npm run build`），`npm test` 会逐字节比对，手改产物无法存活。
- **四层独立验证**：`npm test`、`npm run guards`、`npm run verify`（打包件 / 真实组合层 / 真实 profile 加载器），GitHub Actions 在 Linux 与 Windows 上跑同一套。

## 📦 目录结构

```
dsh-demo-myplugin/
├── package.json                  # 元数据：dsh.bundle.patch、dsh.client.platform = web
├── cordis.patch.yml              # 组合层 insert 声明（id: prompt-opt）
├── lib/                          # 发布产物，由 scripts/build.mjs 生成（必须提交）
│   ├── index.js                  # 宿主半区：ESM，注册 POST /api/prompt-opt/optimize
│   └── client.js                 # 客户端半区：__ModuleLoader__ bundle（星星图标 + 悬浮层）
├── src/                          # 源码，唯一可手写的真源
│   ├── index.js                  # 宿主入口，只做 re-export
│   ├── host.js                   # 宿主半区：路由、请求校验、回退
│   ├── optimizer.js              # 智能优化：调用 llm 服务 + 超时守卫 + 输出清洗
│   ├── rules.js                  # 快速重写：纯函数规则引擎（中/英）
│   ├── client.js                 # 客户端半区：槽位注册与样式挂载
│   ├── view.js                   # 星星图标与悬浮面板（React）
│   ├── styles.js                 # 面板 CSS
│   └── endpoint.js               # 两个半区共享的唯一事实：路径与请求体
├── scripts/
│   ├── build.mjs                 # 生成 lib/；--check 用于防漂移
│   ├── ci-guards.mjs             # 打包规则守卫（依赖、身份、清单、产物新鲜度、路由一致）
│   ├── verify-pack.mjs           # 独立校验「打包后的 tgz」
│   ├── verify-dsh.mjs            # 用真实 dsh-client-modules 组合并取出启动行
│   └── verify-profile.mjs        # 用真实 dsh-app-boot 的 profile 加载器组合
├── tests/
│   ├── client-contract.test.mjs  # 打包件行为：注册、face、槽位、请求体、生命周期
│   └── host-contract.test.mjs    # 宿主行为：路由、405/413、规则引擎、模型回退
├── .github/workflows/ci.yml      # push/PR 时在 ubuntu + windows 上跑 build→test→guards→verify
├── README.md / README.en.md
└── LICENSE (MIT)
```

## ✨ 功能

- **双模式优化**
  - `智能优化`（auto）：用 `llm` 服务以当前会话模型润色；缺少服务、未选模型、流失败或超过 45s 超时都会自动回退规则引擎。
  - `快速重写`（rule）：内置规则引擎，零 API 成本、瞬时响应；中/英双语结构化重写（角色 / 任务 / 背景 / 约束提取 / 输出格式）。原文 ≤8 个字符或已结构化时原样返回，不硬套模板。
- **常驻入口 + 悬浮层**：注册在 `conversation.input.right` 槽位（输入框工具行右端、模型选择器左侧）；面板提供结果预览、来源标注（`已由大模型润色` / `已由规则引擎重写`）、`替换原文`（通过 `inputActions.setDraft` 原子写回草稿）、`取消`。
- **主题与视口自适应**：配色用 DSH 主题 token（`--dsw-alias-*`）；弹层 `max-height: min(420px, calc(100vh - 220px))`，矮窗口内部滚动。
- **状态反馈**：优化中转圈、空输入提示、引擎来源、失败原因。

## 🚀 安装

三种方式，任选一种。装好后 `dsh.profile.bundles` 会自动 reconcile，**重启 `dsh web` 生效**。

```sh
# 1) 从本目录直接安装（开发时最方便）
dsh plugin --profile web add .

# 2) 先打包再安装（路径含空格时必须用这种方式）
npm pack --pack-destination "$env:TEMP"
dsh plugin --profile web add "file:$env:TEMP/dsh-demo-myplugin-0.1.0.tgz"

# 3) 从 GitHub 安装（仓库已发布后）
dsh plugin --profile web add github:WHC-wen/dsh-demo-myplugin
```

验证组合层是否插入成功：

```sh
dsh --profile web --dump-config | Select-String -Context 0,2 'dsh-demo-myplugin'
# 应看到：
#   # == dsh-demo-myplugin
#   - id: prompt-opt
#     name: dsh-demo-myplugin
```

卸载：

```sh
dsh plugin --profile web remove dsh-demo-myplugin
```

> **路径含空格时**：`dsh plugin add` 底层是 `pnpm add`，`file:` 路径里的空格会被截断。先用 `npm pack` 生成 `.tgz`，再用 `file:<tgz 绝对路径>` 安装（上面第 2 种）。
>
> **相对路径按调用目录解析**：`dsh plugin add .` 里的 `.` 会按你执行命令时所在的目录重写，在别处执行时请写绝对路径。

## ⚙️ 配置说明

`package.json` 中与 DSH 相关的字段：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"], "external": [] }
}
```

- `dsh.bundle.patch`：声明这是一个 bundle 层。`dsh plugin add` 只看这一项决定是否把包加进 `dsh.profile.bundles`；没有它的依赖只会得到一条警告。
- `dsh.client.platform`：客户端半区面向 `web`。
- `dsh.client.inject`：模块图的依赖提示（平台包名）。这里写 `@deepseek-ai/dsh-client-runtime`，因为实现 `slots` 服务的正是它，且它已经是解析器预载包。
- `dsh.client.external`：留空。客户端 bundle 唯一 `require` 的是 `react`，而 React 属于 shell 基线（由平台种子提供），不产生模块图边。
- 无需任何环境变量或配置文件。

`cordis.patch.yml`：

```yaml
- insert:
    - id: prompt-opt
      name: dsh-demo-myplugin
```

`id` 是组合层里的插件标识，`name` 是要加载的包名——两者不同是正常的，也是本插件的既有约定。

## 🛠 工作原理

**宿主半区**（`lib/index.js`，ESM）：`name = "prompt-opt"`，`inject = ["webServer", "timer"]`；在 `ctx.effect` 内注册同源路由：

```
POST /api/prompt-opt/optimize   { text, mode } -> { ok, text, engine }
```

- 请求体上限 64 KiB，超出返回 413 并断开；非 POST 返回 405；空草稿返回 `ok: false` 与提示语。
- `智能优化` 用 `agentDefaultModel.currentSelection()` 选中的模型调 `llm.stream`，带 45s 超时守卫与输出清洗（去代码围栏）；任何失败都会记一条 warn 并回退规则引擎，用户看到的始终是 200。

**客户端半区**（`lib/client.js`，经典脚本）：手写 `window.__ModuleLoader__.load` bundle，模块表 id 等于包名；`inject = ['slots']`；经 `slots.inject('conversation.input.right')` 注册 `id: prompt-opt`、`order: 20` 的星星图标与悬浮层；点击后 `fetch('/api/prompt-opt/optimize')` 同源调用，`替换原文` 通过 `inputActions.setDraft` 写回草稿。

两半只通过 `src/endpoint.js` 共享同一个路径常量与请求体构造函数，宿主与浏览器不可能各写一份路径——`npm run guards` 会检查这一点。

> 与「动态 Cordis 插件」版的区别：动态版用 `harness.handle` + `host.call` 的包内 RPC，只在该次会话内有效；本 bundle 版改为 `webServer` 同源路由 + `fetch`，因此可随 profile 持久加载。两者不要同时启用（会在同一槽位重复注册入口）。

## 🧪 开发与验证

```sh
npm run build     # 由 src/ 生成 lib/（唯一允许写 lib/ 的东西）
npm test          # build --check + 18 个行为测试
npm run guards    # 打包规则守卫（依赖、身份、清单、产物新鲜度、路由一致）
npm run verify    # guards + 打包件校验 + 真实组合层 + 真实 profile 加载器
```

四层各自的边界，以及它们分别能证明什么：

| 层 | 命令 | 证明的事 |
| --- | --- | --- |
| 行为测试 | `npm test` | bundle 注册形态、face、槽位注册、请求体、路由行为、超时回退、413/405 |
| 打包守卫 | `npm run guards` | 零依赖、包名 = bundle id = patch 的 `name`、patch 仍声明层 id `prompt-opt`、清单承诺的文件都存在、`lib/` 不落后于 `src/`、两半路径一致 |
| 打包件校验 | `verify-pack.mjs` | 从 `npm pack` 的 tgz 解包后，用桩加载器跑 bundle、用真实 ESM 导入宿主并打一次请求 |
| 真实组合 | `verify-dsh.mjs` | 用 DSH 自己的 `ClientModuleRegistry` 组合，取出 `/plugins/<name>/client.js?rev=…` 启动行，并确认服务端返回的字节与打包件逐字节相同 |
| 真实 profile | `verify-profile.mjs` | 用 `@deepseek-ai/dsh-app-boot` 的 `loadProfile` + `composeEntries` 组合出 `id: prompt-opt` 行（在临时 DSH_HOME 中，不动你的真实 profile） |

后两者在没有安装 DSH 的机器上会打印 SKIP 并以 0 退出，所以 CI 与陌生环境都不会假失败。

**改动流程**：改 `src/` → `npm run build` → `npm test` → `npm run verify` → 提交推送。`lib/` 是产物但**必须提交**：从 GitHub 安装时不会运行构建。

## 🔄 CI 与发布

`.github/workflows/ci.yml` 在 push 到 `main` 与每个 PR 上运行，矩阵为 `ubuntu-latest` + `windows-latest`（Node 20）：`npm run build` → `npm test` → `npm run guards` → `npm run verify`。没有安装步骤（零依赖），Windows 那一份会验证 `.gitattributes` 的 LF 约束在检出后依然成立——测试里有逐字节比对，CRLF 会立刻失败。

推送到自己的仓库：

```sh
git remote -v                      # origin 应指向你的仓库
git add -A
git commit -m "…"
git push -u origin main
```

> **若仓库里已经有旧的提交历史**：本包是一段重新整理过的提交历史（3 个提交：正式包、守卫补强、上传说明），与早期的动态插件提交没有祖先关系，因此 `git push` 会被拒绝。两种做法：把仓库清空/新建后再推（`git push -u origin main` 直接成功），或在旧仓库上强制覆盖：`git push -u origin main --force`。想保留旧历史时，用 `git pull --allow-unrelated-histories origin main` 先合并再推。

## ⚠️ 注意事项与已知边界

- Harness 插件是**受信任的 Host 代码**，运行在 `dsh` 进程权限下；审查依赖与安装脚本，建议先用一次性 profile 验证。
- 大模型润色会消耗你配置的模型 API 额度；`快速重写` 不产生任何调用。
- 缺少 `llm` / `agentDefaultModel` 服务时自动退化到规则引擎，功能不中断。
- 规则引擎对 ≤8 字或已结构化的原文原样返回，这是设计而非缺陷（避免把小提示词撑成模板）。
- 面板挂载在 `conversation.input.right` 槽位，向上溢出输入框；该槽位的文档预算是一行高，输入区卡片没有 `overflow: hidden`，所以不会被裁切，但极矮窗口下会与上方内容重叠。
- `src/optimizer.js` 的 `SYSTEM_PROMPT` 是**重建**的：原发布产物里 `llmRewrite` 引用了一个从未声明的 `SYSTEM_PROMPT`（运行时 `ReferenceError`），本包补上了这段中文系统提示词，措辞按插件意图重写，不是原文找回。若你手上有原句，替换该常量即可。

## 📄 许可证

[MIT](./LICENSE)
