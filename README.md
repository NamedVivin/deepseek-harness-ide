# DeepSeek Harness

English | [中文](README.zh.md)

![DeepSeek Harness plugin architecture and integrated Workspace IDE](.github/assets/readme/deepseek-harness-hero.png)

DeepSeek Harness (`dsh`) is an open-source, plugin-based agent harness developed by [DeepSeek AI](https://deepseek.com). Its integrated Workspace IDE keeps agent conversations, repository browsing, and file editing in one application.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Integrated IDE

Open files from the Workspace tree or jump directly to supported locations returned by the agent. Edit existing regular UTF-8 files in a tabbed CodeMirror workspace with common language highlighting, and preview Markdown from the current unsaved buffer. Wide screens keep the conversation and IDE side by side with a draggable divider; narrow screens give the IDE the content area.

![DeepSeek Harness integrated IDE with an agent conversation, Workspace file tree, and CodeMirror editor](.github/assets/readme/ide-workspace.png)

Saves use version checks. If a file changes on disk, the IDE preserves both your local buffer and the latest disk content so you can choose how to recover rather than silently overwrite either version. See [IDE behavior and limitations](packages/client/ui-ide/README.md) for the exact scope.

From a source checkout, build once and start the IDE with:

```sh
pnpm run build
pnpm dsh --profile ide
```

The packaged Electron application bundles its own Node.js runtime and opens no TCP listener. Signed installers are not published yet; local unsigned packages are development artifacts. See the [desktop application documentation](apps/desktop/README.md).

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
