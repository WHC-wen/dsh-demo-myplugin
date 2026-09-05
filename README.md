# DSH 提示词优化插件

**dsh-plugin-prompt-optimizer** 是一个运行于 **DeepSeek Harness** 网页端的提示词优化插件。它在聊天输入框的角落嵌入一个常驻的星星图标，点击即可读取当前输入，调用 **大模型润色** 或 **规则重写** 对提示词进行增强，并以悬浮层预览、一键替换原文（或取消），全程不打断你的输入流程。

> 本项目是已验证可运行的 **动态 Cordis 插件** 源码（宿主 + 客户端两个半区），
> 可作为扩展到独立 Cordis 插件包的基础。

## ✨ 功能

- **常驻入口图标**：注册在 `conversation.input.right` 槽位（输入框工具行右端、模型选择器左侧），星星描边图标，随主题明暗自动适配。
- **两种优化模式**：
  - `智能优化`（auto）— 调用 `ctx.get('llm').stream` 用当前会话模型润色；失败或超时(45s)自动回退到内置规则引擎。
  - `快速重写`（rule）— 内置规则引擎，零 API 成本、瞬时响应；中/英双语结构化重写（角色 / 任务 / 背景 / 约束提取 / 输出格式）。
- **悬浮层交互**：按钮上方弹出面板，提供结果预览、来源标注、`替换原文`（`props.inputActions.setDraft` 原子写回，不打断输入流）、`取消`/关`×`。
- **自适应视口**：弹层 flex 列布局 + `max-height: min(420px, calc(100vh - 220px))`，矮窗口内容内部滚动、不溢出。
- **状态反馈**：优化中转圈、空输入框提示、引擎来源（大模型/规则）、失败错误提示。

## 📦 目录结构

```
dsh-plugin-prompt-optimizer/
├── package.json          # npm 元数据
├── README.md             # 本文件
├── LICENSE               # MIT 许可证
├── .gitignore
└── src/
    ├── index.js          # 插件入口（导出 hostPlugin / clientPlugin）
    ├── host.js           # 宿主半区：规则引擎 + llm 润色 + prompt-opt:optimize 处理器
    └── client.js         # 客户端半区：入口图标 + 悬浮层 + 槽位注册
```

## 🚀 安装与使用

### 作为动态 Cordis 插件加载（当前推荐）

在 DeepSeek Harness 会话中，用 `cordis_define` 定义插件并把两个半区代码粘贴进去，再 `cordis_run` 激活：

```js
// host: 取 src/host.js 中的 hostPlugin 函数体
// client: 取 src/client.js 中的 clientPlugin 函数体
```

激活后，会话页刷新会在输入框角落出现星星图标。点击图标即可优化当前输入。

> ⚠️ 动态插件不持久：DSH 重启或页面刷新后，需要重新 `cordis_run` 才会重新装载（同包无需再次授权）。

### 改为正式 Cordis 插件包

如需随 DSH 常驻或对外分发，把 `src/` 整理为独立的 Cordis 插件（`cordis.yml` / 插件 manifest 形式），按 [DeepSeek Harness 官方插件开发手册](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/en/plugin-development/first-plugin.md) 打包为 npm 包或 tarball 安装。

## 🛠 工作原理

- **宿主半区**（`src/host.js`）注册 `prompt-opt:optimize` 方法：默认调用 `agentDefaultModel.currentSelection()` 得到的模型路由做润色，超时/失败回退到确定性规则引擎；返回 `{ ok, text, engine }`。
- **客户端半区**（`src/client.js`）在 `conversation.input.right` 注册入口，点击时读取 `props.input.draft`，经 `host.call` 调用宿主，结果以 CSS 锚定的悬浮层展示，`替换原文` 通过 `inputActions.setDraft` 写回。
- 配色统一使用 DSH 主题 token（`--dsw-alias-*`），明暗主题自动适配。

## ⚠️ 注意事项

- 插件是**受信任的 Host 代码**，运行在 `dsh` 进程权限下；接管外部依赖/安装脚本前请先审查。
- 大模型润色消耗你配置的模型 API 额度；`快速重写` 模式则不产生任何调用。
- `llm` / `agentDefaultModel` 服务缺失时自动退化到规则引擎，功能不中断。

## 📄 许可证

[MIT](./LICENSE)
