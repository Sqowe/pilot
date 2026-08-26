<!-- sources: src/renderer/components/settings/SettingsRemote.tsx (RemoteControlPanel.tsx), src/main/remote/, README, ARCHITECTURE.md §2 (remote channels) -->

# Remote control

## What it is / when to use it

You can drive Sqowe Pilot from a chat platform — **Feishu (Lark)** or **Slack** — so you (or
your team) can send tasks and get results without opening the app. The app connects _outward_
to the platform by default (long-connection / Socket Mode), so no public IP or tunnel is
required.

Reach for this when: you want to trigger the agent from your phone, from a team channel, or
while away from your computer.

## How to use it

### Feishu (Lark)

1. Create an app in the **Feishu Open Platform** and add the **Bot** capability.
2. Copy the **App ID** and **App Secret** into **Settings → Remote → Feishu setup**.
3. Enable the required permissions in Feishu's permission settings, and in **Event
   Configuration** choose the **long connection** event mode, then subscribe to the message
   event.
4. Publish the app, then click **Start service**.

### Slack

1. Create a Slack app, install it to your workspace, then enter the **Bot User OAuth Token**
   and **App-Level Token** (for **Socket Mode**) under **Slack setup**.

### Connection mode

- **Long connection (recommended)** — the app connects outward; no public IP, works out of
  the box.
- **Webhook mode** — Feishu pushes to a public address you expose (optionally via the
  built-in ngrok).

### Who can use the bot

Set a **DM authorization policy**:

- **Pairing verification** — users must enter a pairing code (approve the request in-app).
- **Allowlist** — only specific users.
- **Open access** — anyone.

You can also set a **default working directory** and turn on **Auto-approve safe tools** (e.g.
file reads, browser ops) for remote sessions.

![Remote control settings](../assets/remote-control-settings.png)

> ⚠️ TODO (human): capture this → docs/wiki/assets/remote-control-settings.png

## Commands & settings

| Action               | How to run                                               |
| -------------------- | -------------------------------------------------------- |
| Start / stop service | Settings → Remote → **Start service** / **Stop service** |
| Approve pairing      | Settings → Remote → **Approve** (or reject)              |
| Revoke a user        | Authorized users → **Revoke access**                     |

| Setting                            | Default   | What it does                                       |
| ---------------------------------- | --------- | -------------------------------------------------- |
| `defaultWorkingDirectory` (remote) | _(empty)_ | Default folder for remote commands.                |
| Auto-approve safe tools            | off       | Allow safe tools without prompting in remote runs. |

> ⚠️ TODO (human): confirm the current Slack support level (the i18n surface and code are present; verify it's user-enabled in your build).

---

[← All docs](../index.md)
