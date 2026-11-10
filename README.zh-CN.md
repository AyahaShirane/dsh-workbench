# DSH Workbench 0.3.1

这是一个本地 Cordis 插件，为原生 DeepSeek Harness 网页客户端提供任务工作台。它包含原生 Superagent 面板和独立的 /workbench 仪表板，用于查看任务记录、补充输入、报告和已登记产物。

## 环境与安装

需要 Node.js 24.9 或更高版本，以及兼容的 DSH 0.2.2-rc.1 Profile。

1. 在 config/projects.json 中配置项目根目录。
2. 运行 `npm ci`，然后运行 `npm run build:client` 和 `npm start` 启动专用本地 Host。首次启动时，启动器会自动初始化专用 DSH Profile 并启用此插件。
3. 打开原生侧边栏入口或 /workbench。独立仪表板使用本地操作令牌；原生 DSH 认证保持独立。

独立仪表板首次打开时根据浏览器语言选择英文或简体中文，并提供语言选择器。原生面板遵循 DSH 语言设置。任务内容、报告、产物名称、项目名称和标识符按原样显示。

可选的入站 Webhook 配置应放在本地 config/ingress.json，该文件已从 Git 忽略。运行数据和密钥保存在工作副本的 .dsh-home/ 与 .workbench/ 下，请勿发布这些文件。

## 功能与边界

仪表板支持任务搜索与状态筛选、项目视图、持久化补充草稿、停止确认、公开工作记录，以及已验证产物的预览和下载。任务创建时固定项目目录绑定。项目设置页为只读；请在 config/projects.json 中显式登记根目录和唯一 ID，再重启 Host。界面不会扫描磁盘。

操作员认证在本地完成，与模型凭据分开。任务检查器会显示已知模型路由，但不会声称凭据有效或推理已验证。模型不可用时仍会保留输入。实际的模型驱动自主推理和团队执行尚未验证。

界面仅显示有界公开文本、工具名称、结构化报告和操作员输入，不显示推理、系统上下文或原始工具参数。原生工具权限由 DSH Profile 管理。项目绑定或写入范围提示并非操作系统沙箱。产物预览仅支持不超过 64 KiB 的纯文本文件。即时消息集成已暂停；不会自动发送外部消息。

## 本地检查

- npm test 运行单元、原生、Profile 和安全回归测试。
- npm run check 检查 JavaScript 语法。
- npm run build:client 构建原生客户端 bundle。
- npm run test:host 运行本地 Host 端到端套件，可能需要 Host socket 权限。
- npm run test:superagent:host 运行 Superagent Host 套件。
- 如果 Host 测试需要使用非默认的 Chrome 或 Chromium 可执行文件，请设置 `CHROME_BIN`。

## 署名与许可

MIT，AyahaShirane。本项目集成 DeepSeek Harness 并保留其上游声明。其任务/outbox 方案参考了单独许可的 DSH Superagent 研究原型，详见 NOTICE。依赖项各自遵循其许可。
