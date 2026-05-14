import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const APP_NAME = 'Typeless';

export function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME)
    || os.release().toLowerCase().includes('microsoft')
    || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

export function getStoragePlatform() {
  return process.env.TYPELESS_STORAGE_PLATFORM || (isWsl() ? 'win32' : process.platform);
}

export function getStorageArch() {
  return process.env.TYPELESS_STORAGE_ARCH || process.arch;
}

export function getStorageAppName() {
  return process.env.TYPELESS_STORAGE_APP_NAME || (getStoragePlatform() === 'win32' ? 'Typeless.exe' : APP_NAME);
}

function readWindowsEnv(name) {
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', `echo %${name}%`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return output && output !== `%${name}%` ? output.replace(/\r/g, '') : null;
}

export function windowsPathToWslPath(windowsPath) {
  if (!windowsPath) return null;
  try {
    return execFileSync('wslpath', ['-u', windowsPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    const normalized = windowsPath.replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (!match) return normalized;
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
}

export function getWindowsEnvPath(name) {
  if (process.platform === 'win32') return process.env[name] || null;
  if (!isWsl()) return null;
  return readWindowsEnv(name);
}

export function getTypelessUserDataDir() {
  if (process.env.TYPELESS_USER_DATA_DIR) {
    return path.resolve(process.env.TYPELESS_USER_DATA_DIR);
  }

  const storagePlatform = getStoragePlatform();
  if (storagePlatform === 'win32') {
    const appData = process.platform === 'win32'
      ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : windowsPathToWslPath(getWindowsEnvPath('APPDATA'));
    if (!appData) {
      throw new Error('无法定位 Windows APPDATA；可设置 TYPELESS_USER_DATA_DIR 指向 Typeless.exe 数据目录');
    }
    return path.join(appData, 'Typeless.exe');
  }

  if (storagePlatform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }

  return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
}

export function getTypelessCacheDevicePath() {
  if (getStoragePlatform() !== 'win32') return null;
  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || null)
    : windowsPathToWslPath(getWindowsEnvPath('APPDATA'));
  return appData ? path.join(appData, 'Typeless', 'Cache', 'device.cache') : null;
}

export function redactPath(targetPath) {
  if (!targetPath) return targetPath;
  return targetPath
    .replace(os.homedir(), '~')
    .replace(/^\/mnt\/([a-z])\/Users\/[^/]+/i, '/mnt/$1/Users/~');
}

export { APP_NAME };
