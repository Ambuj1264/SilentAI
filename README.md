# SilentAI

A private ChatGPT window that is hidden from screen sharing and screen recording.
Built with Electron. Runs on **Windows** and **Mac**.

---

## 1. Install Node.js and Git (one time only)

- **Node.js** – download the **LTS** version from https://nodejs.org and install it with the default options.
- **Git** – download from https://git-scm.com (on Mac you can skip this; macOS offers to install Git the first time you use it).

## 2. Download the project

Open **Terminal** (Mac) or **Command Prompt / PowerShell** (Windows) and run these one at a time:

```bash
git clone https://github.com/Ambuj1264/SilentAI.git
```

```bash
cd SilentAI
```

```bash
git checkout hindi
```

## 3. Install the dependencies (one time only)

```bash
npm install
```

## 4. Add your voice key (optional)

Open `config.json` and put your [AssemblyAI](https://www.assemblyai.com) key in it
(`config.example.json` shows the format):

```json
{ "assemblyaiApiKey": "your-key-here" }
```

Without a key the app still runs, but hold-to-talk voice input is turned off.

> Keep your key private: don't upload a `config.json` that has your real key to a public repo.

## 5. Start the app

**Mac:**

```bash
npm start
```

**Windows:**

```bash
npx electron .
```

> On Windows, `npm start` doesn't work because the start script uses `env -u`, which only exists on Mac and Linux. Use `npx electron .` instead.

To start it again later, open the terminal, `cd` into the `SilentAI` folder, and repeat step 5.

---

## Mac only: allow permissions the first time

The app asks for these permissions. If you miss a prompt, open
**System Settings → Privacy & Security** and turn on **Terminal** under:

- **Screen Recording** – needed for the screenshot shortcut
- **Accessibility** – needed for hold-Option voice input
- **Microphone** – needed for voice input

Then quit the app and run `npm start` again.

On Mac there is no Dock icon; the app lives in the **menu bar** at the top of the screen.

---

## How to use

| Action | Mac | Windows |
|---|---|---|
| Show the ChatGPT window | `Cmd + Shift + C` | `Ctrl + Shift + C` |
| Hide the window | `Cmd + Shift + X` | `Ctrl + Shift + X` |
| Take a screenshot and send it to ChatGPT | `Cmd + Shift + S` | `Ctrl + Shift + S` |
| Voice: hold to talk, release to send | hold `Option ⌥` | hold `Alt` |

The first time the window opens, log in to ChatGPT inside it.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm start` fails on Windows | Use `npx electron .` |
| Voice doesn't work | Check that `config.json` has your AssemblyAI key. On Mac, turn on Accessibility and Microphone for Terminal. |
| `uiohook-napi failed to load` | Run `npm install` again. |
| Screenshot shortcut does nothing (Mac) | Turn on Screen Recording for Terminal, then restart the app. |
