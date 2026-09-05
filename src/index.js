/**
 * dsh-plugin-prompt-optimizer —— 插件入口。
 *
 * 导出宿主与客户端两个半区插件。在 DSH 动态 Cordis 运行器中使用时：
 *   cordis_define({ ... }, { host: hostPlugin, client: clientPlugin })
 * （DSH 的运行器会为每个半区注入所需的全局：宿主注入 harness/console，
 *   客户端注入 React/host/styles。）
 *
 * 说明：这两个文件是已验证可运行的动态 Cordis 插件源码，可作为
 * 扩展到独立 Cordis 插件包的基础。
 */
import { hostPlugin } from './host.js';
import { clientPlugin } from './client.js';

export { hostPlugin, clientPlugin };

export const plugin = { host: hostPlugin, client: clientPlugin };

export default plugin;
