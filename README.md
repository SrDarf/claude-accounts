# claude-accounts

**Switch between multiple Claude Code logins in one `~/.claude` — no browser re-login, no juggling config folders.**

`claude --accounts` opens an arrow-key selector, swaps the active login in place, and launches Claude. Personal, work, client — one keypress apart.

![selector](docs/img/selector.png)

---

## The problem

Claude Code binds **one logged-in account per config directory**. The identity lives in two files inside `~/.claude`:

- `~/.claude/.credentials.json` — the OAuth tokens
- `~/.claude.json` → `oauthAccount` — the account identity (email, org, uuid)

To use a second account today, you either **log out and re-authenticate through the browser every time**, or you keep **parallel config folders** and flip `CLAUDE_CONFIG_DIR` between them — which forks your history, settings, hooks, skills, and projects across folders that drift apart.

## The solution

`claude-accounts` keeps **a single `~/.claude`** and swaps only the login.

Each account's two identity files are stashed in a vault at `~/.claude/.accounts/<name>/`. Switching:

1. **Saves** the current live login back into its slot (preserving freshly refreshed tokens).
2. **Loads** the target account's tokens into `~/.claude/.credentials.json`.
3. **Injects** the target `oauthAccount` into `~/.claude.json`, leaving every other key untouched.

Everything else — settings, hooks, skills, projects, history — stays in one place and is shared across all accounts. No re-login. No folder drift.

---

## Install

**macOS / Linux** (bash, zsh):

```
curl -fsSL https://raw.githubusercontent.com/SrDarf/claude-accounts/main/install.js | node
```

**Windows — PowerShell** (5.1 or 7):

```powershell
irm https://raw.githubusercontent.com/SrDarf/claude-accounts/main/install.js -OutFile "$env:TEMP\ca-install.js"; node "$env:TEMP\ca-install.js"
```

**Windows — cmd.exe**:

```
curl -fsSL https://raw.githubusercontent.com/SrDarf/claude-accounts/main/install.js -o "%TEMP%\ca-install.js" && node "%TEMP%\ca-install.js"
```

> **PowerShell note:** don't use the `curl ... | node` form there — in PowerShell `curl` is an alias for `Invoke-WebRequest`, which doesn't accept `-fsSL` and won't pipe the script to `node`. Use the `irm` command above (download, then run). If `irm` fails with an SSL/TLS error on an old PowerShell 5.1, run `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` first.

![installer](docs/img/install.png)

The installer fetches a dependency-free Node core into `~/.claude-accounts`, resolves your real `claude` binary, and wires a thin `claude` wrapper into your shell (PowerShell, cmd, bash, zsh). Existing config is backed up (`.bak-<timestamp>`) and edited inside marked blocks — re-running is safe and idempotent.

### Language

On install you choose the interface language — **English** or **Português (BR)**. When run interactively (a TTY), the installer shows an arrow-key prompt; the choice is saved to `~/.claude-accounts/config.json` and used by the selector and all messages. The Windows commands above download the file and then run it, so they prompt interactively too — only the piped `curl | node` form skips the prompt.

A piped install (`curl ... | node`, macOS/Linux) has no TTY and auto-detects from your OS locale. Force a language explicitly:

```
curl -fsSL .../install.js | node - --lang pt                 # macOS/Linux
node "$env:TEMP\ca-install.js" --lang pt                     # Windows, after download (or: --lang en)
```

Change it any time by editing `~/.claude-accounts/config.json` (`{"lang":"pt"}`) or setting `CLAUDE_ACCOUNTS_LANG=en`.

Open a new shell afterward.

## Usage

```
claude --accounts          # open the selector, switch, then launch Claude
claude --account work      # switch straight to "work", then launch
claude ...                 # anything else passes through to the real Claude untouched
```

Extra arguments are forwarded: `claude --account work --resume` switches then resumes.

> Close any running Claude session before switching — Claude reads the credential files at startup.

## Adding an account

Pick **`+ adicionar conta`** in the selector. A guided browser login runs in a throwaway
config dir; the captured credentials are filed into the vault under the name you choose.
No tokens are ever typed or pasted by hand.

Remove one with **`- remover conta`**.

## How switching stays safe

- **Save-before-load:** the live login is written back to its slot *before* the target is loaded, so tokens that Claude refreshed during your session are never lost.
- **Surgical `.claude.json` edit:** only the `oauthAccount` key is replaced; your projects, onboarding state, and the other ~40 keys are preserved.
- **Atomic writes + backups:** credential files are written atomically; shell configs are backed up before any edit.

## Security

Tokens are stored in plaintext under `~/.claude/.accounts` — **the same exposure level as Claude Code's own `~/.claude/.credentials.json`**. The vault doesn't move tokens off your machine or add any new attack surface; it just relocates copies of files that already sit in plaintext in your home directory. On Unix the vault is `chmod 700` and slot files `600`.

## Requirements

- Node.js ≥ 18
- Claude Code already installed and on your `PATH`

## License

MIT
