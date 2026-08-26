# DeepSeek Harness

[English](README.md) | 中文

![DeepSeek Harness 插件架构与集成 Workspace IDE](.github/assets/readme/deepseek-harness-hero.png)

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源、插件化 agent harness（智能体框架）。内置 Workspace IDE 把 agent 会话、仓库浏览和文件编辑集中在同一个应用中。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 集成 IDE

你可以从 Workspace 文件树打开文件，也可以直接跳转到 agent 返回的受支持文件位置。在 CodeMirror 的多标签页工作区中使用常见语言的语法高亮编辑已有普通 UTF-8 文件，并直接预览当前未保存 buffer 中的 Markdown。宽屏通过可拖动分隔条并排显示会话与 IDE；窄屏则由 IDE 占用内容区。

![DeepSeek Harness 集成 IDE，包含 agent 会话、Workspace 文件树和 CodeMirror 编辑器](.github/assets/readme/ide-workspace.png)

保存操作会校验版本。如果文件在磁盘上发生变化，IDE 会同时保留你的本地 buffer 和最新磁盘内容，由你选择恢复方式，而不会静默覆盖任一版本。确切功能范围见 [IDE 行为与限制](packages/client/ui-ide/README.zh.md)。

从源码 checkout 使用时，请先构建一次，再启动 IDE：

```sh
pnpm run build
pnpm dsh --profile ide
```

Electron 安装应用内置 Node.js 运行时且不监听 TCP。签名安装包尚未公开发布；本地未签名安装包仅用于开发。详见[桌面应用文档](apps/desktop/README.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
