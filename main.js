'use strict';

/*
 * WebDAVrSync 1.1.0
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
  requestUrl,
} = require('obsidian');

const PLUGIN_ID = 'webdavrsync';
const PLUGIN_VERSION_FALLBACK = '1.1.0';
const STATE_VERSION = 1;
const CONFIG_FORMAT = 'webdavrsync-config';
const CONFIG_FORMAT_VERSION = 1;

const DEFAULT_IGNORE_TEXT = [
  '# 每行一个 glob：* 匹配同一层，** 匹配任意层，? 匹配单个字符',
  '# 以 # 开头的行是注释；不支持 ! 取反',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/plugins/webdavrsync/**',
  '.trash/**',
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

function compileIgnore(settings) {
  const regexes = [];
  const add = (pattern) => {
    for (const re of globToRegExps(pattern)) regexes.push(re);
  };

  for (const line of String(settings.ignoreText || '').split(/\r?\n/)) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    add(pattern);
  }

  if (!settings.syncConfig) {
    add('.obsidian');
    add('.obsidian/**');
  }

  // Never sync this plugin's own folder: data.json contains the WebDAV
  // password and would otherwise be uploaded to the server.
  add('.obsidian/plugins/' + PLUGIN_ID);
  add('.obsidian/plugins/' + PLUGIN_ID + '/**');

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
    ignoreText:
      typeof merged.ignoreText === 'string' ? merged.ignoreText : DEFAULT_SETTINGS.ignoreText,
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

function formatSummary(summary) {
  const parts = [];
  if (summary.uploaded) parts.push('↑' + summary.uploaded);
  if (summary.downloaded) parts.push('↓' + summary.downloaded);
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

  async ensureParents(path) {
    const parts = normalizeRelPath(path).split('/');
    parts.pop();
    let current = '';
    for (const segment of parts) {
      current = current ? current + '/' + segment : segment;
      if (!this.dirCache.has(current)) await this.mkcol(current);
    }
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
    this.remote = new Map();
    this.summary = {
      uploaded: 0,
      downloaded: 0,
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
    this.remote = new Map();
    for (const [path, entry] of remoteAll) {
      if (!entry.isDir && !this.isIgnored(path)) this.remote.set(path, entry);
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
        if (!this.isIgnored(folder)) directories.push(folder);
      }
      for (const file of listing.files || []) {
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
          if (stat && stat.type === 'folder') continue;
          files.set(file, {
            path: file,
            size: Number(stat && stat.size) || 0,
            mtime: Number(stat && stat.mtime) || 0,
          });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          if (/ENOENT|no such file|not found/i.test(message)) continue;
          throw new Error('无法读取本地文件信息 ' + file + '：' + message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, allFiles.length || 1) }, () => worker())
    );
    return files;
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
      Number(localEntry.mtime) !== Number(stateEntry.localMtime) ||
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
      localMtime: Number(localEntry && localEntry.mtime) || 0,
      localSize: Number(localEntry && localEntry.size) || 0,
      remoteMtime: Number(remoteEntry && remoteEntry.mtime) || 0,
      remoteSize: Number(remoteEntry && remoteEntry.size) || 0,
      remoteEtag: (remoteEntry && remoteEntry.etag) || '',
      syncedAt: Date.now(),
    };
  }

  async syncOne(path, localEntry, remoteEntry) {
    const stateEntry = this.state.files ? this.state.files[path] : null;

    if (!localEntry && !remoteEntry) {
      if (stateEntry) delete this.state.files[path];
      return;
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

      const data = await this.adapter.readBinary(path);
      const after = await this.safeStat(path);
      if (!after) throw new SkipError('本地文件在读取过程中被删除');
      if (
        Number(after.mtime) !== Number(before.mtime) ||
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
    if (await this.adapter.exists(path)) {
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
        const text = await file.text();
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
      .setDesc('示例：http://192.168.254.253:1080（可省略 http://）')
      .addText((text) =>
        text
          .setPlaceholder('http://192.168.254.253:1080')
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
module.exports.normalizeSettings = normalizeSettings;
module.exports.parseConfigImport = parseConfigImport;
module.exports.compileIgnore = compileIgnore;
module.exports.formatSummary = formatSummary;
