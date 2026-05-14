# Typeless Dictionary Extraction

## Goal

Extract the currently logged-in Typeless account's custom dictionary on macOS and save the export inside this skill's `references/` folder.

## Canonical output files

The export script writes all outputs here:

- `references/typeless-dictionary-export.json`
- `references/typeless-dictionary-export.txt`
- `references/typeless-dictionary-export.csv`

## Exact extraction path

### 1. Confirm the source account is active in Typeless

The user must already be logged into the source Typeless account on the same Mac that runs the script.

### 2. Read local Typeless app state

Typeless stores local app data in:

- `~/Library/Application Support/Typeless/`

Useful files observed during reverse-engineering:

- `user-data.json` — encrypted Electron Store payload containing the live login state
- `app-storage.json` — readable app metadata, useful for account confirmation but not enough by itself for API export

### 3. Decrypt the Electron Store record

The extractor uses `electron-store` to read the `user-data` store from the Typeless app data directory.

On WSL, the runtime platform is Linux, but the Typeless desktop data is Windows data. The scripts therefore default to a Windows storage profile when WSL is detected:

- data directory: `%APPDATA%\Typeless.exe`, converted to a WSL path
- storage platform: `win32`
- storage arch: current Node arch, usually `x64`
- encryption app name: `Typeless.exe`

Key derivation used by the script:

1. Build a seed string from the current machine runtime:
   - `${storagePlatform}-${storageArch}`
2. Hash it with SHA-256 and keep the hex digest.
3. Derive the final 32-byte key with PBKDF2:
   - password: `<seed-hex> + <storageAppName>`
   - salt: `typeless-user-service`
   - iterations: `10000`
   - length: `32`
   - digest: `sha256`

Observed storage app names:

- macOS: `Typeless`
- Windows: `Typeless.exe`

After decryption, parse the `userData` JSON string and extract:

- `access_token`
- `user_id`
- `email`

### 4. Pull the dictionary from Typeless API

Use the bearer token from the decrypted login state and call:

- `GET https://api.typeless.com/user/dictionary/list?size=10000`

Typeless 1.4.0 on Windows uses the stored `refresh_token` as the bearer token for app API calls. The scripts therefore prefer `refresh_token` and fall back to `access_token` for older local state.

Successful responses return `data.words`, which is the full dictionary list used for export.

### 5. Write export artifacts

The script writes three files into `references/`:

- JSON — canonical structured export with metadata and raw words
- TXT — one term per line for fast inspection
- CSV — spreadsheet-friendly export

## Script entry point

Run from the skill directory:

```bash
bash scripts/export-dictionary.sh
```

The wrapper will:

1. Create a local runtime cache under `scripts/.vendor/`
2. Install `electron-store` there on first run
3. Run the Node extractor
4. Save the export into `references/`

## Sanity checks after export

- Confirm the reported `total` looks right
- Spot-check anchor terms the user mentioned
- Treat `references/typeless-dictionary-export.json` as the source-of-truth export for later compare/import work

## Troubleshooting

### `未读取到 Typeless 登录态`

Typeless is likely logged out, the local store changed, or the app data path is different. Use `bash scripts/switch-account.sh --email <email>` or `--new` to log into a target account.

### `未读取到 access_token`

The local store was readable but did not contain a live token. Use the account switcher to re-login, then rerun the export.

### `词典列表请求失败`

The token may be expired, the network may be down, or Typeless changed its API behavior. Use the account switcher to get a fresh token; if the failure persists, inspect the API response body and update the script.

## Account switching

The account switcher (`scripts/switch-account.sh`) handles logout and login in one step.

### How logout works

1. Back up `~/Library/Application Support/Typeless` and selected macOS cache directories to `/tmp`.
2. Delete `~/Library/Application Support/Typeless/user-data.json` (encrypted Electron Store containing the login session).
3. Remove `userData`, `quotaUsage`, and request timing/error keys from `app-storage.json`.
4. Clear Electron/Chromium session state: Cookies, Local Storage, Session Storage, Trust Tokens, SharedStorage, Network state, and cache directories.
5. On macOS, clear `~/Library/Caches/now.typeless.desktop`, `~/Library/Caches/typeless-updater`, and `~/Library/Caches/now.typeless.desktop.ShipIt`.

This only affects the on-disk state. The running Typeless desktop app keeps its in-memory session until restarted.

### How login works

1. A headless Chromium browser (via puppeteer) navigates to the Typeless login page.
2. The script clicks "Continue with email", fills the target email, and submits.
3. Typeless sends a 6-digit verification code to the email. Supply `--code` directly, or the script will prompt interactively.
4. After successful sign-in, the script reads `accessToken`, `refreshToken`, `userId`, and `email` from the browser's `localStorage` key `MAXAI_CLIENT__FEATURES__AUTH__TOKEN_INFO`.
5. The script writes these into `user-data.json` using the same `electron-store` encryption that Typeless uses (PBKDF2-derived key, see "Decrypt the Electron Store record" above).

### Keychain entry

Older Typeless builds or prior experiments may store a device identifier in macOS Keychain under:
- service: `now.typeless.desktop.deviceIdentifier`
- account: `now.typeless.desktop.security.auth_key`

The account switcher and reset-device flow overwrite this entry with a fresh UUID before re-login. This is intentionally an overwrite rather than a delete: Typeless 1.1.0 can recreate the same UUID after deletion, while direct overwrite survived restart and fixed the local `account exceeded limit` case.
