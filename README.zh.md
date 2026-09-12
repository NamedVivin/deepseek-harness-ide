# DeepSeek Harness IDE

[English](README.md) | 中文

![DeepSeek Harness 插件架构与集成 Workspace IDE](.github/assets/readme/deepseek-harness-hero.png)

DeepSeek Harness IDE 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立维护衍生版。本仓库跟随上游更新，并加入集成式 Workspace IDE，将 agent（智能体）会话、仓库浏览和文件编辑集中在同一个应用中，同时保留上游的 MIT 许可证与归属信息。

上游 DeepSeek Harness 由 [DeepSeek AI](https://deepseek.com) 开发。它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

本社区衍生版目前仅提供源码形式的 _开发者预览_，并在快速迭代。**未来将出现破坏兼容性的变更。**

## 本仓库新增的功能

| 功能 | 本仓库中的行为 |
|---|---|
| Workspace IDE | 空间允许时，文件树和多标签 CodeMirror 编辑器与 agent 会话使用可调节分栏；宽度不超过 900px 时，编辑器占用导航栏旁的内容区。 |
| agent 到文件的跳转 | 工具卡片和产出文件结果中的受支持文件链接会打开经验证的文本文件；可选行位置会聚焦到指定行。 |
| Markdown 预览 | Markdown 标签页通过现有的安全渲染器预览当前未保存 buffer。 |
| 防冲突保存 | 采用带版本校验的比较并交换方式保存；发生并发修改时保留本地 buffer，并显示最新磁盘内容供你明确选择恢复方式，不提供无条件覆盖操作。 |

![DeepSeek Harness 集成 IDE，包含 agent 会话、Workspace 文件树和 CodeMirror 编辑器](.github/assets/readme/ide-workspace.png)

首个版本只能编辑已有的普通 UTF-8 文件，不支持创建、重命名、移动、删除、监视或全局搜索文件。未保存 buffer 是临时状态，刷新页面或进程崩溃后可能丢失。完整功能范围见 [IDE 行为与限制](packages/client/ui-ide/README.zh.md)。

<a id="run"></a><a id="run-from-source"></a>

## 从源码运行本 IDE

安装 Node.js `^22.19.0` 或 `>=24.0.0` 并启用 Corepack，然后构建本仓库并启动其 `ide` profile：

```sh
git clone https://github.com/NamedVivin/deepseek-harness-ide.git
cd deepseek-harness-ide
corepack enable
pnpm install
pnpm run build
pnpm dsh --profile ide
```

已发布的 `@deepseek-ai/dsh` npm 包属于上游项目，不包含本仓库的 IDE 改动。启动后，请按照 [Web UI 指南](docs/user/guide/index.zh.md)配置受支持的模型与凭据。

### 桌面应用打包

仓库包含 Electron 应用源码，应用不监听 TCP。目前未发布签名安装包，本地未签名产物仍只用于开发。请按照[桌面应用文档](apps/desktop/README.zh.md)在本地构建。

## 社区与支持

- IDE 衍生版的 bug 与建议请提交到本仓库的 [GitHub Issues](https://github.com/NamedVivin/deepseek-harness-ide/issues)。
- 官方 DeepSeek Harness 发行版的问题请前往[上游 Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
- 欢迎加入<a href="https://discord.gg/Ycq5dCaS4">上游 DeepSeek Harness Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
