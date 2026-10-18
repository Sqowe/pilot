# Getting started

This guide takes you from a fresh install to your first completed task.

## Install

Sqowe Pilot ships pre-built installers for **Windows** and **macOS** — no terminal or
coding required.

1. Download the latest release from the **[Releases page](https://github.com/sqowe/pilot/releases)**.
2. Run the installer:
   - **Windows**: the `.exe` installer.
   - **macOS 13 or later (Apple Silicon)**: open the `.dmg` and drag **Sqowe Pilot** to Applications.
3. On macOS, if you see a security warning the first time you open it, go to
   **System Settings → Privacy & Security** and click **Open Anyway**.

> ⚠️ TODO (human): confirm the official download channel / any signing/quarantine notes.

![Sqowe Pilot first launch](assets/getting-started-first-run.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/getting-started-first-run.png

<details>
<summary>Build from source (developers)</summary>

```bash
git clone https://github.com/sqowe/pilot.git sqowe-pilot
cd sqowe-pilot
npm install
npm run dev
```

Nothing needs rebuilding after `npm install`: the SQLite module ships one prebuilt binary
that works for both the app and the tests. Build an installer with `npm run build`.

</details>

## 1. Get an API key

The agent needs a model API key. Common choices:

| Provider           | Where to get a key                                                         | Base URL                                 |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------- |
| **Anthropic**      | [Anthropic Console](https://console.anthropic.com/)                        | _(default — leave blank)_                |
| **OpenRouter**     | [OpenRouter](https://openrouter.ai/)                                       | `https://openrouter.ai/api`              |
| **Zhipu AI (GLM)** | [GLM Coding Plan](https://bigmodel.cn/glm-coding)                          | `https://open.bigmodel.cn/api/anthropic` |
| **MiniMax**        | [MiniMax Coding Plan](https://platform.minimaxi.com/subscribe/coding-plan) | `https://api.minimaxi.com/anthropic`     |
| **Kimi**           | [Kimi Coding Plan](https://www.kimi.com/membership/pricing)                | `https://api.kimi.com/coding/`           |

If you sit behind a corporate proxy, you can also route all model traffic through an HTTP
proxy (see [Settings](features/models-and-api.md)).

## 2. Configure the app

1. Open **Sqowe Pilot**. If the API isn't configured yet, the Welcome screen says so and
   offers **Go to Settings**, which opens the **Providers** tab. (The ⚙️ **Settings** icon,
   bottom-left, leads to the same place.)
2. On **Providers**, find your provider, press **Configure**, paste your **API Key** and
   press **Save**. For a service the list does not have, press **Add endpoint** instead and
   enter its **Base URL** — the table above has the addresses.
3. Open the **Model Sets** tab. Choose that provider under **API Provider**, then pick a
   **Model**. Each model shows only the reasoning ("thinking") levels it supports — choose
   one, or leave the default.
4. Press **Save Settings** and close Settings.

See [Models & API](features/models-and-api.md) for the details, and for the two-step setup
dialog that appears if you send a message before any of this is done.

![Configure API provider and model](assets/getting-started-configure-api.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/getting-started-configure-api.png

## 3. Start coworking

1. On the Welcome screen, click **Select Working Folder** and pick a folder the agent is
   allowed to work in. Everything it does stays inside this folder.
2. (Optional) Attach files or images by dragging them into the input box, or pin specific
   [skills](features/skills.md) / [connectors](features/mcp-connectors.md) for this chat.
3. Type a task, for example:

   > Read `financial_report.csv` in this folder and create a PowerPoint summary with 5 slides.

4. Watch the agent reason and use tools in the message trace. When it wants to do something
   sensitive (run a shell command, write a file), it asks first — see
   [Approvals & safety](features/permissions-and-safety.md).

That's it — you've run your first task. From here, explore the [feature guides](index.md).

> ⚠️ TODO (human): network note — for tools like WebSearch behind a proxy you may need to enable a virtual network interface (TUN mode) in your proxy settings.

---

[← All docs](index.md)
