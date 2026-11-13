'use strict';

/*
 * WebDAVrSync 1.2.2
 * A small, dependency-free, open-source Obsidian plugin that synchronizes a
 * vault with any WebDAV server that supports PROPFIND / PUT / GET / MKCOL /
 * DELETE (for example SFTPGo, Nextcloud, ownCloud, Apache mod_dav, nginx-dav).
 *
 * The file is intentionally plain CommonJS JavaScript: no build step, no
 * bundled dependencies. Drop the folder into <vault>/.obsidian/plugins/ and
 * enable it in Obsidian.
 *
 * License: MIT
 */

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  Modal,
  requestUrl,
} = require('obsidian');

const PLUGIN_ID = 'webdavrsync';
const PLUGIN_VERSION_FALLBACK = '1.2.2';
const STATE_VERSION = 1;
const CONFIG_FORMAT = 'webdavrsync-config';
const CONFIG_FORMAT_VERSION = 1;
const BACKUP_FORMAT = 'webdavrsync-plugin-backup';
const BACKUP_FILE_FORMAT = 'webdavrsync-encrypted-backup';
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 210000;
const BACKUP_MAX_FILE_SIZE = 25 * 1024 * 1024;
const BACKUP_MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const BACKUP_TEXT_EXTENSIONS = [
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.csv',
  '.svg',
];

const DEFAULT_IGNORE_TEXT = [
  '# 每行一个 glob：* 匹配同一层，** 匹配任意层，? 匹配单个字符',
  '# 以 # 开头的行是注释；不支持 ! 取反',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/plugins/webdavrsync/**',
  '.webdavrsync-backups/**',
  '**/*.pre-restore-*.bak',
  '# 回收站（.trash）默认也要同步，由设置里的“同步回收站”开关统一控制',
  '**/.git/**',
  '**/node_modules/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.tmp',
  '**/*.webdavrsync-tmp-*',
].join('\n');

const DEFAULT_SETTINGS = {
  serverUrl: '',
  username: '',
  password: '',
  remoteRoot: '/',
  deviceName: 'PC',
  syncIntervalMinutes: 0,
  syncOnStart: true,
  syncOnChange: true,
  allowDeletions: true,
  conflictStrategy: 'keep-both', // keep-both | newest
  syncConfig: false,
  verifyContent: true,
  ignoreText: DEFAULT_IGNORE_TEXT,
  // 回收站内容一并备份：否则“远端删除 → 本地移入回收站 → 回收站被忽略”
  // 会让文件在本地和远端同时消失，内容永远无法找回。
  syncTrash: true,
  // 同步空目录结构，让 WebDAV 浏览器里的目录层级与本地仓库保持一致。
  syncEmptyDirs: true,
  backupFolder: '.webdavrsync-backups',
  backupKeep: 10,
  backupIncludePluginCode: false,
};

const MULTISTATUS_BODY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<d:propfind xmlns:d="DAV:">',
  '  <d:prop>',
  '    <d:resourcetype/>',
  '    <d:getcontentlength/>',
  '    <d:getlastmodified/>',
  '    <d:getetag/>',
  '  </d:prop>',
  '</d:propfind>',
].join('\n');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timestampForName(date) {
  const d = date || new Date();
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function timeForStatus(date) {
  const d = date || new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function normalizeRelPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeRemoteRoot(root) {
  return normalizeRelPath(root)
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function decodeXmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (all, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (entity[0] === '#') {
      const hex = entity[1] && entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return all;
        }
      }
    }
    return all;
  });
}

function firstTagText(xml, tag) {
  const re = new RegExp(
    '<(?:[\\w.-]+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + tag + '>',
    'i'
  );
  const match = String(xml || '').match(re);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function base64Utf8(text) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(String(text), 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeEtag(etag) {
  return String(etag || '')
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"|"$/g, '');
}

// 文件系统返回的 mtime 可能带亚毫秒小数（不同平台精度不同），
// 直接用 !== 比较会让同一份文件每次同步都被判定为“本地已修改”，
// 从而无休止地重复上传。统一取整后再比较。
function normalizeMtime(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function equalBytes(a, b) {
  if (!a || !b) return false;
  const ua = a instanceof Uint8Array ? a : new Uint8Array(a);
  const ub = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (ua.byteLength !== ub.byteLength) return false;
  for (let i = 0; i < ua.byteLength; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

function sanitizeFileNamePart(value) {
  return String(value || 'device')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'device';
}

function globToRegExps(pattern) {
  const normalized = String(pattern || '').trim().replace(/\\/g, '/');
  if (!normalized) return [];

  const build = (p) => {
    let out = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') {
          i++;
          if (p[i + 1] === '/') {
            i++;
            out += '(?:.*/)?';
          } else {
            out += '.*';
          }
        } else {
          out += '[^/]*';
        }
      } else if (c === '?') {
        out += '[^/]';
      } else if ('.+^${}()|[]\\'.includes(c)) {
        out += '\\' + c;
      } else {
        out += c;
      }
    }
    return out;
  };

  const regexes = [new RegExp('^' + build(normalized) + '$')];
  // A rule like "folder/**" should also apply to the folder itself, so that
  // directory traversal can stop early.
  const base = normalized.match(/^(.*)\/\*\*$/);
  if (base && base[1]) {
    regexes.push(new RegExp('^' + build(base[1]) + '$'));
  }
  return regexes;
}

// 回收站规则由 syncTrash 设置统一控制，忽略规则不再重复管理，
// 避免“设置里开着、忽略规则里又写着”两处互相打架。
function isTrashPattern(pattern) {
  const p = String(pattern || '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  return p === '.trash' || p === '.trash/*' || p === '.trash/**';
}

// 判断某个仓库相对路径是否位于回收站内。
function isTrashPath(path) {
  const p = normalizeRelPath(path);
  return p === '.trash' || p.startsWith('.trash/');
}

function compileIgnore(settings) {
  const regexes = [];
  const add = (pattern) => {
    for (const re of globToRegExps(pattern)) regexes.push(re);
  };

  const syncTrash = settings.syncTrash !== false;

  for (const line of String(settings.ignoreText || '').split(/\r?\n/)) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    if (syncTrash && isTrashPattern(pattern)) continue;
    add(pattern);
  }

  if (!syncTrash) {
    add('.trash');
    add('.trash/**');
  }

  if (!settings.syncConfig) {
    add('.obsidian');
    add('.obsidian/**');
  }

  // The encrypted backup folder is managed by the backup feature, not by the
  // normal file sync. It lives on the remote and must not be pulled locally.
  const backupFolder = normalizeRelPath(settings.backupFolder || '');
  if (backupFolder) {
    add(backupFolder);
    add(backupFolder + '/**');
  }

  // Never sync this plugin's own folder: data.json contains the WebDAV
  // password and would otherwise be uploaded to the server.
  add('.obsidian/plugins/' + PLUGIN_ID);
  add('.obsidian/plugins/' + PLUGIN_ID + '/**');

  // Plain-text copies made before a restore may contain plugin tokens/keys.
  // Never upload them to the WebDAV server.
  add('**/*.pre-restore-*.bak');

  return (path) => {
    const p = normalizeRelPath(path);
    if (!p) return false;
    return regexes.some((re) => re.test(p));
  };
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const merged = Object.assign({}, DEFAULT_SETTINGS, source);
  return {
    serverUrl: String(merged.serverUrl || '').trim(),
    username: String(merged.username || ''),
    password: String(merged.password || ''),
    remoteRoot: String(merged.remoteRoot || '/').trim() || '/',
    deviceName: String(merged.deviceName || 'PC').trim() || 'PC',
    syncIntervalMinutes: Math.max(
      0,
      Math.min(1440, Number(merged.syncIntervalMinutes) || 0)
    ),
    syncOnStart: toBoolean(merged.syncOnStart, DEFAULT_SETTINGS.syncOnStart),
    syncOnChange: toBoolean(merged.syncOnChange, DEFAULT_SETTINGS.syncOnChange),
    allowDeletions: toBoolean(merged.allowDeletions, DEFAULT_SETTINGS.allowDeletions),
    conflictStrategy: merged.conflictStrategy === 'newest' ? 'newest' : 'keep-both',
    syncConfig: toBoolean(merged.syncConfig, DEFAULT_SETTINGS.syncConfig),
    verifyContent: toBoolean(merged.verifyContent, DEFAULT_SETTINGS.verifyContent),
    syncTrash: toBoolean(merged.syncTrash, DEFAULT_SETTINGS.syncTrash),
    syncEmptyDirs: toBoolean(merged.syncEmptyDirs, DEFAULT_SETTINGS.syncEmptyDirs),
    ignoreText:
      typeof merged.ignoreText === 'string' ? merged.ignoreText : DEFAULT_SETTINGS.ignoreText,
    backupFolder:
      normalizeRelPath(merged.backupFolder || DEFAULT_SETTINGS.backupFolder) ||
      DEFAULT_SETTINGS.backupFolder,
    backupKeep: Math.max(
      1,
      Math.min(
        100,
        Math.floor(Number(merged.backupKeep) || DEFAULT_SETTINGS.backupKeep)
      )
    ),
    backupIncludePluginCode: toBoolean(
      merged.backupIncludePluginCode,
      DEFAULT_SETTINGS.backupIncludePluginCode
    ),
  };
}

function parseConfigImport(text, currentSettings) {
  let raw;
  try {
    raw = JSON.parse(String(text || ''));
  } catch (error) {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置内容格式不正确');
  }
  if (raw.format && raw.format !== CONFIG_FORMAT) {
    throw new Error('不是 WebDAVrSync 配置文件（format=' + raw.format + '）');
  }
  if (
    raw.formatVersion !== undefined &&
    Number.isFinite(Number(raw.formatVersion)) &&
    Number(raw.formatVersion) > CONFIG_FORMAT_VERSION
  ) {
    throw new Error(
      '配置格式版本过新（' +
        raw.formatVersion +
        '），请升级 WebDAVrSync 后再导入'
    );
  }

  const rawSettings =
    raw.settings && typeof raw.settings === 'object' ? raw.settings : raw;
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    throw new Error('配置中缺少 settings');
  }

  const hasPasswordField = Object.prototype.hasOwnProperty.call(rawSettings, 'password');
  let passwordIncluded;
  if (raw.passwordIncluded === false) passwordIncluded = false;
  else if (raw.passwordIncluded === true) passwordIncluded = true;
  else passwordIncluded = hasPasswordField;

  const base =
    currentSettings && typeof currentSettings === 'object'
      ? currentSettings
      : DEFAULT_SETTINGS;
  const merged = Object.assign({}, base, rawSettings);
  if (!passwordIncluded) merged.password = base.password || '';

  const settings = normalizeSettings(merged);
  if (!settings.serverUrl) {
    throw new Error('配置中没有 WebDAV 地址');
  }

  return {
    settings,
    passwordIncluded,
    pluginVersion: String(raw.pluginVersion || ''),
    exportedAt: String(raw.exportedAt || ''),
    format: String(raw.format || ''),
  };
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function arrayBufferToBase64(value) {
  const bytes = toUint8Array(value);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value) {
  const text = String(value || '');
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(text, 'base64');
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function isBackupTextFile(path) {
  const lower = String(path || '').toLowerCase();
  return BACKUP_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(2) + ' MB';
}

function downloadTextFile(filename, text, mimeType) {
  try {
    if (
      typeof document === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return false;
    }
    const blob = new Blob([text], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        // Ignore cleanup failure.
      }
    }, 10000);
    return true;
  } catch (error) {
    console.error('[WebDAVrSync] 下载文件失败', error);
    return false;
  }
}

function readFileText(file) {
  if (file && typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

async function ensureAdapterDir(adapter, path) {
  const dir = normalizeRelPath(path);
  if (!dir) return;
  const parts = dir.split('/');
  let current = '';
  for (const segment of parts) {
    current = current ? current + '/' + segment : segment;
    if (!(await adapter.exists(current))) {
      try {
        await adapter.mkdir(current);
      } catch (error) {
        if (!(await adapter.exists(current))) throw error;
      }
    }
  }
}

async function readAdapterText(adapter, path) {
  try {
    const data = await adapter.readBinary(path);
    return new TextDecoder().decode(data);
  } catch (error) {
    return null;
  }
}

async function readAdapterBinary(adapter, path) {
  try {
    return await adapter.readBinary(path);
  } catch (error) {
    return null;
  }
}

const SECRET_FIELD_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|passwd|password|credential|license[_-]?key|webhook)/i;

function scanSecretFields(value, pluginId, prefix, out, depth) {
  if (!out || out.length >= 500 || depth > 10) return;
  if (Array.isArray(value)) {
    const count = Math.min(value.length, 200);
    for (let i = 0; i < count; i++) {
      scanSecretFields(value[i], pluginId, prefix + '[' + i + ']', out, depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const path = prefix ? prefix + '.' + key : key;
      scanSecretFields(value[key], pluginId, path, out, depth + 1);
    }
    return;
  }
  if (typeof value === 'string' && value.length > 0 && SECRET_FIELD_PATTERN.test(prefix)) {
    out.push({
      plugin: pluginId,
      path: prefix,
      kind: /keychain/i.test(prefix) ? 'keychain-ref' : 'plaintext',
      length: value.length,
    });
  }
}

const LEGACY_COPILOT_SECRET_FIELDS = [
  'openAIApiKey',
  'openAIOrgId',
  'huggingfaceApiKey',
  'cohereApiKey',
  'anthropicApiKey',
  'googleApiKey',
  'openRouterAiApiKey',
  'xaiApiKey',
  'mistralApiKey',
  'deepseekApiKey',
  'siliconflowApiKey',
  'groqApiKey',
  'firecrawlApiKey',
  'perplexityApiKey',
  'parallelApiKey',
  'exaApiKey',
  'supadataApiKey',
  'plusLicenseKey',
  'entitlementToken',
];

function legacyCopilotSecretId(vaultId, field) {
  if (!vaultId) return null;
  const normalized = String(field)
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
  const id = 'copilot-v' + vaultId + '-' + normalized;
  return id.length <= 64 ? id : null;
}

function getWebCrypto() {
  const webCrypto =
    typeof globalThis !== 'undefined' && globalThis.crypto
      ? globalThis.crypto
      : null;
  if (!webCrypto || !webCrypto.subtle) {
    throw new Error('当前环境不支持 WebCrypto，无法加密备份');
  }
  return webCrypto;
}

async function deriveBackupKey(password, salt, iterations) {
  const webCrypto = getWebCrypto();
  const material = await webCrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await webCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBackupBundle(bundle, password, options) {
  const passphrase = String(password || '');
  if (passphrase.trim().length < 8) {
    throw new Error('备份密码至少 8 个字符');
  }
  const opts = options || {};
  const iterations = Number(opts.iterations) || BACKUP_KDF_ITERATIONS;
  const webCrypto = getWebCrypto();
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = await webCrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  return {
    format: BACKUP_FILE_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    pluginVersion: bundle.pluginVersion || PLUGIN_VERSION_FALLBACK,
    createdAt: new Date().toISOString(),
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

async function decryptBackupBundle(envelope, password) {
  if (!envelope || envelope.format !== BACKUP_FILE_FORMAT) {
    throw new Error('不是 WebDAVrSync 加密备份文件');
  }
  if (
    envelope.formatVersion !== undefined &&
    Number(envelope.formatVersion) > BACKUP_FORMAT_VERSION
  ) {
    throw new Error('备份文件版本过新，请升级 WebDAVrSync');
  }
  const iterations = Number(envelope.iterations);
  if (!Number.isFinite(iterations) || iterations < 10000 || iterations > 2000000) {
    throw new Error('备份文件的密钥派生参数异常');
  }
  if (!envelope.salt || !envelope.iv || !envelope.ciphertext) {
    throw new Error('备份文件缺少加密参数');
  }

  const webCrypto = getWebCrypto();
  const salt = new Uint8Array(base64ToArrayBuffer(envelope.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(envelope.iv));
  const ciphertext = base64ToArrayBuffer(envelope.ciphertext);
  const key = await deriveBackupKey(String(password || ''), salt, iterations);
  let plaintext;
  try {
    plaintext = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch (error) {
    throw new Error('密码错误或备份文件已损坏');
  }

  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw new Error('备份内容不是有效 JSON');
  }
  if (!bundle || bundle.format !== BACKUP_FORMAT) {
    throw new Error('备份内容格式不正确');
  }
  if (
    bundle.formatVersion !== undefined &&
    Number(bundle.formatVersion) > BACKUP_FORMAT_VERSION
  ) {
    throw new Error('备份内容版本过新，请升级插件');
  }
  return bundle;
}

function formatSummary(summary) {
  const parts = [];
  if (summary.uploaded) parts.push('↑' + summary.uploaded);
  if (summary.downloaded) parts.push('↓' + summary.downloaded);
  if (summary.dirsCreated) parts.push('建目录 ' + summary.dirsCreated);
  if (summary.deletedRemote) parts.push('远端删除 ' + summary.deletedRemote);
  if (summary.deletedLocal) parts.push('本地删除 ' + summary.deletedLocal);
  if (summary.conflicts) parts.push('冲突 ' + summary.conflicts);
  if (summary.skipped) parts.push('跳过 ' + summary.skipped);
  if (summary.errors && summary.errors.length) parts.push('错误 ' + summary.errors.length);
  if (!parts.length) return '已是最新';
  const seconds = Math.max(0, Math.round((summary.durationMs || 0) / 100) / 10);
  return parts.join('，') + (seconds ? '，' + seconds + 's' : '');
}

class DavError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'DavError';
    this.status = status || 0;
    this.path = path || '';
  }
}

class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipError';
  }
}

// ---------------------------------------------------------------------------
// WebDAV client
// ---------------------------------------------------------------------------

class WebDAVClient {
  constructor(settings) {
    let serverUrl = String(settings.serverUrl || '').trim().replace(/\/+$/, '');
    if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
      serverUrl = 'http://' + serverUrl;
    }
    this.baseUrl = serverUrl;
    this.username = String(settings.username || '');
    this.password = String(settings.password || '');
    this.remoteRoot = normalizeRemoteRoot(settings.remoteRoot);
    this.dirCache = new Set();
    this.mkcolPromises = new Map();
  }

  authHeaders() {
    if (!this.username && !this.password) return {};
    return {
      Authorization: 'Basic ' + base64Utf8(this.username + ':' + this.password),
    };
  }

  urlFor(path, isDir, absolute) {
    const rel = normalizeRelPath(path);
    const full = absolute
      ? rel
      : [this.remoteRoot, rel].filter(Boolean).join('/');
    const encoded = full
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    let url = this.baseUrl + '/' + encoded;
    if (!full) url = this.baseUrl + '/';
    if (isDir && !url.endsWith('/')) url += '/';
    return url;
  }

  async request(method, path, options) {
    const opts = options || {};
    const headers = Object.assign({}, this.authHeaders(), opts.headers || {});
    if (opts.depth !== undefined) headers.Depth = String(opts.depth);

    const requestUrlValue = this.urlFor(path, !!opts.isDir, !!opts.absolute);
    let response;
    try {
      response = await requestUrl({
        url: requestUrlValue,
        method,
        headers,
        contentType: headers['Content-Type'],
        body: opts.body,
        throw: false,
      });
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      throw new DavError(
        '无法连接 WebDAV：' +
          safeDecodeUri(requestUrlValue) +
          '（' +
          reason +
          '）。请检查地址/端口、SFTPGo 的 WebDAV 是否已映射到宿主机，以及防火墙。',
        0,
        path
      );
    }

    const allowed = opts.allowStatuses;
    const ok = allowed
      ? allowed.indexOf(response.status) >= 0
      : response.status >= 200 && response.status < 300;

    if (!ok) {
      let message;
      if (response.status === 401) {
        message = '认证失败（HTTP 401）：请检查用户名和密码';
      } else if (response.status === 403) {
        message = '没有权限（HTTP 403）：请检查 WebDAV 账号权限';
      } else if (response.status === 404) {
        message = '远端路径不存在（HTTP 404）：' + (path || '/');
      } else if (response.status === 507) {
        message = '远端存储空间不足（HTTP 507）';
      } else {
        message = 'WebDAV ' + method + ' ' + (path || '/') + ' 失败：HTTP ' + response.status;
      }
      throw new DavError(message, response.status, path);
    }

    return response;
  }

  hrefToRelPath(href) {
    let raw = String(href || '').trim();
    if (!raw) return null;
    let pathname;
    if (/^https?:\/\//i.test(raw)) {
      try {
        pathname = new URL(raw).pathname;
      } catch (e) {
        pathname = raw;
      }
    } else {
      pathname = raw.split('#')[0].split('?')[0];
    }

    let decoded = safeDecodeUri(pathname);
    let basePath = '/';
    try {
      basePath = safeDecodeUri(new URL(this.baseUrl).pathname || '/');
    } catch (e) {
      basePath = '/';
    }
    let prefix = basePath.replace(/\/+$/, '');
    if (this.remoteRoot) prefix += '/' + this.remoteRoot;

    let rel;
    if (!prefix || prefix === '/') {
      rel = decoded;
    } else if (decoded === prefix || decoded === prefix + '/') {
      rel = '';
    } else if (decoded.indexOf(prefix + '/') === 0) {
      rel = decoded.slice(prefix.length + 1);
    } else {
      const marker = '/' + this.remoteRoot + '/';
      const markerIndex = this.remoteRoot ? decoded.indexOf(marker) : -1;
      if (markerIndex >= 0) {
        rel = decoded.slice(markerIndex + marker.length);
      } else if (this.remoteRoot && decoded.endsWith('/' + this.remoteRoot)) {
        rel = '';
      } else {
        rel = decoded;
      }
    }
    return normalizeRelPath(rel);
  }

  parseMultiStatus(xml) {
    const entries = [];
    const responseRe =
      /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
    let match;
    while ((match = responseRe.exec(String(xml || '')))) {
      const body = match[1];
      const href = firstTagText(body, 'href');
      if (!href) continue;
      const path = this.hrefToRelPath(href);
      if (path === null) continue;
      const isDir = /<(?:[\w.-]+:)?collection\b/i.test(body);
      const sizeText = firstTagText(body, 'getcontentlength');
      const size = Number.parseInt(sizeText || '0', 10);
      const mtimeText = firstTagText(body, 'getlastmodified');
      const mtime = mtimeText ? Date.parse(mtimeText) : 0;
      const etag = firstTagText(body, 'getetag') || '';
      entries.push({
        path,
        isDir,
        size: Number.isFinite(size) ? size : 0,
        mtime: Number.isFinite(mtime) ? mtime : 0,
        etag,
      });
    }
    return entries;
  }

  async propfind(path, depth, isDir) {
    const response = await this.request('PROPFIND', path, {
      isDir: isDir !== false,
      depth: depth === undefined ? 1 : depth,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml, text/xml, */*',
      },
      body: MULTISTATUS_BODY,
      allowStatuses: [200, 207],
    });
    return this.parseMultiStatus(response.text);
  }

  async list(path) {
    const dir = normalizeRelPath(path);
    const entries = await this.propfind(dir, 1);
    const out = [];
    for (const entry of entries) {
      if (entry.path === dir) continue;
      if (entry.isDir) this.dirCache.add(entry.path);
      out.push(entry);
    }
    this.dirCache.add(dir);
    return out;
  }

  async stat(path) {
    const wanted = normalizeRelPath(path);
    let entries;
    try {
      entries = await this.propfind(wanted, 0, false);
    } catch (error) {
      // Directories are sometimes only accessible with a trailing slash.
      if (error && (error.status === 301 || error.status === 404)) {
        entries = await this.propfind(wanted, 0, true);
      } else {
        throw error;
      }
    }
    let entry = entries.find((item) => item.path === wanted);
    if (!entry) entry = entries[0];
    if (!entry) throw new DavError('PROPFIND 未返回有效结果：' + (path || '/'), 0, path);
    if (entry.isDir) this.dirCache.add(entry.path);
    return entry;
  }

  async ensureRoot() {
    try {
      return await this.stat('');
    } catch (error) {
      if (!error || error.status !== 404) throw error;
      if (!this.remoteRoot) {
        throw new DavError(
          'WebDAV 根地址不可访问（HTTP 404）：' + this.baseUrl + '/',
          404,
          ''
        );
      }
      let current = '';
      for (const segment of this.remoteRoot.split('/')) {
        current = current ? current + '/' + segment : segment;
        try {
          await this.mkcol(current, true);
        } catch (mkdirError) {
          if (!mkdirError || mkdirError.status !== 405) throw mkdirError;
        }
      }
      return await this.stat('');
    }
  }

  async mkcol(dir, absolute) {
    const path = normalizeRelPath(dir);
    const cacheKey = (absolute ? 'abs:' : 'rel:') + path;
    if (!absolute && this.dirCache.has(path)) return;
    if (this.mkcolPromises.has(cacheKey)) return this.mkcolPromises.get(cacheKey);

    const promise = (async () => {
      const response = await this.request('MKCOL', path, {
        isDir: true,
        absolute: !!absolute,
        allowStatuses: [200, 201, 204, 301, 405],
      });
      if (!absolute && response.status !== 405) this.dirCache.add(path);
    })();

    this.mkcolPromises.set(cacheKey, promise);
    try {
      await promise;
    } finally {
      this.mkcolPromises.delete(cacheKey);
    }
  }

  async ensureDir(dir) {
    const normalized = normalizeRelPath(dir);
    if (!normalized) return;
    let current = '';
    for (const segment of normalized.split('/')) {
      current = current ? current + '/' + segment : segment;
      if (!this.dirCache.has(current)) await this.mkcol(current);
    }
  }

  async ensureParents(path) {
    const parts = normalizeRelPath(path).split('/');
    parts.pop();
    await this.ensureDir(parts.join('/'));
  }

  async put(path, data) {
    return this.request('PUT', path, {
      body: data,
      headers: { 'Content-Type': 'application/octet-stream' },
      allowStatuses: [200, 201, 204],
    });
  }

  async get(path) {
    const response = await this.request('GET', path, {
      allowStatuses: [200],
    });
    return response.arrayBuffer;
  }

  async deleteFile(path) {
    return this.request('DELETE', path, {
      allowStatuses: [200, 202, 204, 404],
    });
  }

  async test() {
    const started = Date.now();
    const entry = await this.ensureRoot();
    return {
      ms: Date.now() - started,
      entry,
      rootUrl: this.urlFor('', true),
    };
  }

  async listAll(options) {
    const opts = options || {};
    const skipDir = opts.skipDir || (() => false);
    const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
    const result = new Map();
    const queue = [''];
    const seen = new Set(['']);

    while (queue.length) {
      const batch = queue.splice(0, concurrency);
      await Promise.all(
        batch.map(async (dir) => {
          let entries;
          try {
            entries = await this.list(dir);
          } catch (error) {
            if (error && error.status === 404 && dir === '') {
              await this.ensureRoot();
              entries = await this.list('');
            } else {
              throw error;
            }
          }
          for (const entry of entries) {
            if (entry.path === dir) continue;
            result.set(entry.path, entry);
            if (entry.isDir && !seen.has(entry.path) && !skipDir(entry.path)) {
              seen.add(entry.path);
              queue.push(entry.path);
            }
          }
        })
      );
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Synchronization engine
// ---------------------------------------------------------------------------

class SyncEngine {
  constructor(options) {
    this.adapter = options.adapter;
    this.client = options.client;
    this.settings = options.settings;
    this.state = options.state;
    this.onProgress = options.onProgress || (() => {});
    this.onPersist = options.onPersist || (async () => {});
    this.onLocalWrite = options.onLocalWrite || (() => {});
    this.trashLocal = options.trashLocal || ((path) => this.adapter.remove(path));
    this.log = options.log || (() => {});
    this.isIgnored = compileIgnore(options.settings);
    // 回收站存档模式：syncTrash 开启时，.trash 只增不删。
    // 清空本地回收站不会删掉远端备份，远端缺失时反而会用本地补回去。
    this.trashArchive = options.settings.syncTrash !== false;
    this.trashKept = 0;
    this.isAliasPath = () => false;
    this.localAliasDirs = new Set();
    this.localDirs = new Set();
    this.localEmptyDirs = new Set();
    this.remote = new Map();
    this.summary = {
      uploaded: 0,
      downloaded: 0,
      dirsCreated: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };
  }

  async run() {
    const started = Date.now();
    this.trashKept = 0;
    // Use a null-prototype map so a vault file literally named "__proto__"
    // cannot mutate the state object's prototype.
    const safeFiles = Object.create(null);
    if (this.state.files && typeof this.state.files === 'object') {
      for (const key of Object.keys(this.state.files)) safeFiles[key] = this.state.files[key];
    }
    this.state.files = safeFiles;
    await this.client.ensureRoot();

    this.onProgress(0, 0, '正在扫描本地文件…');
    const local = await this.listLocal();

    this.onProgress(0, 0, '正在扫描远端文件…');
    const remoteAll = await this.client.listAll({
      skipDir: (path) => this.isIgnored(path),
      concurrency: 4,
    });

    const aliasDirs = this.localAliasDirs || new Set();

    // 远端目录索引。本地把某个路径当成“文件”，而远端同路径是目录，
    // 说明本地这一项其实是目录软链接（别名）：它不是真实文件，无法同步。
    // 标记出来：不上传、不下载，并清理远端对应的历史残留。
    const remoteDirs = new Set();
    for (const [path, entry] of remoteAll) {
      if (entry.isDir) remoteDirs.add(path);
    }
    for (const path of Array.from(local.keys())) {
      if (remoteDirs.has(path)) {
        local.delete(path);
        aliasDirs.add(path);
        this.log('检测到目录软链接，跳过：' + path);
      }
    }

    const isAliasPath = (path) => {
      if (!aliasDirs.size) return false;
      if (aliasDirs.has(path)) return true;
      for (const dir of aliasDirs) {
        if (path.startsWith(dir + '/')) return true;
      }
      return false;
    };
    this.isAliasPath = isAliasPath;

    this.remote = new Map();
    for (const [path, entry] of remoteAll) {
      if (entry.isDir || this.isIgnored(path)) continue;
      if (isAliasPath(path)) continue;
      this.remote.set(path, entry);
    }

    // 让 WebDAV 上的目录结构与本地仓库保持一致（含空目录）
    if (this.settings.syncEmptyDirs !== false) {
      const dirs = this.localDirs || new Set();
      for (const dir of dirs) {
        if (!dir || this.isIgnored(dir)) continue;
        if (this.client.dirCache.has(dir)) continue;
        try {
          await this.client.ensureDir(dir);
          this.summary.dirsCreated++;
        } catch (error) {
          this.summary.errors.push({
            path: dir,
            message:
              '创建远端目录失败：' +
              (error && error.message ? error.message : String(error)),
          });
        }
      }
    }

    // Drop state for paths that are now ignored.
    for (const path of Object.keys(this.state.files || {})) {
      if (this.isIgnored(path)) delete this.state.files[path];
    }

    const allPaths = new Set();
    for (const path of local.keys()) allPaths.add(path);
    for (const path of this.remote.keys()) allPaths.add(path);
    for (const path of Object.keys(this.state.files || {})) allPaths.add(path);
    const paths = Array.from(allPaths).sort();

    let done = 0;
    for (const path of paths) {
      done++;
      this.onProgress(done, paths.length, path);
      try {
        await this.syncOne(path, local.get(path) || null, this.remote.get(path) || null);
      } catch (error) {
        if (
          error &&
          (error.status === 0 ||
            error.status === 401 ||
            error.status === 403 ||
            error.status === 507)
        ) {
          error.fatal = true;
          throw error;
        }
        if (error instanceof SkipError) {
          this.summary.skipped++;
          this.log('跳过 ' + path + '：' + error.message);
        } else {
          this.summary.errors.push({
            path,
            message: error && error.message ? error.message : String(error),
          });
          this.log('错误 ' + path + '：' + (error && error.stack ? error.stack : error));
        }
      }
      if (done % 100 === 0) await this.onPersist();
    }

    // 符号链接目录：本地没有可同步的真实文件，远端同名内容无法维护。
    // 只跳过并清掉状态记录，不删除远端文件——本地通过软链接仍能访问这些内容，
    // 自动删掉等于把备份里的内容弄丢。
    if (aliasDirs.size) {
      for (const [path, entry] of remoteAll) {
        if (entry.isDir || this.isIgnored(path)) continue;
        if (!isAliasPath(path)) continue;
        delete this.state.files[path];
      }
      for (const dir of aliasDirs) {
        this.log('已跳过目录软链接（远端同名副本保持原样）：' + dir);
      }
    }

    if (this.trashKept > 0) {
      this.log(
        '回收站存档：' + this.trashKept + ' 个远端副本按“只增不删”保留（本地已清空）'
      );
    }

    this.state.version = STATE_VERSION;
    this.state.lastSync = Date.now();
    await this.onPersist();
    this.summary.durationMs = Date.now() - started;
    return this.summary;
  }

  async listLocal() {
    const files = new Map();
    const directories = [''];
    const allFiles = [];
    const allDirs = new Set();
    const rawFiles = [];
    const aliasDirs = new Set();

    this.localAliasDirs = aliasDirs;
    this.localDirs = allDirs;

    while (directories.length) {
      const dir = directories.pop();
      let listing;
      try {
        listing = await this.adapter.list(dir);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (/ENOENT|no such file|not found/i.test(message)) continue;
        // Never continue silently: a partial local scan could be mistaken for
        // local deletions and would then delete remote files.
        throw new Error('无法读取本地目录 ' + (dir || '/') + '：' + message);
      }
      for (const folder of listing.folders || []) {
        allDirs.add(folder);
        if (!this.isIgnored(folder)) directories.push(folder);
      }
      for (const file of listing.files || []) {
        rawFiles.push(file);
        if (!this.isIgnored(file)) allFiles.push(file);
      }
    }

    const concurrency = 8;
    let cursor = 0;
    const worker = async () => {
      while (cursor < allFiles.length) {
        const index = cursor++;
        const file = allFiles[index];
        try {
          const stat = await this.adapter.stat(file);
          if (stat && stat.type === 'folder') {
            // 目录软链接（例如 .opencode/skills/* -> copilot/skills/*）：
            // 本地这一项不是一个真实文件，无法单独同步。记为别名目录，
            // 远端同名内容属于历史残留，由清理流程处理。
            aliasDirs.add(file);
            continue;
          }
          files.set(file, {
            path: file,
            size: Number(stat && stat.size) || 0,
            mtime: Number(stat && stat.mtime) || 0,
          });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          if (/ENOENT|no such file|not found/i.test(message)) continue;
          if (/EISDIR|is a directory/i.test(message)) {
            aliasDirs.add(file);
            continue;
          }
          throw new Error('无法读取本地文件信息 ' + file + '：' + message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, allFiles.length || 1) }, () => worker())
    );

    // 目录里只放着被忽略的文件时不算“空目录”，
    // 否则 .obsidian/plugins/webdavrsync 这类目录会被创建到远端。
    const dirsWithFiles = new Set();
    for (const file of rawFiles) {
      const parts = file.split('/');
      parts.pop();
      let current = '';
      for (const part of parts) {
        current = current ? current + '/' + part : part;
        dirsWithFiles.add(current);
      }
    }
    this.localEmptyDirs = new Set();
    for (const dir of allDirs) {
      if (!dirsWithFiles.has(dir) && !this.isIgnored(dir)) this.localEmptyDirs.add(dir);
    }

    return files;
  }

  async readLocalFile(path) {
    try {
      return await this.adapter.readBinary(path);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      // 某些平台的 stat 会把目录软链接当成普通文件，这里读文件时才会暴露出来。
      if (/EISDIR|is a directory/i.test(message)) {
        if (this.localAliasDirs) this.localAliasDirs.add(path);
        throw new SkipError('本地是目录软链接，跳过上传');
      }
      throw error;
    }
  }

  async safeStat(path) {
    try {
      return await this.adapter.stat(path);
    } catch (error) {
      return null;
    }
  }

  localChanged(localEntry, stateEntry) {
    if (!stateEntry) return true;
    if (!localEntry) return true;
    return (
      normalizeMtime(localEntry.mtime) !== normalizeMtime(stateEntry.localMtime) ||
      Number(localEntry.size) !== Number(stateEntry.localSize)
    );
  }

  remoteChanged(remoteEntry, stateEntry) {
    if (!stateEntry) return true;
    if (!remoteEntry) return true;
    if (Number(remoteEntry.size) !== Number(stateEntry.remoteSize)) return true;
    const currentEtag = normalizeEtag(remoteEntry.etag);
    const savedEtag = normalizeEtag(stateEntry.remoteEtag);
    if (currentEtag && savedEtag && currentEtag !== savedEtag) return true;
    const currentMtime = Number(remoteEntry.mtime) || 0;
    const savedMtime = Number(stateEntry.remoteMtime) || 0;
    if (currentMtime && savedMtime && Math.abs(currentMtime - savedMtime) > 1500) {
      return true;
    }
    return false;
  }

  markSynced(path, localEntry, remoteEntry) {
    if (!this.state.files) this.state.files = {};
    this.state.files[normalizeRelPath(path)] = {
      localMtime: normalizeMtime(localEntry && localEntry.mtime),
      localSize: Number(localEntry && localEntry.size) || 0,
      remoteMtime: Number(remoteEntry && remoteEntry.mtime) || 0,
      remoteSize: Number(remoteEntry && remoteEntry.size) || 0,
      remoteEtag: (remoteEntry && remoteEntry.etag) || '',
      syncedAt: Date.now(),
    };
  }

  async syncOne(path, localEntry, remoteEntry) {
    if (this.isAliasPath && this.isAliasPath(path)) {
      this.summary.skipped++;
      return;
    }
    const stateEntry = this.state.files ? this.state.files[path] : null;

    if (!localEntry && !remoteEntry) {
      if (stateEntry) delete this.state.files[path];
      return;
    }

    // 回收站存档模式（syncTrash 开启时）：.trash 只增不删。
    // 本地清空回收站 → 远端备份保留；远端缺了 → 用本地补回去。
    if (this.trashArchive && isTrashPath(path)) {
      if (!localEntry && remoteEntry) {
        if (!stateEntry) {
          // 另一台设备新放进回收站的文件，照常下载
          await this.download(path, remoteEntry, null, null);
        } else {
          // 本地已清空：远端副本保留，也不把它当成新文件重新拉回本地
          this.trashKept++;
        }
        return;
      }
      if (localEntry && !remoteEntry) {
        this.log('回收站存档：从本地补回远端副本 ' + path);
        await this.upload(path, localEntry);
        return;
      }
    }

    if (localEntry && remoteEntry) {
      if (!stateEntry) {
        await this.mergeUntracked(path, localEntry, remoteEntry);
        return;
      }
      const localDirty = this.localChanged(localEntry, stateEntry);
      const remoteDirty = this.remoteChanged(remoteEntry, stateEntry);
      if (!localDirty && !remoteDirty) return;
      if (localDirty && !remoteDirty) {
        await this.upload(path, localEntry, remoteEntry);
        return;
      }
      if (!localDirty && remoteDirty) {
        await this.download(path, remoteEntry, stateEntry, localEntry);
        return;
      }
      await this.handleConflict(path, localEntry, remoteEntry, stateEntry);
      return;
    }

    if (!localEntry && remoteEntry) {
      if (!stateEntry) {
        await this.download(path, remoteEntry, null, null);
        return;
      }
      if (this.remoteChanged(remoteEntry, stateEntry)) {
        this.log('本地已删除但远端有更新，恢复远端文件：' + path);
        await this.download(path, remoteEntry, null, null);
      } else if (this.settings.allowDeletions) {
        await this.deleteRemote(path, stateEntry);
      } else {
        this.log('删除同步已关闭，恢复远端文件：' + path);
        await this.download(path, remoteEntry, null, null);
      }
      return;
    }

    if (localEntry && !remoteEntry) {
      if (!stateEntry) {
        await this.upload(path, localEntry);
        return;
      }
      if (this.localChanged(localEntry, stateEntry)) {
        this.log('远端已删除但本地有更新，重新上传：' + path);
        await this.upload(path, localEntry);
      } else if (this.settings.allowDeletions) {
        await this.deleteLocal(path, stateEntry, localEntry);
      } else {
        this.log('删除同步已关闭，重新上传本地文件：' + path);
        await this.upload(path, localEntry);
      }
    }
  }

  async mergeUntracked(path, localEntry, remoteEntry) {
    if (Number(localEntry.size) === Number(remoteEntry.size)) {
      if (!this.settings.verifyContent || Number(localEntry.size) === 0) {
        this.markSynced(path, localEntry, remoteEntry);
        return;
      }
      let remoteData;
      try {
        remoteData = await this.client.get(path);
      } catch (error) {
        if (error && error.status === 404) {
          throw new SkipError('远端文件在合并过程中被删除');
        }
        throw error;
      }
      const localData = await this.adapter.readBinary(path);
      if (equalBytes(localData, remoteData)) {
        this.markSynced(path, localEntry, remoteEntry);
        return;
      }
    }
    await this.handleConflict(path, localEntry, remoteEntry, null);
  }

  async handleConflict(path, localEntry, remoteEntry, stateEntry) {
    this.summary.conflicts++;
    const localWins = Number(localEntry.mtime) >= Number(remoteEntry.mtime);
    this.log('检测到冲突：' + path + '（' + (localWins ? '本地较新' : '远端较新') + '）');

    if (this.settings.conflictStrategy === 'newest') {
      if (localWins) {
        await this.upload(path, localEntry, remoteEntry);
      } else {
        await this.download(path, remoteEntry, stateEntry, localEntry);
      }
      return;
    }

    let remoteData = null;
    if (Number(localEntry.size) === Number(remoteEntry.size)) {
      remoteData = await this.client.get(path);
      const localData = await this.adapter.readBinary(path);
      if (equalBytes(localData, remoteData)) {
        this.summary.conflicts--;
        this.markSynced(path, localEntry, remoteEntry);
        return;
      }
    }

    const conflictPath = await this.uniqueConflictPath(path);

    if (localWins) {
      if (!remoteData) remoteData = await this.client.get(path);
      await this.writeLocal(conflictPath, remoteData);
      const conflictLocal = await this.safeStat(conflictPath);
      const conflictRemote = await this.putData(conflictPath, remoteData);
      this.markSynced(conflictPath, conflictLocal, conflictRemote);
      this.summary.uploaded++;
      await this.upload(path, localEntry, remoteEntry);
    } else {
      const localData = await this.adapter.readBinary(path);
      await this.writeLocal(conflictPath, localData);
      const conflictLocal = await this.safeStat(conflictPath);
      const conflictRemote = await this.putData(conflictPath, localData);
      this.markSynced(conflictPath, conflictLocal, conflictRemote);
      this.summary.uploaded++;
      await this.download(path, remoteEntry, stateEntry, localEntry);
    }
    this.log('冲突已保留双方：' + path + ' ↔ ' + conflictPath);
  }

  async upload(path, localEntry, remoteEntry) {
    if (remoteEntry) {
      let latest;
      try {
        latest = await this.client.stat(path);
      } catch (error) {
        if (error && error.status === 404) {
          throw new SkipError('远端文件在同步过程中被删除');
        }
        throw error;
      }
      if (
        this.remoteChanged(latest, {
          remoteSize: remoteEntry.size,
          remoteMtime: remoteEntry.mtime,
          remoteEtag: remoteEntry.etag,
        })
      ) {
        throw new SkipError('远端文件在同步过程中发生变化，留待下次同步处理');
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.safeStat(path);
      if (!before) throw new SkipError('本地文件已不存在');

      const data = await this.readLocalFile(path);
      const after = await this.safeStat(path);
      if (!after) throw new SkipError('本地文件在读取过程中被删除');
      if (
        normalizeMtime(after.mtime) !== normalizeMtime(before.mtime) ||
        Number(after.size) !== Number(before.size) ||
        Number(data.byteLength) !== Number(after.size)
      ) {
        lastError = new SkipError('本地文件在读取过程中发生变化，稍后重试');
        continue;
      }

      await this.client.ensureParents(path);
      await this.client.put(path, data);
      const remoteEntry = await this.statRemoteAfterWrite(path, data.byteLength);
      const currentLocal = { path, mtime: after.mtime, size: after.size };
      this.markSynced(path, currentLocal, remoteEntry);
      this.summary.uploaded++;
      return;
    }
    throw lastError || new SkipError('上传失败：文件持续发生变化');
  }

  async putData(path, data) {
    await this.client.ensureParents(path);
    await this.client.put(path, data);
    const entry = await this.statRemoteAfterWrite(path, data.byteLength);
    this.remote.set(path, entry);
    return entry;
  }

  async statRemoteAfterWrite(path, fallbackSize) {
    try {
      const entry = await this.client.stat(path);
      this.remote.set(path, entry);
      return entry;
    } catch (error) {
      this.log('上传成功但无法读取远端属性：' + path + '（' + error.message + '）');
      const fallback = {
        path,
        isDir: false,
        size: Number(fallbackSize) || 0,
        mtime: Date.now(),
        etag: '',
      };
      this.remote.set(path, fallback);
      return fallback;
    }
  }

  async download(path, remoteEntry, stateEntry, knownLocalEntry) {
    const current = await this.safeStat(path);
    if (current && stateEntry && this.localChanged(current, stateEntry)) {
      throw new SkipError('本地文件在同步过程中被修改');
    }
    if (current && !stateEntry && !knownLocalEntry) {
      throw new SkipError('本地出现了同名文件，留待下次同步处理');
    }

    const data = await this.client.get(path);
    if (
      Number(remoteEntry.size) > 0 &&
      Number(data.byteLength) !== Number(remoteEntry.size)
    ) {
      throw new SkipError('远端文件在下载过程中发生变化');
    }

    await this.writeLocal(path, data);
    const after = await this.safeStat(path);
    if (!after) throw new Error('写入后无法读取本地文件：' + path);
    this.markSynced(path, after, remoteEntry);
    this.summary.downloaded++;
  }

  async writeLocal(path, data) {
    await this.ensureLocalParents(path);
    const tmp = path + '.webdavrsync-tmp-' + Date.now() + '-' + randomSuffix();
    await this.adapter.writeBinary(tmp, data);
    try {
      await this.adapter.rename(tmp, path);
    } catch (error) {
      try {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
        await this.adapter.rename(tmp, path);
      } catch (renameError) {
        try {
          await this.adapter.remove(tmp);
        } catch (cleanupError) {
          // Ignore cleanup failure.
        }
        throw renameError;
      }
    }
    this.onLocalWrite(path);
  }

  async ensureLocalParents(path) {
    const parts = normalizeRelPath(path).split('/');
    parts.pop();
    let current = '';
    for (const segment of parts) {
      current = current ? current + '/' + segment : segment;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch (error) {
          if (!(await this.adapter.exists(current))) throw error;
        }
      }
    }
  }

  async deleteRemote(path, stateEntry) {
    // 本地仍然是“文件”时不能删远端；但如果本地这一项其实是个目录
    // （常见于目录软链接），远端同名文件就是无法同步的历史残留，可以清理。
    const localStat = await this.safeStat(path);
    if (localStat && localStat.type !== 'folder') {
      throw new SkipError('本地文件仍然存在，跳过远端删除');
    }
    let remoteStat = null;
    try {
      remoteStat = await this.client.stat(path);
    } catch (error) {
      if (!error || error.status !== 404) throw error;
    }
    if (!remoteStat) {
      this.remote.delete(path);
      delete this.state.files[path];
      this.summary.deletedRemote++;
      return;
    }
    if (remoteStat.isDir) {
      throw new SkipError('远端同路径是文件夹，跳过删除');
    }
    if (stateEntry && this.remoteChanged(remoteStat, stateEntry)) {
      throw new SkipError('远端文件在同步过程中发生变化，跳过删除');
    }
    await this.client.deleteFile(path);
    this.remote.delete(path);
    delete this.state.files[path];
    this.summary.deletedRemote++;
  }

  async deleteLocal(path, stateEntry, localEntry) {
    const current = await this.safeStat(path);
    if (!current) {
      delete this.state.files[path];
      return;
    }
    if (current.type === 'folder') {
      throw new SkipError('本地同路径是文件夹，跳过删除');
    }
    if (this.localChanged(current, stateEntry)) {
      throw new SkipError('本地文件在准备删除时发生变化');
    }
    let remoteStillExists = false;
    try {
      const remoteStat = await this.client.stat(path);
      remoteStillExists = !!(remoteStat && !remoteStat.isDir);
    } catch (error) {
      if (!error || error.status !== 404) throw error;
    }
    if (remoteStillExists) {
      throw new SkipError('远端文件仍然存在，跳过本地删除');
    }
    await this.trashLocal(path);
    delete this.state.files[path];
    this.summary.deletedLocal++;
  }

  async uniqueConflictPath(path) {
    const normalized = normalizeRelPath(path);
    const slash = normalized.lastIndexOf('/');
    const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
    const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const device = sanitizeFileNamePart(this.settings.deviceName);
    const stamp = timestampForName(new Date());

    let counter = 1;
    while (true) {
      const suffix = counter === 1 ? '' : ' ' + counter;
      const candidate =
        dir + base + ' (conflict ' + stamp + ' ' + device + suffix + ')' + ext;
      const existsLocal = await this.adapter.exists(candidate);
      if (!existsLocal && !this.remote.has(candidate) && !(this.state.files || {})[candidate]) {
        return candidate;
      }
      counter++;
      if (counter > 1000) throw new Error('无法生成冲突文件名：' + path);
    }
  }
}

// ---------------------------------------------------------------------------
// Obsidian plugin
// ---------------------------------------------------------------------------

class WebDAVrSyncPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = normalizeSettings(data.settings || {});
    this.ignoreFn = compileIgnore(this.settings);
    this.syncState = this.normalizeState(data.state);
    this.syncing = false;
    this.pendingChange = false;
    this.unloaded = false;
    this.recentWrites = new Map();
    this.lastBackup = null;
    this.intervalId = null;
    this.changeTimer = null;
    this.startupTimer = null;

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('webdavrsync-status');
    this.statusBarEl.style.cursor = 'pointer';
    this.statusBarEl.setAttribute('aria-label', 'WebDAVrSync：点击立即同步');
    this.statusBarEl.addEventListener('click', () => this.runSync(true));
    this.refreshStatus();

    this.addRibbonIcon('refresh-cw', 'WebDAVrSync：立即同步', () => this.runSync(true));

    this.addCommand({
      id: 'sync-now',
      name: '立即同步',
      callback: () => this.runSync(true),
    });

    this.addCommand({
      id: 'backup-now',
      name: '创建并上传加密备份',
      callback: () => this.createEncryptedBackup(),
    });
    this.addCommand({
      id: 'test-connection',
      name: '测试 WebDAV 连接',
      callback: () => this.testConnection(true),
    });

    this.addSettingTab(new WebDAVrSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('create', (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => this.onVaultChange(file))
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.configureInterval();
      if (this.settings.syncOnStart && this.settings.serverUrl) {
        this.startupTimer = window.setTimeout(() => {
          this.startupTimer = null;
          this.runSync(false);
        }, 4000);
      }
    });
  }

  onunload() {
    this.unloaded = true;
    if (this.intervalId) window.clearInterval(this.intervalId);
    if (this.changeTimer) window.clearTimeout(this.changeTimer);
    if (this.startupTimer) window.clearTimeout(this.startupTimer);
    this.intervalId = null;
    this.changeTimer = null;
    this.startupTimer = null;
    this.saveAll().catch(() => {});
  }

  normalizeState(state) {
    const next = state && typeof state === 'object' ? state : {};
    const files = Object.create(null);
    if (next.files && typeof next.files === 'object') {
      for (const key of Object.keys(next.files)) files[key] = next.files[key];
    }
    next.files = files;
    next.version = STATE_VERSION;
    next.lastSync = Number(next.lastSync) || 0;
    return next;
  }

  async saveAll() {
    try {
      await this.saveData({
        settings: this.settings,
        state: this.syncState,
      });
    } catch (error) {
      console.error('[WebDAVrSync] 保存设置失败', error);
    }
  }

  async saveSettings() {
    this.ignoreFn = compileIgnore(this.settings);
    await this.saveAll();
    this.configureInterval();
  }

  configureInterval() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const minutes = Math.max(0, Number(this.settings.syncIntervalMinutes) || 0);
    if (minutes > 0) {
      this.intervalId = window.setInterval(() => this.runSync(false), minutes * 60000);
    }
  }

  onVaultChange(file) {
    if (this.unloaded || !this.settings.syncOnChange) return;
    const path = file && file.path ? file.path : '';
    if (path && this.isRecentWrite(path)) return;
    if (path && this.ignoreFn && this.ignoreFn(path)) return;
    if (this.syncing) {
      this.pendingChange = true;
      return;
    }
    this.scheduleChangeSync(8000);
  }

  isRecentWrite(path) {
    const at = this.recentWrites.get(path);
    if (!at) return false;
    if (Date.now() - at > 5000) {
      this.recentWrites.delete(path);
      return false;
    }
    this.recentWrites.delete(path);
    return true;
  }

  scheduleChangeSync(delay) {
    if (this.changeTimer) window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = null;
      this.runSync(false);
    }, delay === undefined ? 8000 : delay);
  }

  async runSync(manual) {
    if (this.unloaded) return;
    if (this.syncing) {
      if (manual) new Notice('WebDAVrSync：同步正在进行中');
      return;
    }
    if (!String(this.settings.serverUrl || '').trim()) {
      if (manual) new Notice('WebDAVrSync：请先在设置中填写 WebDAV 地址');
      return;
    }

    this.syncing = true;
    this.refreshStatus('连接中…');

    try {
      const settingsSnapshot = Object.assign({}, this.settings);
      const client = new WebDAVClient(settingsSnapshot);
      const engine = new SyncEngine({
        adapter: this.app.vault.adapter,
        client,
        settings: settingsSnapshot,
        state: this.syncState,
        onProgress: (done, total, path) => {
          if (!total) {
            this.refreshStatus(path || '同步中…');
          } else {
            this.refreshStatus('同步中 ' + done + '/' + total);
          }
        },
        onPersist: () => this.saveAll(),
        onLocalWrite: (path) => this.recentWrites.set(path, Date.now()),
        trashLocal: (path) => this.trashLocal(path),
        log: (...args) => console.log('[WebDAVrSync]', ...args),
      });

      const summary = await engine.run();
      const message = formatSummary(summary);
      if (manual || summary.conflicts) {
        new Notice('WebDAVrSync：' + message, summary.errors.length ? 10000 : 5000);
      }
      if (summary.errors.length) {
        console.error('[WebDAVrSync] 同步错误', summary.errors);
      }
      this.lastSyncSummary = summary;
      this.refreshStatus(
        summary.errors.length ? '同步完成（有错误）' : '已同步 ' + timeForStatus(new Date()),
        message
      );
    } catch (error) {
      console.error('[WebDAVrSync]', error);
      const message = error && error.message ? error.message : String(error);
      if (manual) {
        new Notice('WebDAVrSync 同步失败：' + String(message).slice(0, 400), 10000);
      }
      this.refreshStatus('同步失败', message);
    } finally {
      this.syncing = false;
      await this.saveAll();
      if (this.pendingChange) {
        this.pendingChange = false;
        if (this.settings.syncOnChange) this.scheduleChangeSync(3000);
      }
    }
  }

  async trashLocal(path) {
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (abstractFile && abstractFile instanceof TFile) {
      try {
        await this.app.vault.trash(abstractFile, false);
        return;
      } catch (error) {
        console.warn('[WebDAVrSync] 移入回收站失败，改为直接删除：' + path, error);
      }
    }
    await this.app.vault.adapter.remove(path);
  }

  refreshStatus(text, tooltip) {
    if (!this.statusBarEl) return;
    if (text) {
      this.statusBarEl.setText('WebDAVrSync ' + text);
    } else if (this.syncState && this.syncState.lastSync) {
      this.statusBarEl.setText('WebDAVrSync ' + timeForStatus(new Date(this.syncState.lastSync)));
    } else {
      this.statusBarEl.setText('WebDAVrSync 待机');
    }
    this.statusBarEl.setAttribute('aria-label', tooltip || 'WebDAVrSync：点击立即同步');
  }

  describeState() {
    if (!this.syncState || !this.syncState.lastSync) return '尚未同步';
    const count = Object.keys(this.syncState.files || {}).length;
    return (
      '上次同步：' +
      new Date(this.syncState.lastSync).toLocaleString() +
      '；已记录 ' +
      count +
      ' 个文件'
    );
  }

  async testConnection(verbose) {
    if (!String(this.settings.serverUrl || '').trim()) {
      if (verbose) new Notice('WebDAVrSync：请先填写 WebDAV 地址');
      return { ok: false, message: '未填写 WebDAV 地址' };
    }
    try {
      const client = new WebDAVClient(this.settings);
      const result = await client.test();
      const message =
        '连接成功（' + result.ms + 'ms）：' + safeDecodeUri(result.rootUrl);
      if (verbose) new Notice('WebDAVrSync：' + message, 5000);
      return { ok: true, message, result };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (verbose) new Notice('WebDAVrSync 连接失败：' + message, 10000);
      return { ok: false, message };
    }
  }

  buildConfigExport(includePassword) {
    const settings = Object.assign({}, this.settings);
    settings.password = includePassword ? String(this.settings.password || '') : '';
    return {
      format: CONFIG_FORMAT,
      formatVersion: CONFIG_FORMAT_VERSION,
      pluginVersion:
        this.manifest && this.manifest.version
          ? this.manifest.version
          : PLUGIN_VERSION_FALLBACK,
      exportedAt: new Date().toISOString(),
      passwordIncluded: !!includePassword,
      settings,
    };
  }

  async exportConfigFile(includePassword) {
    try {
      const payload = this.buildConfigExport(includePassword);
      const text = JSON.stringify(payload, null, 2);
      const filename =
        'webdavrsync-config-' +
        timestampForName(new Date()) +
        (includePassword ? '-with-password' : '') +
        '.json';

      if (
        typeof document !== 'undefined' &&
        typeof Blob !== 'undefined' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch (error) {
            // Ignore cleanup failure.
          }
        }, 10000);
        new Notice(
          'WebDAVrSync：配置已导出为 ' + filename +
            (includePassword ? '（含明文密码，请妥善保管）' : ''),
          7000
        );
        return payload;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice('WebDAVrSync：当前环境不能直接下载文件，配置已复制到剪贴板', 7000);
        return payload;
      }

      throw new Error('当前环境不支持文件下载或剪贴板');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      new Notice('WebDAVrSync：导出配置失败 - ' + message, 10000);
      console.error('[WebDAVrSync] 导出配置失败', error);
      return null;
    }
  }

  pickConfigFile(onDone) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('cancel', () => input.remove());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        if (file.size > 2 * 1024 * 1024) {
          throw new Error('配置文件大于 2MB，可能不是配置 JSON');
        }
        const text = await readFileText(file);
        const result = await this.importConfigFromText(text);
        if (onDone) onDone(result);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        new Notice('WebDAVrSync：导入配置失败 - ' + message, 10000);
        console.error('[WebDAVrSync] 导入配置失败', error);
        if (onDone) onDone({ ok: false, error: message });
      }
    });

    input.click();
  }

  async importConfigFromText(text) {
    const imported = parseConfigImport(text, this.settings);
    return await this.applyConfigImport(imported);
  }

  async applyConfigImport(imported, options) {
    const opts = options || {};
    if (this.syncing) {
      throw new Error('同步正在进行，请等待同步完成后再导入配置');
    }
    if (!imported || !imported.settings) {
      throw new Error('配置内容为空');
    }

    const nextSettings = normalizeSettings(imported.settings);
    if (!nextSettings.serverUrl) {
      throw new Error('配置中没有 WebDAV 地址');
    }
    if (!imported.passwordIncluded) {
      nextSettings.password = this.settings.password || '';
    }

    const oldTarget = String(this.settings.serverUrl || '').trim().replace(/\/+$/, '');
    const newTarget = String(nextSettings.serverUrl || '').trim().replace(/\/+$/, '');
    const oldRoot = normalizeRemoteRoot(this.settings.remoteRoot);
    const newRoot = normalizeRemoteRoot(nextSettings.remoteRoot);
    const targetChanged = oldTarget !== newTarget || oldRoot !== newRoot;

    if (!opts.skipConfirm) {
      const lines = [
        '即将导入 WebDAVrSync 配置：',
        '',
        '服务器：' + nextSettings.serverUrl,
        '远程根目录：' + (nextSettings.remoteRoot || '/'),
        '用户名：' + (nextSettings.username || '(未填写)'),
        '密码：' +
          (imported.passwordIncluded
            ? '包含在文件中'
            : this.settings.password
              ? '文件未包含，将保留当前密码'
              : '文件未包含，需要手动填写'),
        '',
        targetChanged
          ? '服务器或远程根目录已变化，导入后会清空文件对照表（不会删除文件）。'
          : '服务器和远程根目录未变化，会保留现有文件对照表。',
        '导入后不会自动同步，请先测试连接。',
        '',
        '是否继续？',
      ];
      if (!window.confirm(lines.join('\n'))) {
        return { ok: false, canceled: true };
      }
    }

    this.settings = nextSettings;
    if (this.recentWrites) this.recentWrites.clear();
    if (targetChanged) {
      this.syncState = {
        version: STATE_VERSION,
        lastSync: 0,
        files: Object.create(null),
      };
    }
    this.ignoreFn = compileIgnore(this.settings);
    await this.saveAll();
    this.configureInterval();
    this.refreshStatus();

    let message = 'WebDAVrSync：配置已导入';
    if (targetChanged) message += '，文件对照表已清空';
    if (!imported.passwordIncluded) {
      message += this.settings.password
        ? '；文件不含密码，已保留当前密码'
        : '；文件不含密码，请手动填写密码';
    }
    message += '。请先测试连接。';
    new Notice(message, 8000);

    return {
      ok: true,
      targetChanged,
      passwordIncluded: !!imported.passwordIncluded,
    };
  }

  backupFileName() {
    return (
      'webdavrsync-plugin-backup-' +
      timestampForName(new Date()) +
      '-' +
      randomSuffix() +
      '.wdrsbackup'
    );
  }

  async listAdapterFiles(adapter, dir, warnings) {
    const files = [];
    let listing;
    try {
      listing = await adapter.list(dir);
    } catch (error) {
      if (warnings) warnings.push('无法读取目录 ' + dir + '：' + (error.message || error));
      return files;
    }
    for (const file of listing.files || []) files.push(file);
    for (const folder of listing.folders || []) {
      const normalized = normalizeRelPath(folder);
      if (normalized.includes('/node_modules') || normalized.includes('/.git/')) continue;
      files.push(...(await this.listAdapterFiles(adapter, folder, warnings)));
    }
    return files;
  }

  async collectAllPluginFiles(adapter, folder, entry, state, warnings) {
    const files = await this.listAdapterFiles(adapter, folder, warnings);
    for (const file of files) {
      const rel = normalizeRelPath(file.slice(folder.length + 1));
      if (!rel || rel === 'data.json' || rel === 'manifest.json') continue;
      if (rel.includes('.pre-restore-')) continue;
      if (state.totalBytes >= BACKUP_MAX_TOTAL_SIZE) {
        warnings.push('备份达到 100MB 上限，已跳过：' + file);
        break;
      }
      let stat;
      try {
        stat = await adapter.stat(file);
      } catch (error) {
        warnings.push('无法读取文件信息：' + file);
        continue;
      }
      if (!stat || stat.type === 'folder') continue;
      if (Number(stat.size) > BACKUP_MAX_FILE_SIZE) {
        warnings.push('文件超过 25MB，已跳过：' + file);
        continue;
      }
      const data = await readAdapterBinary(adapter, file);
      if (data === null) {
        warnings.push('无法读取文件：' + file);
        continue;
      }
      const bytes = toUint8Array(data);
      state.totalBytes += bytes.byteLength;
      state.fileCount++;
      if (isBackupTextFile(rel)) {
        entry.files[rel] = {
          encoding: 'utf8',
          data: new TextDecoder().decode(bytes),
        };
      } else {
        entry.files[rel] = {
          encoding: 'base64',
          data: arrayBufferToBase64(bytes),
        };
      }
    }
  }

  async collectPluginConfigFiles(adapter, folder, entry, state, warnings) {
    const files = await this.listAdapterFiles(adapter, folder, warnings);
    const extensions = [
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.conf',
      '.env',
      '.txt',
    ];
    for (const file of files) {
      const rel = normalizeRelPath(file.slice(folder.length + 1));
      if (!rel || rel === 'data.json' || rel === 'manifest.json') continue;
      const lower = rel.toLowerCase();
      if (!extensions.some((extension) => lower.endsWith(extension))) continue;
      if (state.totalBytes >= BACKUP_MAX_TOTAL_SIZE) {
        warnings.push('备份达到 100MB 上限，已跳过：' + file);
        break;
      }
      let stat;
      try {
        stat = await adapter.stat(file);
      } catch (error) {
        warnings.push('无法读取文件信息：' + file);
        continue;
      }
      if (!stat || stat.type === 'folder' || Number(stat.size) > 2 * 1024 * 1024) {
        continue;
      }
      const text = await readAdapterText(adapter, file);
      if (text === null) {
        warnings.push('无法读取配置文件：' + file);
        continue;
      }
      state.totalBytes += new TextEncoder().encode(text).byteLength;
      state.fileCount++;
      entry.files[rel] = { encoding: 'utf8', data: text };
    }
  }

  async collectCopilotSecrets(dataText, bundle) {
    let data;
    try {
      data = JSON.parse(dataText);
    } catch (error) {
      bundle.warnings.push('Copilot data.json 无法解析，未能读取 Keychain 密钥');
      return;
    }

    const storage = this.app.secretStorage;
    if (!storage || typeof storage.getSecret !== 'function') {
      bundle.warnings.push(
        '当前 Obsidian 不支持 SecretStorage，Copilot API Key 未包含（Obsidian 需 1.11.4+）'
      );
      return;
    }

    const candidates = new Map();
    const providers =
      data.providers && typeof data.providers === 'object' ? data.providers : {};
    for (const [providerId, provider] of Object.entries(providers)) {
      if (
        provider &&
        typeof provider.apiKeyKeychainId === 'string' &&
        provider.apiKeyKeychainId
      ) {
        candidates.set(provider.apiKeyKeychainId, {
          providerId,
          providerName:
            provider.displayName || provider.providerId || providerId,
          source: 'provider',
        });
      }
    }

    const vaultId =
      typeof data._keychainVaultId === 'string' ? data._keychainVaultId : '';
    bundle.copilotVaultId = vaultId;

    let availableIds = [];
    if (typeof storage.listSecrets === 'function') {
      try {
        const listed = await Promise.resolve(storage.listSecrets());
        availableIds = Array.isArray(listed) ? listed.map((id) => String(id)) : [];
      } catch (error) {
        bundle.warnings.push('无法枚举 Obsidian Keychain：' + (error.message || error));
      }
    }

    if (vaultId) {
      const prefix = 'copilot-v' + vaultId + '-';
      for (const id of availableIds) {
        if (id.startsWith(prefix)) {
          const label = id.slice(prefix.length).replace(/-/g, ' ');
          candidates.set(id, {
            providerId: '',
            providerName: 'Copilot ' + label,
            source: 'vault-secret',
          });
        }
      }
      for (const field of LEGACY_COPILOT_SECRET_FIELDS) {
        const id = legacyCopilotSecretId(vaultId, field);
        if (id) {
          candidates.set(id, {
            providerId: '',
            providerName: field,
            source: 'legacy',
          });
        }
      }
    }

    for (const [id, info] of candidates) {
      try {
        const value = await Promise.resolve(storage.getSecret(id));
        if (typeof value === 'string' && value.length > 0) {
          bundle.copilotSecrets.push({
            providerId: info.providerId,
            providerName: info.providerName,
            source: info.source,
            keychainId: id,
            value,
          });
        }
      } catch (error) {
        bundle.warnings.push('读取 Copilot 密钥失败：' + id);
      }
    }

    for (const field of LEGACY_COPILOT_SECRET_FIELDS) {
      if (
        typeof data[field] === 'string' &&
        data[field].length > 0 &&
        !bundle.detectedSecrets.some(
          (item) => item.plugin === 'copilot' && item.path === field
        )
      ) {
        bundle.detectedSecrets.push({
          plugin: 'copilot',
          path: field,
          kind: 'plaintext',
          length: data[field].length,
        });
      }
    }
  }

  async collectPluginBackup(options) {
    const opts = options || {};
    const includePluginCode =
      opts.includePluginCode !== undefined
        ? !!opts.includePluginCode
        : !!this.settings.backupIncludePluginCode;
    const adapter = this.app.vault.adapter;
    const bundle = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      pluginVersion:
        this.manifest && this.manifest.version
          ? this.manifest.version
          : PLUGIN_VERSION_FALLBACK,
      createdAt: new Date().toISOString(),
      vaultName:
        this.app.vault && typeof this.app.vault.getName === 'function'
          ? this.app.vault.getName()
          : '',
      includePluginCode,
      excludedPlugins: [PLUGIN_ID],
      plugins: [],
      vaultConfig: {},
      copilotSecrets: [],
      detectedSecrets: [],
      warnings: [],
      stats: {},
    };

    const pluginRoot = '.obsidian/plugins';
    let listing;
    try {
      listing = await adapter.list(pluginRoot);
    } catch (error) {
      throw new Error('无法读取 .obsidian/plugins：' + (error.message || error));
    }

    const folders = (listing.folders || []).filter(
      (folder) => folder.split('/').pop() !== PLUGIN_ID
    );
    let copilotDataText = null;
    const counters = { totalBytes: 0, fileCount: 0 };

    for (const folder of folders) {
      const id = folder.split('/').pop();
      const entry = { id, folder, files: {} };
      const dataText = await readAdapterText(adapter, folder + '/data.json');
      const manifestText = await readAdapterText(adapter, folder + '/manifest.json');

      if (dataText !== null) {
        entry.files['data.json'] = { encoding: 'utf8', data: dataText };
        counters.totalBytes += new TextEncoder().encode(dataText).byteLength;
        counters.fileCount++;
      }
      if (manifestText !== null) {
        entry.files['manifest.json'] = { encoding: 'utf8', data: manifestText };
        counters.totalBytes += new TextEncoder().encode(manifestText).byteLength;
        counters.fileCount++;
      }
      if (id === 'copilot' && dataText !== null) copilotDataText = dataText;

      if (includePluginCode) {
        await this.collectAllPluginFiles(
          adapter,
          folder,
          entry,
          counters,
          bundle.warnings
        );
      } else {
        await this.collectPluginConfigFiles(
          adapter,
          folder,
          entry,
          counters,
          bundle.warnings
        );
      }

      if (Object.keys(entry.files).length > 0) bundle.plugins.push(entry);

      if (dataText !== null) {
        try {
          scanSecretFields(
            JSON.parse(dataText),
            id,
            '',
            bundle.detectedSecrets,
            0
          );
        } catch (error) {
          bundle.warnings.push(id + '/data.json 不是有效 JSON，无法扫描密钥字段');
        }
      }
    }

    for (const name of ['community-plugins.json', 'core-plugins.json']) {
      const text = await readAdapterText(adapter, '.obsidian/' + name);
      if (text !== null) {
        bundle.vaultConfig[name] = { encoding: 'utf8', data: text };
      }
    }

    if (copilotDataText !== null) {
      await this.collectCopilotSecrets(copilotDataText, bundle);
    } else {
      bundle.warnings.push('未找到 Copilot 的 data.json，未读取 Copilot 密钥');
    }

    bundle.detectedSecrets = bundle.detectedSecrets.slice(0, 500);
    bundle.stats = {
      pluginCount: bundle.plugins.length,
      fileCount: counters.fileCount,
      totalBytes: counters.totalBytes,
      copilotSecretCount: bundle.copilotSecrets.length,
      detectedSecretCount: bundle.detectedSecrets.length,
    };
    return bundle;
  }

  async uploadEncryptedBackup(filename, text) {
    const client = new WebDAVClient(this.settings);
    await client.ensureRoot();
    const folder = normalizeRelPath(
      this.settings.backupFolder || DEFAULT_SETTINGS.backupFolder
    );
    await client.ensureDir(folder);
    const path = folder ? folder + '/' + filename : filename;
    const bytes = new TextEncoder().encode(text);
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    await client.put(path, data);

    // 上传后回读校验：确认远端文件确实落地且大小一致，
    // 否则“备份完成”的提示会掩盖上传失败。
    let verified = null;
    try {
      verified = await client.stat(path);
    } catch (error) {
      throw new Error(
        '上传后无法读取远端文件属性：' +
          (error && error.message ? error.message : String(error))
      );
    }
    if (Number(verified.size) !== bytes.byteLength) {
      throw new Error(
        '上传校验失败：远端 ' +
          verified.size +
          ' 字节，本地 ' +
          bytes.byteLength +
          ' 字节'
      );
    }

    await this.pruneRemoteBackups(client, folder);
    return { path, size: bytes.byteLength, etag: verified.etag };
  }

  async pruneRemoteBackups(client, folder) {
    const keep = Math.max(1, Math.floor(Number(this.settings.backupKeep) || 10));
    let entries;
    try {
      entries = await client.list(folder);
    } catch (error) {
      if (error && error.status === 404) return;
      throw error;
    }
    const backups = entries
      .filter(
        (entry) => !entry.isDir && /\.wdrsbackup$/i.test(entry.path)
      )
      .sort((a, b) => b.path.localeCompare(a.path));
    for (const entry of backups.slice(keep)) {
      try {
        await client.deleteFile(entry.path);
      } catch (error) {
        console.warn('[WebDAVrSync] 清理旧备份失败：' + entry.path, error);
      }
    }
  }

  async listRemoteBackups() {
    const client = new WebDAVClient(this.settings);
    await client.ensureRoot();
    const folder = normalizeRelPath(
      this.settings.backupFolder || DEFAULT_SETTINGS.backupFolder
    );
    let entries;
    try {
      entries = await client.list(folder);
    } catch (error) {
      if (error && error.status === 404) {
        return { client, folder, entries: [] };
      }
      throw error;
    }
    const backups = entries
      .filter(
        (entry) => !entry.isDir && /\.wdrsbackup$/i.test(entry.path)
      )
      .sort((a, b) => b.path.localeCompare(a.path));
    return { client, folder, entries: backups };
  }

  async createEncryptedBackup() {
    if (this.syncing) {
      new Notice('WebDAVrSync：同步进行中，请等同步结束后再备份');
      return { ok: false, error: '同步进行中' };
    }
    const passphrase = await promptPassphrase(this.app, {
      title: '创建插件配置与密钥备份',
      description:
        '备份会读取所有插件的 data.json、manifest.json、其他配置文件，以及 Copilot 在 Obsidian Keychain 中的 API Key。' +
        '整个备份使用 AES-256-GCM 加密；密码不会保存，请自行记牢。',
      requireConfirm: true,
      confirmLabel: '创建备份',
      minLength: 8,
    });
    if (!passphrase.ok) return { ok: false, canceled: true };

    try {
      const bundle = await this.collectPluginBackup();
      const envelope = await encryptBackupBundle(bundle, passphrase.password);
      const text = JSON.stringify(envelope, null, 2);
      const filename = this.backupFileName();
      const localSaved = downloadTextFile(
        filename,
        text,
        'application/octet-stream'
      );

      let remotePath = '';
      let remoteSize = 0;
      let remoteError = '';
      if (String(this.settings.serverUrl || '').trim()) {
        try {
          const uploaded = await this.uploadEncryptedBackup(filename, text);
          remotePath = uploaded.path;
          remoteSize = uploaded.size;
        } catch (error) {
          remoteError = error && error.message ? error.message : String(error);
        }
      }

      if (!localSaved && !remotePath) {
        throw new Error('既无法下载到本机，也无法上传到 WebDAV');
      }

      const size = new TextEncoder().encode(text).byteLength;
      let message =
        'WebDAVrSync 备份完成：插件 ' +
        bundle.stats.pluginCount +
        ' 个，文件 ' +
        bundle.stats.fileCount +
        ' 个，Copilot 密钥 ' +
        bundle.stats.copilotSecretCount +
        ' 条，大小 ' +
        formatBytes(size);
      if (localSaved) message += '；已下载到本机';
      if (!String(this.settings.serverUrl || '').trim()) {
        message += '；未配置 WebDAV，仅保存到本机';
      }
      if (remotePath) {
        message +=
          '；已上传到 ' +
          safeDecodeUri(remotePath) +
          '（' +
          formatBytes(remoteSize) +
          '，已校验）';
      }
      if (remoteError) message += '；上传 WebDAV 失败：' + remoteError;
      if (bundle.warnings.length) {
        message += '；' + bundle.warnings.length + ' 条警告，详见 Console';
      }
      new Notice(message, 15000);
      this.lastBackup = { at: Date.now(), filename, message };
      if (bundle.warnings.length) {
        console.warn('[WebDAVrSync] 备份警告', bundle.warnings);
      }
      return {
        ok: true,
        filename,
        remotePath,
        localSaved,
        stats: bundle.stats,
        warnings: bundle.warnings,
      };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      new Notice('WebDAVrSync 备份失败：' + message, 12000);
      console.error('[WebDAVrSync] 备份失败', error);
      this.lastBackup = { at: Date.now(), filename: '', message: '失败：' + message };
      return { ok: false, error: message };
    }
  }

  pickBackupFile(onText) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wdrsbackup,.json,application/octet-stream';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('cancel', () => input.remove());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        if (file.size > 200 * 1024 * 1024) {
          throw new Error('备份文件大于 200MB');
        }
        const text = await readFileText(file);
        await onText(text);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        new Notice('WebDAVrSync 读取备份失败：' + message, 12000);
        console.error('[WebDAVrSync] 读取备份失败', error);
      }
    });
    input.click();
  }

  async decryptAndRestoreBackupText(text) {
    let envelope;
    try {
      envelope = JSON.parse(String(text || '').trim());
    } catch (error) {
      throw new Error('不是有效的备份 JSON 文件');
    }
    const passphrase = await promptPassphrase(this.app, {
      title: '解密插件备份',
      description: '输入创建备份时使用的密码。',
      requireConfirm: false,
      confirmLabel: '解密并恢复',
      minLength: 1,
    });
    if (!passphrase.ok) return { ok: false, canceled: true };

    let bundle;
    try {
      bundle = await decryptBackupBundle(envelope, passphrase.password);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      new Notice('WebDAVrSync 解密失败：' + message, 12000);
      return { ok: false, error: message };
    }
    return await this.restorePluginBackup(bundle);
  }

  async restoreFromLocalBackupFile() {
    if (this.syncing) {
      new Notice('WebDAVrSync：同步进行中，请等同步结束后再恢复');
      return { ok: false, error: '同步进行中' };
    }
    this.pickBackupFile(async (text) => {
      try {
        await this.decryptAndRestoreBackupText(text);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        new Notice('WebDAVrSync 恢复失败：' + message, 12000);
        console.error('[WebDAVrSync] 恢复失败', error);
      }
    });
  }

  async restoreFromRemoteBackup() {
    if (this.syncing) {
      new Notice('WebDAVrSync：同步进行中，请等同步结束后再恢复');
      return { ok: false, error: '同步进行中' };
    }
    if (!String(this.settings.serverUrl || '').trim()) {
      new Notice('WebDAVrSync：请先填写 WebDAV 地址');
      return { ok: false, error: '未填写 WebDAV 地址' };
    }
    try {
      const result = await this.listRemoteBackups();
      if (!result.entries.length) {
        new Notice(
          'WebDAVrSync：远端备份文件夹中没有 .wdrsbackup 文件：' + result.folder,
          8000
        );
        return { ok: false, error: '没有远端备份' };
      }
      const chosen = await promptBackupChoice(this.app, result.entries);
      if (!chosen) return { ok: false, canceled: true };
      const data = await result.client.get(chosen.path);
      const text = new TextDecoder().decode(data);
      return await this.decryptAndRestoreBackupText(text);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      new Notice('WebDAVrSync 读取远端备份失败：' + message, 12000);
      console.error('[WebDAVrSync] 读取远端备份失败', error);
      return { ok: false, error: message };
    }
  }

  async backupExistingFile(adapter, path, stamp, warnings) {
    if (!(await adapter.exists(path))) return;
    try {
      const data = await adapter.readBinary(path);
      const backupPath = path + '.pre-restore-' + stamp + '.bak';
      await adapter.writeBinary(backupPath, data);
    } catch (error) {
      warnings.push('无法备份原文件 ' + path + '：' + (error.message || error));
      throw new Error('无法备份原文件，已停止恢复：' + path);
    }
  }

  async writeBackupFile(adapter, path, file) {
    if (!file || typeof file.data !== 'string') {
      throw new Error('备份文件内容损坏：' + path);
    }
    let data;
    if (file.encoding === 'base64') {
      data = base64ToArrayBuffer(file.data);
    } else {
      const bytes = new TextEncoder().encode(file.data);
      data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
    }
    await adapter.writeBinary(path, data);
  }

  async restorePluginBackup(bundle, options) {
    if (this.syncing) {
      throw new Error('同步正在进行，请等同步结束后再恢复');
    }
    if (!bundle || bundle.format !== BACKUP_FORMAT) {
      throw new Error('不是 WebDAVrSync 插件备份内容');
    }
    if (
      bundle.formatVersion !== undefined &&
      Number(bundle.formatVersion) > BACKUP_FORMAT_VERSION
    ) {
      throw new Error('备份内容版本过新，请升级 WebDAVrSync');
    }

    const opts = options || {};
    const plugins = Array.isArray(bundle.plugins) ? bundle.plugins : [];
    const secretCount = Array.isArray(bundle.copilotSecrets)
      ? bundle.copilotSecrets.length
      : 0;
    const fileCount = plugins.reduce((count, plugin) => {
      const files = (plugin && plugin.files) || {};
      return (
        count +
        Object.keys(files).filter(
          (rel) =>
            !(normalizeRelPath(rel) === 'manifest.json' && !bundle.includePluginCode)
        ).length
      );
    }, 0);

    if (!opts.skipConfirm) {
      const lines = [
        '即将恢复 WebDAVrSync 插件备份：',
        '',
        '备份时间：' +
          (bundle.createdAt
            ? new Date(bundle.createdAt).toLocaleString()
            : '未知'),
        '插件数量：' + plugins.length + ' 个',
        '文件数量：' + fileCount + ' 个',
        '包含插件代码：' + (bundle.includePluginCode ? '是' : '否'),
        'Copilot 密钥：' + secretCount + ' 条',
        '',
        '恢复会覆盖当前插件的 data.json 和其他配置；如备份包含插件代码，还会覆盖 manifest.json 和代码文件。',
        '覆盖前会在同目录生成 .pre-restore-*.bak 备份。',
        '恢复完成后建议重启 Obsidian。',
        '',
        '是否继续？',
      ];
      if (!window.confirm(lines.join('\n'))) {
        return { ok: false, canceled: true };
      }
    }

    const adapter = this.app.vault.adapter;
    const stamp = timestampForName(new Date());
    const warnings = [];
    let restoredFiles = 0;
    let restoredSecrets = 0;

    for (const plugin of plugins) {
      if (!plugin || !plugin.folder || plugin.id === PLUGIN_ID) continue;
      const folder = normalizeRelPath(plugin.folder);
      if (!/^\.obsidian\/plugins\/[^/]+$/.test(folder)) {
        warnings.push('跳过非法插件路径：' + plugin.folder);
        continue;
      }
      if (folder.split('/').pop() === PLUGIN_ID) continue;
      for (const [rawRel, file] of Object.entries(plugin.files || {})) {
        const rel = normalizeRelPath(rawRel);
        if (!rel || rel.includes('..')) {
          warnings.push('跳过非法文件路径：' + rawRel);
          continue;
        }
        // A manifest without matching plugin code could make Obsidian believe
        // the installed version is older/newer than it really is.
        if (rel === 'manifest.json' && !bundle.includePluginCode) continue;
        const path = folder + '/' + rel;
        const parent = path.split('/').slice(0, -1).join('/');
        await ensureAdapterDir(adapter, parent);
        await this.backupExistingFile(adapter, path, stamp, warnings);
        await this.writeBackupFile(adapter, path, file);
        restoredFiles++;
      }
    }

    if (secretCount > 0) {
      const storage = this.app.secretStorage;
      if (!storage || typeof storage.setSecret !== 'function') {
        warnings.push(
          '当前 Obsidian 不支持 SecretStorage，Copilot 密钥未恢复（需 1.11.4+）'
        );
      } else {
        for (const secret of bundle.copilotSecrets) {
          if (
            !secret ||
            typeof secret.keychainId !== 'string' ||
            typeof secret.value !== 'string'
          ) {
            continue;
          }
          try {
            await Promise.resolve(
              storage.setSecret(secret.keychainId, secret.value)
            );
            restoredSecrets++;
          } catch (error) {
            warnings.push('恢复 Copilot 密钥失败：' + secret.keychainId);
          }
        }
      }
    }

    if (warnings.length) {
      console.warn('[WebDAVrSync] 恢复警告', warnings);
    }
    new Notice(
      'WebDAVrSync 恢复完成：文件 ' +
        restoredFiles +
        ' 个，Copilot 密钥 ' +
        restoredSecrets +
        ' 条。请重启 Obsidian。',
      15000
    );
    return {
      ok: true,
      restoredFiles,
      restoredSecrets,
      warnings,
    };
  }

  async resetSyncState() {
    const confirmed = window.confirm(
      '确定清空同步状态吗？\n\n不会删除任何文件，但下次同步会把两端所有文件重新比较一遍，文件多时可能较慢。'
    );
    if (!confirmed) return;
    this.syncState = { version: STATE_VERSION, lastSync: 0, files: {} };
    await this.saveAll();
    this.refreshStatus();
    new Notice('WebDAVrSync：同步状态已清空');
  }
}

// ---------------------------------------------------------------------------
// Backup UI modals
// ---------------------------------------------------------------------------

class PassphraseModal extends Modal {
  constructor(app, options, resolve) {
    super(app);
    this.options = options || {};
    this.resolve = resolve;
    this.resolved = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', {
      text: this.options.title || '加密备份密码',
    });
    if (this.options.description) {
      contentEl.createEl('p', { text: this.options.description });
    }

    const password = contentEl.createEl('input');
    password.type = 'password';
    password.placeholder = '备份密码';
    password.style.width = '100%';

    let confirmation = null;
    if (this.options.requireConfirm) {
      confirmation = contentEl.createEl('input');
      confirmation.type = 'password';
      confirmation.placeholder = '再次输入密码';
      confirmation.style.width = '100%';
      confirmation.style.marginTop = '8px';
    }

    const error = contentEl.createEl('p');
    error.style.color = 'var(--text-error)';
    error.style.minHeight = '1.2em';

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const okButton = buttons.createEl('button', {
      text: this.options.confirmLabel || '确定',
      cls: 'mod-cta',
    });
    const cancelButton = buttons.createEl('button', { text: '取消' });

    const submit = () => {
      const value = password.value;
      const minLength = Number(this.options.minLength) || 1;
      if (value.trim().length < minLength) {
        error.setText('密码至少 ' + minLength + ' 个字符');
        return;
      }
      if (confirmation && confirmation.value !== value) {
        error.setText('两次输入的密码不一致');
        return;
      }
      if (this.resolved) return;
      this.resolved = true;
      this.resolve({ ok: true, password: value });
      this.close();
    };

    okButton.onclick = submit;
    cancelButton.onclick = () => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolve({ ok: false });
      this.close();
    };
    password.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    if (confirmation) {
      confirmation.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    }
    window.setTimeout(() => {
      try {
        password.focus();
      } catch (error) {
        // Ignore focus failure.
      }
    }, 50);
  }

  onClose() {
    if (!this.resolved && this.resolve) {
      this.resolved = true;
      this.resolve({ ok: false });
    }
    this.contentEl.empty();
  }
}

function promptPassphrase(app, options) {
  return new Promise((resolve) => {
    new PassphraseModal(app, options, resolve).open();
  });
}

class BackupListModal extends Modal {
  constructor(app, entries, resolve) {
    super(app);
    this.entries = entries || [];
    this.resolve = resolve;
    this.resolved = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '选择要恢复的远程备份' });
    contentEl.createEl('p', {
      text: '按文件名从新到旧排列；列出的是 WebDAV 备份文件夹中的 .wdrsbackup 文件。',
    });

    for (const entry of this.entries) {
      const name = entry.path.split('/').pop();
      const pieces = [name];
      if (entry.mtime) {
        pieces.push(new Date(entry.mtime).toLocaleString());
      }
      if (entry.size) pieces.push(formatBytes(entry.size));
      const button = contentEl.createEl('button', {
        text: pieces.join('  ·  '),
        cls: 'mod-cta',
      });
      button.style.display = 'block';
      button.style.width = '100%';
      button.style.marginBottom = '6px';
      button.style.textAlign = 'left';
      button.onclick = () => {
        if (this.resolved) return;
        this.resolved = true;
        this.resolve(entry);
        this.close();
      };
    }

    const cancel = contentEl.createEl('button', { text: '取消' });
    cancel.style.marginTop = '8px';
    cancel.onclick = () => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolve(null);
      this.close();
    };
  }

  onClose() {
    if (!this.resolved && this.resolve) {
      this.resolved = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

function promptBackupChoice(app, entries) {
  return new Promise((resolve) => {
    new BackupListModal(app, entries, resolve).open();
  });
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class WebDAVrSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'WebDAVrSync' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '本地仓库与 WebDAV 服务器双向同步。只依赖 WebDAV，不需要 S3 或其他云服务。' +
        '密码以明文保存在本插件目录的 data.json 中，该目录已被排除同步。',
    });

    new Setting(containerEl).setName('服务器').setHeading();

    new Setting(containerEl)
      .setName('WebDAV 地址')
      .setDesc('示例：https://dav.example.com（可省略 http://）')
      .addText((text) =>
        text
          .setPlaceholder('https://dav.example.com')
          .setValue(plugin.settings.serverUrl)
          .onChange(async (value) => {
            plugin.settings.serverUrl = value.trim();
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('用户名')
      .addText((text) =>
        text
          .setPlaceholder('WebDAV 用户名')
          .setValue(plugin.settings.username)
          .onChange(async (value) => {
            plugin.settings.username = value;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('密码')
      .setDesc('保存在本机 data.json；本插件目录默认不同步到远端。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('WebDAV 密码')
          .setValue(plugin.settings.password)
          .onChange(async (value) => {
            plugin.settings.password = value;
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('远程根目录')
      .setDesc('留空或 / 表示 WebDAV 根；例如 /obsidian 表示同步到该子目录（不存在会自动创建）。')
      .addText((text) =>
        text
          .setPlaceholder('/')
          .setValue(plugin.settings.remoteRoot)
          .onChange(async (value) => {
            plugin.settings.remoteRoot = value.trim() || '/';
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('设备名称')
      .setDesc('仅用于冲突文件名，例如 PC、Laptop、手机。')
      .addText((text) =>
        text
          .setPlaceholder('PC')
          .setValue(plugin.settings.deviceName)
          .onChange(async (value) => {
            plugin.settings.deviceName = value.trim() || 'PC';
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('同步').setHeading();

    new Setting(containerEl)
      .setName('同步间隔（分钟）')
      .setDesc('0 表示关闭定时同步；建议 5–30 分钟。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.max = '1440';
        text
          .setValue(String(plugin.settings.syncIntervalMinutes || 0))
          .onChange(async (value) => {
            const minutes = Math.max(0, Math.min(1440, Number(value) || 0));
            plugin.settings.syncIntervalMinutes = minutes;
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('启动时自动同步')
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.syncOnStart).onChange(async (value) => {
          plugin.settings.syncOnStart = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('文件变更后自动同步')
      .setDesc('停止编辑约 8 秒后自动同步一次。')
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.syncOnChange).onChange(async (value) => {
          plugin.settings.syncOnChange = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('删除同步')
      .setDesc(
        '开启：本地删除会删除远端，远端删除会删除本地（本地删除优先进入 Obsidian 回收站）。' +
          '关闭：删除不会传播，已删除的一侧会从另一侧恢复。'
      )
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.allowDeletions).onChange(async (value) => {
          plugin.settings.allowDeletions = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('冲突处理')
      .setDesc('保留双方会生成 “文件名 (conflict 时间 设备).扩展名” 的副本。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('keep-both', '保留双方（推荐）')
          .addOption('newest', '仅保留较新版本')
          .setValue(plugin.settings.conflictStrategy)
          .onChange(async (value) => {
            plugin.settings.conflictStrategy = value;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('同步 .obsidian 配置')
      .setDesc('默认关闭。无论开关如何，本插件目录（含密码）始终不会同步。')
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.syncConfig).onChange(async (value) => {
          plugin.settings.syncConfig = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('内容校验')
      .setDesc(
        '首次同步或双方同时修改且文件大小相同时，逐字节比较内容，避免误报冲突。' +
          '关闭可加快大仓库首次同步，但同尺寸不同内容可能被漏判。'
      )
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.verifyContent).onChange(async (value) => {
          plugin.settings.verifyContent = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('同步回收站（.trash）')
      .setDesc(
        '开启：删除的文件移入 Obsidian 回收站后也会备份到 WebDAV，' +
          '远端删除本地文件时内容不会彻底丢失。关闭：回收站内容不参与同步。' +
          '本项优先于忽略规则里的 .trash 写法。'
      )
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.syncTrash).onChange(async (value) => {
          plugin.settings.syncTrash = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('同步空目录')
      .setDesc(
        '开启：本地没有文件的目录也会在 WebDAV 上建立同名目录，' +
          '浏览器里看到的目录结构与本地仓库一致。'
      )
      .addToggle((toggle) =>
        toggle.setValue(!!plugin.settings.syncEmptyDirs).onChange(async (value) => {
          plugin.settings.syncEmptyDirs = value;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName('忽略规则').setHeading();

    new Setting(containerEl)
      .setName('不同步的路径')
      .setDesc('每行一个 glob；* 匹配一层，** 匹配任意层。以 # 开头的行是注释。')
      .addTextArea((text) => {
        text
          .setValue(plugin.settings.ignoreText)
          .setPlaceholder(DEFAULT_IGNORE_TEXT)
          .onChange(async (value) => {
            plugin.settings.ignoreText = value;
            await plugin.saveSettings();
          });
        text.inputEl.rows = 9;
        text.inputEl.style.width = '100%';
        text.inputEl.style.fontFamily = 'monospace';
      });

    new Setting(containerEl).setName('配置导出 / 导入').setHeading();

    new Setting(containerEl)
      .setName('导出配置（含密码）')
      .setDesc('生成 JSON 文件，包含地址、账号、密码和全部同步设置；可直接在另一台机器导入。请勿公开分享。')
      .addButton((button) =>
        button
          .setButtonText('导出')
          .setWarning()
          .onClick(async () => {
            await plugin.exportConfigFile(true);
          })
      );

    new Setting(containerEl)
      .setName('导出配置（不含密码）')
      .setDesc('适合备份或分享；导入到已有配置时不会覆盖当前密码。')
      .addButton((button) =>
        button.setButtonText('导出').onClick(async () => {
          await plugin.exportConfigFile(false);
        })
      );

    new Setting(containerEl)
      .setName('导入配置')
      .setDesc(
        '选择 WebDAVrSync 导出的 JSON（也可以直接选本插件目录下的 data.json）。' +
          '不会导入文件对照表；服务器或远程根目录变化时会自动清空对照表。'
      )
      .addButton((button) =>
        button.setButtonText('选择 JSON 文件').onClick(() => {
          plugin.pickConfigFile((result) => {
            if (result && result.ok) this.display();
          });
        })
      );

    new Setting(containerEl).setName('插件配置与密钥备份（加密）').setHeading();

    new Setting(containerEl)
      .setName('备份文件夹')
      .setDesc(
        'WebDAV 上的相对路径，默认 .webdavrsync-backups。该目录由备份功能管理，' +
          '普通同步不会把它拉回本地。'
      )
      .addText((text) =>
        text
          .setPlaceholder('.webdavrsync-backups')
          .setValue(plugin.settings.backupFolder)
          .onChange(async (value) => {
            plugin.settings.backupFolder =
              value.trim() || DEFAULT_SETTINGS.backupFolder;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('保留备份数量')
      .setDesc('上传到 WebDAV 后只保留最近的 N 个备份，范围 1–100。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '100';
        text
          .setValue(String(plugin.settings.backupKeep || 10))
          .onChange(async (value) => {
            plugin.settings.backupKeep = Math.max(
              1,
              Math.min(100, Number(value) || 10)
            );
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('备份时包含插件代码')
      .setDesc(
        '关闭：只备份 data.json、manifest.json 和其他配置文件，体积小。' +
          '开启：连 main.js、styles.css 等插件代码一起备份，体积可能几十 MB。'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(!!plugin.settings.backupIncludePluginCode)
          .onChange(async (value) => {
            plugin.settings.backupIncludePluginCode = value;
            await plugin.saveSettings();
          })
      );

    if (plugin.lastBackup) {
      new Setting(containerEl)
        .setName('最近一次备份')
        .setDesc(
          new Date(plugin.lastBackup.at).toLocaleString() +
            '：' +
            plugin.lastBackup.message
        );
    }

    new Setting(containerEl)
      .setName('立即创建加密备份')
      .setDesc(
        '读取所有插件的配置文件、Copilot 在 Obsidian Keychain 中的 API Key，' +
          '以及其他插件 data.json 里的明文 token/key。' +
          '备份使用 AES-256-GCM 加密，密码不会保存；忘记密码将无法恢复。' +
          '上传后会自动回读校验，确认远端文件已落地。'
      )
      .addButton((button) =>
        button
          .setButtonText('创建备份')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('备份中…');
            await plugin.createEncryptedBackup();
            button.setDisabled(false);
            button.setButtonText('创建备份');
          })
      );

    new Setting(containerEl)
      .setName('从本地文件恢复')
      .setDesc('选择本机下载的 .wdrsbackup 文件，输入备份密码后恢复。')
      .addButton((button) =>
        button.setButtonText('选择文件').onClick(() => {
          plugin.restoreFromLocalBackupFile();
        })
      );

    new Setting(containerEl)
      .setName('从 WebDAV 恢复')
      .setDesc('列出远端备份文件夹中的 .wdrsbackup，选择后输入密码恢复。')
      .addButton((button) =>
        button.setButtonText('选择远程备份').onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('读取中…');
          await plugin.restoreFromRemoteBackup();
          button.setDisabled(false);
          button.setButtonText('选择远程备份');
        })
      );

    new Setting(containerEl).setName('操作').setHeading();

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc(plugin.describeState())
      .addButton((button) =>
        button.setButtonText('测试连接').onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('测试中…');
          await plugin.testConnection(true);
          button.setDisabled(false);
          button.setButtonText('测试连接');
        })
      );

    new Setting(containerEl)
      .setName('立即同步')
      .addButton((button) =>
        button
          .setButtonText('同步')
          .setCta()
          .onClick(() => plugin.runSync(true))
      );

    new Setting(containerEl)
      .setName('重置同步状态')
      .setDesc('仅清空本插件的文件对照表，不删除本地或远端文件。')
      .addButton((button) =>
        button
          .setButtonText('重置')
          .setWarning()
          .onClick(() => plugin.resetSyncState())
      );

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        '说明：空文件夹不会同步；首次同步会对比两端已有文件。' +
        '更改 WebDAV 地址或远程根目录后，建议先“重置同步状态”。' +
        '同一时间建议只让一台设备执行同步，避免两端同时修改同一文件。',
    });
  }
}

module.exports = WebDAVrSyncPlugin;
module.exports.WebDAVClient = WebDAVClient;
module.exports.SyncEngine = SyncEngine;
module.exports.WebDAVrSyncSettingTab = WebDAVrSyncSettingTab;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.DEFAULT_IGNORE_TEXT = DEFAULT_IGNORE_TEXT;
module.exports.CONFIG_FORMAT = CONFIG_FORMAT;
module.exports.CONFIG_FORMAT_VERSION = CONFIG_FORMAT_VERSION;
module.exports.BACKUP_FORMAT = BACKUP_FORMAT;
module.exports.BACKUP_FILE_FORMAT = BACKUP_FILE_FORMAT;
module.exports.BACKUP_FORMAT_VERSION = BACKUP_FORMAT_VERSION;
module.exports.normalizeSettings = normalizeSettings;
module.exports.parseConfigImport = parseConfigImport;
module.exports.encryptBackupBundle = encryptBackupBundle;
module.exports.decryptBackupBundle = decryptBackupBundle;
module.exports.scanSecretFields = scanSecretFields;
module.exports.legacyCopilotSecretId = legacyCopilotSecretId;
module.exports.compileIgnore = compileIgnore;
module.exports.formatSummary = formatSummary;
