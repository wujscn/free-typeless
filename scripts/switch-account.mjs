#!/usr/bin/env node
/**
 * Typeless Account Switcher
 *
 * Logs out the current Typeless account locally, then automates email login
 * via a headless Chromium browser, captures the tokens from localStorage,
 * and writes the new login state into the local Typeless data files.
 *
 * Usage:
 *   node scripts/switch-account.mjs --email <email> [--code <code>]
 *
 * The --code flag is optional. When omitted the script will prompt
 * interactively for the 6-digit verification code sent to the email.
 *
 * Requires: TYPELESS_VENDOR_NODE_MODULES env var pointing to the
 * .vendor runtime that contains electron-store and puppeteer.
 * The wrapper script (scripts/switch-account.sh) sets this up.
 *
 * --- Auto-fetch extension point ---
 * To add automated verification code retrieval (e.g. via a temp email API,
 * Cloudflare Email Worker, or IMAP client), implement a module that exports:
 *   async function fetchVerificationCode(email): Promise<string>
 * Then pass it as a codeResolver function to automateLogin(). The resolver
 * is called after the verification email has been triggered, so it can poll
 * an inbox API until the 6-digit code arrives.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFileSync, execSync } from 'child_process';
import {
  getStorageArch,
  getStorageAppName,
  getStoragePlatform,
  getTypelessCacheDevicePath,
  getTypelessUserDataDir,
  getWindowsEnvPath,
  isWsl,
  windowsPathToWslPath,
} from './typeless-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── constants ────────────────────────────────────────────────────────────────
const STORAGE_PLATFORM = getStoragePlatform();
const USER_DATA_DIR = getTypelessUserDataDir();
const REFER_URL = 'https://www.typeless.com/refer?code=JTIF7BK';
const TOKEN_LS_KEY = 'MAXAI_CLIENT__FEATURES__AUTH__TOKEN_INFO';

function findTypelessAppPath() {
  const candidates = [];
  if (process.env.TYPELESS_APP_PATH) candidates.push(process.env.TYPELESS_APP_PATH);
  if (STORAGE_PLATFORM === 'win32') {
    const localAppData = process.platform === 'win32'
      ? process.env.LOCALAPPDATA
      : windowsPathToWslPath(getWindowsEnvPath('LOCALAPPDATA'));
    const programFiles = process.platform === 'win32'
      ? (process.env.ProgramFiles || 'C:\\Program Files')
      : windowsPathToWslPath(getWindowsEnvPath('ProgramFiles') || 'C:\\Program Files');
    candidates.push(
      path.join(localAppData || '', 'Programs', 'Typeless', 'Typeless.exe'),
      path.join(programFiles || '', 'Typeless', 'Typeless.exe'),
    );
  } else {
    candidates.push(
      '/Applications/Typeless.app',
      path.join(os.homedir(), 'Applications', 'Typeless.app'),
    );
  }

  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function findTypelessWindowsExePath() {
  if (process.env.TYPELESS_WINDOWS_EXE_PATH) return process.env.TYPELESS_WINDOWS_EXE_PATH;
  if (process.platform === 'win32') return findTypelessAppPath();
  if (!isWsl()) return null;

  const candidates = [
    path.win32.join(getWindowsEnvPath('LOCALAPPDATA') || '', 'Programs', 'Typeless', 'Typeless.exe'),
    path.win32.join(getWindowsEnvPath('ProgramFiles') || 'C:\\Program Files', 'Typeless', 'Typeless.exe'),
  ];
  return candidates.find(candidate => {
    const wslPath = windowsPathToWslPath(candidate);
    return wslPath && fs.existsSync(wslPath);
  }) || null;
}

function execWindows(command, options = {}) {
  if (process.platform === 'win32') {
    return execSync(command, options);
  }
  if (isWsl()) {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', command], options);
  }
  throw new Error(`Windows 命令只能在 Windows 或 WSL 中执行: ${command}`);
}

function execPowerShell(command, options = {}) {
  if (process.platform === 'win32' || isWsl()) {
    return execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], options);
  }
  throw new Error(`PowerShell 命令只能在 Windows 或 WSL 中执行: ${command}`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── arg helpers ──────────────────────────────────────────────────────────────
function getArg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function ask(question) {
  // If running non-interactively (e.g. from an AI agent), the code can be
  // supplied via a file at /tmp/typeless-code.txt instead of stdin.
  // The agent writes the code to that file after the verification email is sent.
  const codeFile = path.join(os.tmpdir(), 'typeless-code.txt');
  return new Promise((resolve) => {
    // Poll for the code file for up to 5 minutes
    const poll = setInterval(() => {
      if (fs.existsSync(codeFile)) {
        const code = fs.readFileSync(codeFile, 'utf8').trim();
        fs.unlinkSync(codeFile);
        clearInterval(poll);
        console.error(`[switch] Read code from file`);
        resolve(code);
      }
    }, 500);

    // Also listen on stdin in parallel (for interactive use)
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, ans => {
      clearInterval(poll);
      rl.close();
      resolve(ans.trim());
    });
  });
}

// ── crypto: derive the same encryption key Typeless uses ─────────────────────
function deriveKey() {
  const seed = crypto.createHash('sha256')
    .update(`${getStoragePlatform()}-${getStorageArch()}`)
    .digest('hex');
  return crypto.pbkdf2Sync(seed + getStorageAppName(), 'typeless-user-service', 10000, 32, 'sha256');
}

async function loadElectronStore() {
  const vendorRoot = process.env.TYPELESS_VENDOR_NODE_MODULES;
  if (!vendorRoot) throw new Error('Missing TYPELESS_VENDOR_NODE_MODULES env var');
  const modPath = path.join(vendorRoot, 'electron-store', 'index.js');
  if (!fs.existsSync(modPath)) throw new Error(`electron-store not found: ${modPath}`);
  const mod = await import(pathToFileURL(modPath).href);
  return mod.default;
}

function removeIfExists(target, label) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  console.error(`[switch] Removed ${label}`);
}

function backupPath(source, backupRoot, label) {
  if (!fs.existsSync(source)) return;
  const dest = path.join(backupRoot, label);
  fs.cpSync(source, dest, { recursive: true, force: true, verbatimSymlinks: true });
  console.error(`[switch] Backed up ${label}`);
}

function backupLocalState() {
  const backupRoot = path.join(os.tmpdir(), `typeless-switch-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  backupPath(USER_DATA_DIR, backupRoot, 'Typeless-Application-Support');

  if (STORAGE_PLATFORM === 'darwin') {
    const cacheRoot = path.join(os.homedir(), 'Library', 'Caches');
    for (const name of ['now.typeless.desktop', 'typeless-updater', 'now.typeless.desktop.ShipIt']) {
      backupPath(path.join(cacheRoot, name), backupRoot, name);
    }
  }

  console.error(`[switch] Backup written to ${backupRoot}`);
  return backupRoot;
}

function resetMacKeychainDeviceIdentifier(backupRoot) {
  let oldUuid = '';
  try {
    oldUuid = execSync(
      'security find-generic-password ' +
      '-s "now.typeless.desktop.deviceIdentifier" ' +
      '-a "now.typeless.desktop.security.auth_key" ' +
      '-w 2>/dev/null',
      { encoding: 'utf8' },
    ).trim();
  } catch { /* may not exist, that's fine */ }

  const newUuid = crypto.randomUUID().toUpperCase();
  fs.writeFileSync(
    path.join(backupRoot, 'keychain-device-uuid.txt'),
    `old_uuid=${oldUuid}\nnew_uuid=${newUuid}\n`,
  );

  execSync(
    'security add-generic-password -U ' +
    '-s "now.typeless.desktop.deviceIdentifier" ' +
    '-a "now.typeless.desktop.security.auth_key" ' +
    `-w "${newUuid}"`,
    { stdio: 'ignore' },
  );
  console.error(`[switch] Overwrote Keychain device identifier: ${newUuid}`);
}

function clearElectronSessionState() {
  const paths = [
    '.updaterId',
    'Cookies',
    'Cookies-journal',
    'Local Storage',
    'Session Storage',
    'SharedStorage',
    'SharedStorage-wal',
    'SharedStorage-shm',
    'Trust Tokens',
    'Trust Tokens-journal',
    'Network Persistent State',
    'TransportSecurity',
    'blob_storage',
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    path.join('Partitions', 'no-proxy-session', 'Cookies'),
    path.join('Partitions', 'no-proxy-session', 'Cookies-journal'),
    path.join('Partitions', 'no-proxy-session', 'Local Storage'),
    path.join('Partitions', 'no-proxy-session', 'Session Storage'),
    path.join('Partitions', 'no-proxy-session', 'SharedStorage'),
    path.join('Partitions', 'no-proxy-session', 'SharedStorage-wal'),
    path.join('Partitions', 'no-proxy-session', 'SharedStorage-shm'),
    path.join('Partitions', 'no-proxy-session', 'Trust Tokens'),
    path.join('Partitions', 'no-proxy-session', 'Trust Tokens-journal'),
    path.join('Partitions', 'no-proxy-session', 'Network Persistent State'),
    path.join('Partitions', 'no-proxy-session', 'TransportSecurity'),
    path.join('Partitions', 'no-proxy-session', 'blob_storage'),
    path.join('Partitions', 'no-proxy-session', 'Cache'),
    path.join('Partitions', 'no-proxy-session', 'Code Cache'),
    path.join('Partitions', 'no-proxy-session', 'GPUCache'),
    path.join('Partitions', 'no-proxy-session', 'DawnGraphiteCache'),
    path.join('Partitions', 'no-proxy-session', 'DawnWebGPUCache'),
  ];

  for (const rel of paths) {
    removeIfExists(path.join(USER_DATA_DIR, rel), rel);
  }

  if (STORAGE_PLATFORM === 'darwin') {
    const cacheRoot = path.join(os.homedir(), 'Library', 'Caches');
    for (const name of ['now.typeless.desktop', 'typeless-updater', 'now.typeless.desktop.ShipIt']) {
      removeIfExists(path.join(cacheRoot, name), name);
    }
  }
}

// ── (reserved) auto-fetch integration ────────────────────────────────────────
// To enable automated code retrieval, implement a fetchVerificationCode(email)
// function and wire it as a codeResolver in main(). See file header for details.

// ── Step 1: Logout ───────────────────────────────────────────────────────────
async function getCurrentEmail() {
  try {
    const Store = await loadElectronStore();
    const store = new Store({
      name: 'user-data',
      cwd: USER_DATA_DIR,
      encryptionKey: deriveKey(),
    });
    const raw = store.get('userData');
    if (!raw) return null;
    const user = JSON.parse(raw);
    return user?.email || null;
  } catch {
    return null;
  }
}

function logoutLocal() {
  const backupRoot = backupLocalState();

  const userDataPath = path.join(USER_DATA_DIR, 'user-data.json');
  if (fs.existsSync(userDataPath)) {
    fs.unlinkSync(userDataPath);
    console.error('[switch] Deleted user-data.json');
  }
  const appStoragePath = path.join(USER_DATA_DIR, 'app-storage.json');
  if (fs.existsSync(appStoragePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      delete data.userData;
      delete data.quotaUsage;
      delete data.currentRoute;
      delete data.TYPELESS_418_SEND_ERROR_COUNT;
      delete data.TYPELESS_TIME_DIFF;
      fs.writeFileSync(appStoragePath, JSON.stringify(data, null, '\t'));
      console.error('[switch] Cleared login/quota request state from app-storage.json');
    } catch { /* ignore */ }
  }

  // Reset device identifier so Typeless treats this as a new device
  if (STORAGE_PLATFORM === 'win32') {
    try {
      execWindows('cmdkey /delete:Typeless.deviceIdentifier', { stdio: 'ignore' });
      console.error('[switch] Reset device identifier (Credential Manager)');
    } catch { /* may not exist, that's fine */ }
    // Also remove the device cache file
    const deviceCache = getTypelessCacheDevicePath();
    if (deviceCache && fs.existsSync(deviceCache)) {
      fs.unlinkSync(deviceCache);
      console.error('[switch] Removed device.cache');
    }
  } else {
    try {
      resetMacKeychainDeviceIdentifier(backupRoot);
    } catch {
      console.error('[switch] Could not overwrite Keychain device identifier');
    }
  }

  clearElectronSessionState();

  // Restart Typeless app to avoid stale in-memory state
  if (STORAGE_PLATFORM === 'win32') {
    try {
      const isRunning = execWindows('tasklist /FI "IMAGENAME eq Typeless.exe" /NH', { encoding: 'utf8' });
      if (isRunning.includes('Typeless.exe')) {
        console.error('[switch] Restarting Typeless app…');
        execWindows('taskkill /IM Typeless.exe /F', { stdio: 'ignore' });
        // Wait for process to exit
        for (let i = 0; i < 10; i++) {
          const still = execWindows('tasklist /FI "IMAGENAME eq Typeless.exe" /NH', { encoding: 'utf8' });
          if (!still.includes('Typeless.exe')) break;
          sleepMs(1000);
        }
        const exePath = process.platform === 'win32' ? findTypelessAppPath() : findTypelessWindowsExePath();
        if (exePath) {
          execPowerShell(`Start-Process -FilePath '${exePath.replaceAll("'", "''")}'`, { stdio: 'ignore' });
          console.error('[switch] Typeless restarted');
        }
      }
    } catch { /* non-critical */ }
  } else {
    try {
      const isRunning = execSync('pgrep -f "Typeless.app" || true', { encoding: 'utf8' }).trim();
      if (isRunning) {
        console.error('[switch] Restarting Typeless app…');
        execSync('osascript -e \'quit app "Typeless"\'', { stdio: 'ignore' });
        for (let i = 0; i < 10; i++) {
          const still = execSync('pgrep -f "Typeless.app" || true', { encoding: 'utf8' }).trim();
          if (!still) break;
          execSync('sleep 0.5');
        }
        const appPath = findTypelessAppPath();
        if (appPath) {
          execSync(`open "${appPath}"`, { stdio: 'ignore', shell: true });
          console.error(`[switch] Typeless restarted from ${appPath}`);
        } else {
          console.error('[switch] Typeless app not found in /Applications or ~/Applications');
        }
      }
    } catch { /* non-critical */ }
  }
}

// ── Step 2-5: Headless browser login ─────────────────────────────────────────
// codeOrResolver can be:
//   - a string (the 6-digit code)
//   - a function () => Promise<string> that fetches the code (called after the
//     verification email has been triggered)
//   - null/undefined (will prompt interactively)
async function automateLogin(email, codeOrResolver) {
  const vendorRoot = process.env.TYPELESS_VENDOR_NODE_MODULES;
  const puppeteerPath = path.join(vendorRoot, 'puppeteer', 'lib', 'cjs', 'puppeteer', 'puppeteer.js');
  if (!fs.existsSync(puppeteerPath)) throw new Error(`puppeteer not found: ${puppeteerPath}`);
  const puppeteer = await import(pathToFileURL(puppeteerPath).href);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // 1. Navigate to refer page
    console.error('[switch] Opening login page…');
    await page.goto(REFER_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 2. Click "Claim your $5 credit" to open the login modal
    console.error('[switch] Clicking Claim button to open login modal…');
    const claimClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, button')) {
        if (el.textContent.trim() === 'Claim your $5 credit') {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!claimClicked) throw new Error('Could not find "Claim your $5 credit" button');
    await new Promise(r => setTimeout(r, 2000));

    // 3. Wait for the modal and click "Continue with email"
    console.error('[switch] Waiting for login modal…');
    await page.waitForSelector('[role="presentation"]', { timeout: 10000 });
    console.error('[switch] Clicking Continue with email…');
    const emailBtnClicked = await page.evaluate(() => {
      // Look inside the modal specifically
      const modal = document.querySelector('[role="presentation"]');
      if (!modal) return null;
      for (const p of modal.querySelectorAll('p')) {
        if (p.textContent.trim() === 'Continue with email') {
          const rect = p.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    });
    if (!emailBtnClicked) throw new Error('Could not find "Continue with email" button');
    await page.mouse.click(emailBtnClicked.x, emailBtnClicked.y);
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForSelector('input', { timeout: 10000 });

    // 4. Fill email and submit
    console.error(`[switch] Entering email: ${email}`);
    const emailInput = await page.$('[role="presentation"] input[placeholder="Email address"], [role="presentation"] input[type="email"], input[placeholder="Email address"]');
    if (!emailInput) {
      throw new Error('Could not find email input');
    }
    await emailInput.type(email, { delay: 20 });
    await new Promise(r => setTimeout(r, 500));
    // Click the submit button inside the modal
    await page.evaluate(() => {
      const modal = document.querySelector('[role="presentation"]');
      if (!modal) return;
      for (const b of modal.querySelectorAll('button')) {
        if (b.textContent.trim() === 'Continue with email') { b.click(); return; }
      }
    });

    // 4. Wait for code input
    console.error('[switch] Waiting for verification code page…');
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes('verification code') || text.includes('6-digit') || text.includes('code has sent');
      },
      { timeout: 30000 },
    );
    await new Promise(r => setTimeout(r, 1000));

    // Resolve the verification code
    let code;
    if (typeof codeOrResolver === 'function') {
      console.error('[switch] Fetching verification code automatically…');
      code = await codeOrResolver();
    } else if (typeof codeOrResolver === 'string' && codeOrResolver.length === 6) {
      code = codeOrResolver;
    } else {
      code = await ask('[switch] Enter 6-digit verification code: ');
    }
    if (!code || code.length !== 6) throw new Error('Invalid verification code');

    // 5. Fill code and submit
    console.error('[switch] Entering verification code…');
    const codeInput = await page.$('input[placeholder*="erification" i], input[placeholder*="code" i], input[type="text"], input[type="number"]');
    if (!codeInput) throw new Error('Could not find verification code input');
    await codeInput.type(code, { delay: 20 });
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === 'Sign in') { b.click(); return; }
      }
    });

    // 6. Wait for success page (allow extra time for slow networks)
    console.error('[switch] Waiting for login success…');
    await page.waitForFunction(
      () => document.body.innerText.includes('Open the desktop app')
        || document.body.innerText.includes('Download Typeless'),
      { timeout: 60000 },
    );

    // 7. Read tokens from localStorage
    const tokenJson = await page.evaluate((key) => localStorage.getItem(key), TOKEN_LS_KEY);
    if (!tokenJson) throw new Error('Could not read token from localStorage');

    const tokens = JSON.parse(tokenJson);
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user_id: tokens.userId,
      email: tokens.email,
    };
  } finally {
    await browser.close();
  }
}

// ── Step 6: Write login state ────────────────────────────────────────────────
async function writeLoginState({ access_token, refresh_token, email, user_id }) {
  if (!access_token || !refresh_token || !email || !user_id) {
    throw new Error('Missing required login parameters');
  }

  const Store = await loadElectronStore();
  const store = new Store({
    name: 'user-data',
    cwd: USER_DATA_DIR,
    encryptionKey: deriveKey(),
  });

  store.set('userData', JSON.stringify({
    email,
    access_token,
    refresh_token,
    login_time: Date.now(),
    user_id,
  }));

  console.error(`[switch] Login state written: ${email} (${user_id})`);
}

// ── accounts.json helpers ────────────────────────────────────────────────────
const ACCOUNTS_PATH = path.resolve(__dirname, '..', 'accounts.json');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); }
  catch { return { accounts: [] }; }
}

function saveOrUpdateAccount(email, typelessUserId) {
  const data = loadAccounts();
  let entry = data.accounts.find(a => a.address === email);
  if (!entry) {
    entry = { address: email, created_at: new Date().toISOString(), typeless_user_id: null };
    data.accounts.push(entry);
  }
  if (typelessUserId) entry.typeless_user_id = typelessUserId;
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2) + '\n');
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let email = getArg('--email');
  let code = getArg('--code');

  if (!email) {
    console.error('Usage:');
    console.error('  node scripts/switch-account.mjs --email <email> [--code <code>]');
    console.error('');
    console.error('Options:');
    console.error('  --email <email>   Target email address to log into Typeless');
    console.error('  --code <code>     6-digit verification code (if omitted, will prompt interactively)');
    process.exit(1);
  }

  const currentEmail = await getCurrentEmail();
  if (currentEmail) {
    console.error(`[switch] Current account: ${currentEmail}`);
  }

  // 1. Logout
  logoutLocal();

  // 2-5. Browser login → get tokens
  // To plug in automated code retrieval, replace `code` with a codeResolver
  // function here. See the file header comment for the extension point spec.
  const tokens = await automateLogin(email, code);

  // 6. Write local state
  await writeLoginState(tokens);

  // Record in accounts.json
  saveOrUpdateAccount(email, tokens.user_id);

  // Output result
  console.log(JSON.stringify({
    ok: true,
    email: tokens.email,
    user_id: tokens.user_id,
    previous_account: currentEmail || null,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
