# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：四栏 AppFrame（`sidebar | conversation | details | editor`）加 `ctx.layout` 面板服务。它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details`、根作用域的 `shell.editor` 以及可叠加的 `shell.overlay`。稳定的 `data-shell-frame`、`data-shell-panel` 和 `data-resize-handle` 属性分别标识框架、轨道与边界。关闭的侧边栏仍保留 56px 控制栏；关闭的详情栏和编辑器轨道以零宽度保持挂载并设为 inert。

让步求解器会先收缩详情栏，再收缩编辑器，并在把会话区压到常规 640px 下限以下之前，将详情栏的渲染宽度派生为零。只有编辑器的分栏可以使用 400px 会话区下限。编辑器打开时，在 900px 及以下会独占内容区；当连 56px 控制栏也无法留下可调整的分栏范围时同样会独占。如果配置的导航栏宽度放不下，但控制栏可以放下，AppFrame 会派生控制栏并保留分栏；窗口变宽不会把分栏切换成独占模式。控制栏的展开操作会显示存储的侧边栏宽度，并让编辑器独占剩余区域；收起后返回派生控制栏，且不重写侧边栏或编辑器偏好。更宽的窗口会恢复存储的偏好。编辑器分隔条支持指针捕获以及 `ArrowLeft`、`ArrowRight`、`Home` 和 `End`；其 ARIA 范围与指针缩放共用求解器可实际达到的范围。

AppFrame 始终挂载会话区、详情栏和编辑器占用方，包括尚无 Session 的状态。布局 store 是瞬时状态：侧边栏以默认宽度启动，两个右侧轨道保持关闭，且该 store 从不读写 `localStorage`。编辑器在同一个 store 实例内会跨关闭和重新打开保留最近一次打开宽度。`ctx.layout.editorOpen` 是同一个根 store 的可观察投影，因此页头控件与停靠编辑器不会出现状态分歧。选择不同的非 blank Session 会在绘制前关闭详情栏，但不会关闭根作用域编辑器。

会话区和详情栏的 owner share 为空。侧边栏接收 `collapsed` 和渲染后的 `width`；编辑器接收 `collapsed`、`exclusive` 和渲染后的 `width`。注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController` 和四个 owner-share 接口。AppFrame、面板 store、可观察桥接和让步求解器仍属于包内部。

该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板几何信息是瞬时状态**：重新加载会恢复侧边栏默认值，并关闭详情栏和编辑器；编辑器记住的宽度仅在当前根 store 实例内有效。
- **让步不会重写宽度偏好**：详情栏或编辑器的渲染宽度可能小于存储宽度；消费方必须使用 owner 几何信息渲染，并只用 `ctx.layout.editorOpen` 观察打开状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
