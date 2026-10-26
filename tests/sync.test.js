/*
 * Run with:  bun test tests/sync.test.js
 *
 * The test suite starts an in-memory WebDAV server and a fake Obsidian
 * DataAdapter, then exercises the real WebDAVClient and SyncEngine from
 * main.js. The `obsidian` module is replaced with a tiny stub.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import http from 'node:http';

function requestUrlStub(options) {
  const { url, method = 'GET', headers = {}, body } = options || {};
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            arrayBuffer: buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength
            ),
            text: buffer.toString('utf8'),
          });
        });
      }
    );
    request.on('error', reject);
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') request.write(body, 'utf8');
      else request.write(Buffer.from(body));
    }
    request.end();
  });
}

class FakeElement {
  constructor() {
    this.style = {};
    this.textContent = '';
  }
  empty() {}
  createEl() {
    return new FakeElement();
  }
  setText(text) {
    this.textContent = text;
  }
  setAttribute() {}
  addClass() {}
  addEventListener() {}
}

class FakeModal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeElement();
  }
  open() {}
  close() {}
}

class FakePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return null;
  }
  async saveData(data) {
    this.savedData = data;
  }
  addStatusBarItem() {
    return new FakeElement();
  }
  addRibbonIcon() {
    return new FakeElement();
  }
  addCommand(command) {
    this.commands = this.commands || [];
    this.commands.push(command);
  }
  addSettingTab(tab) {
    this.settingTab = tab;
  }
  registerEvent() {}
  registerInterval(id) {
    return id;
  }
}

class FakeTextComponent {
  constructor() {
    this.inputEl = { type: '', min: '', max: '', rows: 0, style: {}, value: '' };
  }
  setPlaceholder() {
    return this;
  }
  setValue(value) {
    this.inputEl.value = value;
    return this;
  }
  onChange() {
    return this;
  }
}

class FakeButtonComponent {
  setButtonText() {
    return this;
  }
  setCta() {
    return this;
  }
  setWarning() {
    return this;
  }
  setDisabled() {
    return this;
  }
  onClick() {
    return this;
  }
}

class FakeDropdownComponent {
  addOption() {
    return this;
  }
  setValue() {
    return this;
  }
  onChange() {
    return this;
  }
}

class FakeToggleComponent {
  setValue() {
    return this;
  }
  onChange() {
    return this;
  }
}

class FakeSetting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addText(callback) {
    callback(new FakeTextComponent());
    return this;
  }
  addTextArea(callback) {
    callback(new FakeTextComponent());
    return this;
  }
  addButton(callback) {
    callback(new FakeButtonComponent());
    return this;
  }
  addDropdown(callback) {
    callback(new FakeDropdownComponent());
    return this;
  }
  addToggle(callback) {
    callback(new FakeToggleComponent());
    return this;
  }
}

mock.module('obsidian', () => ({
  Plugin: FakePlugin,
  PluginSettingTab: class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  },
  Setting: FakeSetting,
  Notice: class Notice {},
  TFile: class TFile {},
  Modal: FakeModal,
  requestUrl: requestUrlStub,
}));

const pluginModule = await import('../main.js');
const WebDAVrSyncPlugin = pluginModule.default || pluginModule;
const {
  WebDAVClient,
  SyncEngine,
  WebDAVrSyncSettingTab,
  DEFAULT_SETTINGS,
  CONFIG_FORMAT,
  BACKUP_FORMAT,
  BACKUP_FILE_FORMAT,
  normalizeSettings,
  parseConfigImport,
  encryptBackupBundle,
  decryptBackupBundle,
  compileIgnore,
} = pluginModule;

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class MockDavServer {
  constructor(username, password) {
    this.username = username || 'u';
    this.password = password || 'p';
    this.entries = new Map();
    this.entries.set('', { isDir: true, mtime: Date.now(), etag: 'root' });
    this.counter = 0;
    this.server = Bun.serve({
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.url = 'http://127.0.0.1:' + this.server.port;
  }

  stop() {
    this.server.stop(true);
  }

  pathOf(request) {
    const raw = new URL(request.url).pathname;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch (error) {
      decoded = raw;
    }
    return normalizePath(decoded);
  }

  authorized(request) {
    const header = request.headers.get('authorization') || '';
    const expected =
      'Basic ' + Buffer.from(this.username + ':' + this.password).toString('base64');
    return header === expected;
  }

  setFile(path, content, mtime) {
    const key = normalizePath(path);
    this.ensureParents(key);
    const data =
      typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    this.entries.set(key, {
      isDir: false,
      data,
      mtime: mtime || Date.now(),
      etag: 'e' + ++this.counter,
    });
  }

  getFile(path) {
    return this.entries.get(normalizePath(path));
  }

  ensureParents(path) {
    const parts = normalizePath(path).split('/');
    parts.pop();
    let current = '';
    if (!this.entries.has('')) {
      this.entries.set('', { isDir: true, mtime: Date.now(), etag: 'root' });
    }
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      if (!this.entries.has(current)) {
        this.entries.set(current, { isDir: true, mtime: Date.now(), etag: 'dir' });
      }
    }
  }

  entryXml(path, entry) {
    const encoded = path
      ? '/' + path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
      : '/';
    const href = encoded + (entry.isDir && !encoded.endsWith('/') ? '/' : '');
    const resourceType = entry.isDir
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : '<D:resourcetype/>';
    const length = entry.isDir ? '' : '<D:getcontentlength>' + entry.data.byteLength + '</D:getcontentlength>';
    return [
      '<D:response>',
      '<D:href>' + xmlEscape(href) + '</D:href>',
      '<D:propstat>',
      '<D:prop>',
      resourceType,
      length,
      '<D:getlastmodified>' + new Date(entry.mtime).toUTCString() + '</D:getlastmodified>',
      '<D:getetag>"' + xmlEscape(entry.etag) + '"</D:getetag>',
      '</D:prop>',
      '<D:status>HTTP/1.1 200 OK</D:status>',
      '</D:propstat>',
      '</D:response>',
    ].join('');
  }

  async handle(request) {
    if (!this.authorized(request)) {
      return new Response('unauthorized', { status: 401 });
    }

    const method = request.method.toUpperCase();
    const path = this.pathOf(request);
    const entry = this.entries.get(path);

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: { DAV: '1,2', Allow: 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL' },
      });
    }

    if (method === 'PROPFIND') {
      if (!entry) return new Response('not found', { status: 404 });
      const depth = request.headers.get('depth') || '1';
      const included = [path];
      if (depth !== '0' && entry.isDir) {
        const prefix = path ? path + '/' : '';
        for (const [key, value] of this.entries) {
          if (!key || key === path) continue;
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest && !rest.includes('/')) included.push(key);
        }
      }
      const body =
        '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
        included.map((key) => this.entryXml(key, this.entries.get(key))).join('') +
        '</D:multistatus>';
      return new Response(body, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (method === 'MKCOL') {
      if (entry) return new Response('exists', { status: 405 });
      const parent = path.split('/').slice(0, -1).join('/');
      const parentEntry = this.entries.get(parent);
      if (!parentEntry || !parentEntry.isDir) return new Response('conflict', { status: 409 });
      this.entries.set(path, { isDir: true, mtime: Date.now(), etag: 'dir' });
      return new Response(null, { status: 201 });
    }

    if (method === 'PUT') {
      if (!path) return new Response('bad path', { status: 405 });
      const parent = path.split('/').slice(0, -1).join('/');
      const parentEntry = this.entries.get(parent);
      if (!parentEntry || !parentEntry.isDir) return new Response('conflict', { status: 409 });
      const existed = !!entry;
      const data = new Uint8Array(await request.arrayBuffer());
      this.entries.set(path, {
        isDir: false,
        data,
        mtime: Date.now(),
        etag: 'e' + ++this.counter,
      });
      return new Response(null, { status: existed ? 204 : 201 });
    }

    if (method === 'GET') {
      if (!entry || entry.isDir) return new Response('not found', { status: 404 });
      return new Response(entry.data, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          ETag: '"' + entry.etag + '"',
          'Last-Modified': new Date(entry.mtime).toUTCString(),
        },
      });
    }

    if (method === 'DELETE') {
      if (!entry) return new Response('not found', { status: 404 });
      if (entry.isDir) {
        const prefix = path + '/';
        for (const key of this.entries.keys()) {
          if (key.startsWith(prefix)) return new Response('not empty', { status: 409 });
        }
      }
      this.entries.delete(path);
      return new Response(null, { status: 204 });
    }

    return new Response('method not allowed', { status: 405 });
  }
}

class MemoryAdapter {
  constructor() {
    this.entries = new Map();
    this.entries.set('', { isDir: true, mtime: Date.now() });
  }

  path(value) {
    return normalizePath(value);
  }

  async exists(path) {
    return this.entries.has(this.path(path));
  }

  async stat(path) {
    const entry = this.entries.get(this.path(path));
    if (!entry) throw new Error('ENOENT: ' + path);
    return {
      type: entry.isDir ? 'folder' : 'file',
      size: entry.isDir ? 0 : entry.data.byteLength,
      mtime: entry.mtime,
      ctime: entry.mtime,
    };
  }

  async list(dir) {
    const base = this.path(dir);
    const prefix = base ? base + '/' : '';
    const files = [];
    const folders = [];
    for (const [key, entry] of this.entries) {
      if (!key || key === base || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      if (entry.isDir) folders.push(key);
      else files.push(key);
    }
    return { files, folders };
  }

  async readBinary(path) {
    const entry = this.entries.get(this.path(path));
    if (!entry || entry.isDir) throw new Error('ENOENT: ' + path);
    return entry.data.slice().buffer;
  }

  async writeBinary(path, data) {
    const key = this.path(path);
    this.ensureParents(key);
    let bytes;
    if (data instanceof Uint8Array) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else {
      bytes = new Uint8Array(data.slice(0));
    }
    this.entries.set(key, { isDir: false, data: bytes, mtime: Date.now() });
  }

  async mkdir(path) {
    const key = this.path(path);
    if (this.entries.has(key)) {
      if (this.entries.get(key).isDir) return;
      throw new Error('EEXIST: ' + path);
    }
    this.ensureParents(key);
    this.entries.set(key, { isDir: true, mtime: Date.now() });
  }

  async remove(path) {
    const key = this.path(path);
    if (!this.entries.has(key)) throw new Error('ENOENT: ' + path);
    this.entries.delete(key);
  }

  async rename(oldPath, newPath) {
    const from = this.path(oldPath);
    const to = this.path(newPath);
    const entry = this.entries.get(from);
    if (!entry) throw new Error('ENOENT: ' + oldPath);
    this.entries.delete(from);
    this.ensureParents(to);
    this.entries.set(to, entry);
  }

  ensureParents(path) {
    if (!this.entries.has('')) this.entries.set('', { isDir: true, mtime: Date.now() });
    const parts = this.path(path).split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      if (!this.entries.has(current)) {
        this.entries.set(current, { isDir: true, mtime: Date.now() });
      }
    }
  }

  async writeText(path, text) {
    await this.writeBinary(path, new TextEncoder().encode(text).buffer);
  }

  readText(path) {
    const entry = this.entries.get(this.path(path));
    if (!entry) return null;
    return new TextDecoder().decode(entry.data);
  }

  setMtime(path, mtime) {
    const entry = this.entries.get(this.path(path));
    if (entry) entry.mtime = mtime;
  }

  files() {
    return Array.from(this.entries.keys()).filter(
      (key) => key && !this.entries.get(key).isDir
    );
  }
}

const servers = [];

afterEach(() => {
  while (servers.length) servers.pop().stop();
});

function makeSettings(server, overrides) {
  return Object.assign({}, DEFAULT_SETTINGS, {
    serverUrl: server.url,
    username: server.username,
    password: server.password,
    remoteRoot: '/vault',
    deviceName: 'TEST',
    syncOnStart: false,
    syncOnChange: false,
    syncIntervalMinutes: 0,
    ...(overrides || {}),
  });
}

async function runSync(adapter, settings, state) {
  const client = new WebDAVClient(settings);
  const engine = new SyncEngine({
    adapter,
    client,
    settings,
    state,
    onPersist: async () => {},
    trashLocal: async (path) => adapter.remove(path),
    log: () => {},
  });
  const summary = await engine.run();
  return { summary, state, client };
}

function newState() {
  return { version: 1, lastSync: 0, files: {} };
}

function makeBackupPlugin() {
  const adapter = new MemoryAdapter();
  const secrets = new Map([
    ['kid1', 'sk-ant-secret'],
    ['copilot-vabcd1234-open-a-i-api-key', 'legacy-secret'],
    ['unrelated-secret', 'ignore-me'],
  ]);
  const secretStorage = {
    listSecrets: () => Array.from(secrets.keys()),
    getSecret: (id) => (secrets.has(id) ? secrets.get(id) : null),
    setSecret: (id, value) => {
      secrets.set(id, value);
    },
    deleteSecret: (id) => {
      secrets.delete(id);
    },
  };
  const app = {
    vault: {
      adapter,
      getName: () => 'TestVault',
      on: () => ({}),
      getAbstractFileByPath: () => null,
      trash: async () => {},
    },
    workspace: {
      onLayoutReady: () => ({}),
    },
    secretStorage,
  };
  const plugin = new WebDAVrSyncPlugin(app, {
    id: 'webdavrsync',
    version: '1.2.0',
  });
  plugin.settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    serverUrl: 'http://example:1080',
    backupIncludePluginCode: false,
  });
  plugin.syncState = newState();
  plugin.recentWrites = new Map();
  plugin.statusBarEl = new FakeElement();
  plugin.syncing = false;
  return { plugin, adapter, secrets, secretStorage };
}

async function seedBackupVault(adapter) {
  await adapter.writeText(
    '.obsidian/plugins/copilot/data.json',
    JSON.stringify({
      userId: 'user-1',
      _keychainVaultId: 'abcd1234',
      providers: {
        p1: {
          providerId: 'p1',
          displayName: 'Anthropic',
          apiKeyKeychainId: 'kid1',
        },
        p2: {
          providerId: 'p2',
          displayName: 'Custom',
          apiKeyKeychainId: 'kid2',
        },
      },
      openAIApiKey: '',
      anthropicApiKey: '',
      configuredModels: [],
    })
  );
  await adapter.writeText(
    '.obsidian/plugins/copilot/manifest.json',
    JSON.stringify({ id: 'copilot', version: '1.0.0' })
  );
  await adapter.writeText(
    '.obsidian/plugins/copilot/main.js',
    'console.log("copilot-main");'
  );
  await adapter.writeText(
    '.obsidian/plugins/other/data.json',
    JSON.stringify({
      apiToken: 'plaintext-token',
      nested: { secret: 'nested-secret' },
      tokenExpiresAt: 123,
    })
  );
  await adapter.writeText(
    '.obsidian/plugins/other/manifest.json',
    JSON.stringify({ id: 'other', version: '1.0.0' })
  );
  await adapter.writeText(
    '.obsidian/plugins/other/main.js',
    'console.log("other-main");'
  );
  await adapter.writeText(
    '.obsidian/plugins/webdavrsync/data.json',
    JSON.stringify({ settings: { password: 'webdav-password' } })
  );
  await adapter.writeText(
    '.obsidian/community-plugins.json',
    JSON.stringify(['copilot', 'other'])
  );
  await adapter.writeText(
    '.obsidian/core-plugins.json',
    JSON.stringify(['file-explorer'])
  );
}

function makeConfigPlugin() {
  const app = {
    vault: {
      on: () => ({}),
      adapter: new MemoryAdapter(),
      getAbstractFileByPath: () => null,
      trash: async () => {},
    },
    workspace: {
      onLayoutReady: () => ({}),
    },
  };
  const plugin = new WebDAVrSyncPlugin(app, {
    id: 'webdavrsync',
    version: '1.1.0',
  });
  plugin.settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    serverUrl: 'http://old.example:1080',
    username: 'obsidian',
    password: 'secret',
    remoteRoot: '/',
    syncIntervalMinutes: 0,
  });
  plugin.syncState = newState();
  plugin.syncState.files['a.md'] = {
    localMtime: 1,
    localSize: 1,
    remoteMtime: 1,
    remoteSize: 1,
    remoteEtag: 'e1',
  };
  plugin.recentWrites = new Map();
  plugin.statusBarEl = new FakeElement();
  plugin.configureInterval = () => {};
  return plugin;
}

describe('WebDAVrSync', () => {
  it('首次同步上传本地文件（含中文和空格路径）', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('笔记/中文 文件.md', '# 你好');

    const settings = makeSettings(server);
    const state = newState();
    const result = await runSync(adapter, settings, state);

    expect(result.summary.errors).toEqual([]);
    expect(result.summary.uploaded).toBe(1);
    const remote = server.getFile('vault/笔记/中文 文件.md');
    expect(remote).toBeTruthy();
    expect(new TextDecoder().decode(remote.data)).toBe('# 你好');
    expect(state.files['笔记/中文 文件.md']).toBeTruthy();
  });

  it('本地修改后上传更新', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('a.md', 'v1');
    const settings = makeSettings(server);
    const state = newState();
    await runSync(adapter, settings, state);

    await adapter.writeText('a.md', 'v2');
    adapter.setMtime('a.md', Date.now() + 3000);
    const result = await runSync(adapter, settings, state);

    expect(result.summary.uploaded).toBe(1);
    expect(new TextDecoder().decode(server.getFile('vault/a.md').data)).toBe('v2');
  });

  it('远端修改后下载更新', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('a.md', 'v1');
    const settings = makeSettings(server);
    const state = newState();
    await runSync(adapter, settings, state);

    server.setFile('vault/a.md', 'remote-v2', Date.now() + 5000);
    const result = await runSync(adapter, settings, state);

    expect(result.summary.downloaded).toBe(1);
    expect(adapter.readText('a.md')).toBe('remote-v2');
  });

  it('双方同时修改时保留冲突副本', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('conflict.md', 'base');
    const settings = makeSettings(server);
    const state = newState();
    await runSync(adapter, settings, state);

    await adapter.writeText('conflict.md', 'local-v2');
    adapter.setMtime('conflict.md', Date.now() + 20000);
    server.setFile('vault/conflict.md', 'remote-v2', Date.now() + 10000);

    const result = await runSync(adapter, settings, state);

    expect(result.summary.conflicts).toBe(1);
    expect(adapter.readText('conflict.md')).toBe('local-v2');
    expect(new TextDecoder().decode(server.getFile('vault/conflict.md').data)).toBe('local-v2');

    const localConflicts = adapter.files().filter((path) => path.includes('(conflict '));
    expect(localConflicts.length).toBe(1);
    expect(adapter.readText(localConflicts[0])).toBe('remote-v2');

    const remoteConflicts = Array.from(server.entries.keys()).filter(
      (path) => path.startsWith('vault/') && path.includes('(conflict ')
    );
    expect(remoteConflicts.length).toBe(1);
    expect(new TextDecoder().decode(server.getFile(remoteConflicts[0]).data)).toBe('remote-v2');
  });

  it('本地删除会传播到远端', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('a.md', 'v1');
    const settings = makeSettings(server);
    const state = newState();
    await runSync(adapter, settings, state);

    await adapter.remove('a.md');
    const result = await runSync(adapter, settings, state);

    expect(result.summary.deletedRemote).toBe(1);
    expect(server.getFile('vault/a.md')).toBeUndefined();
    expect(state.files['a.md']).toBeUndefined();
  });

  it('关闭删除同步后本地删除会从远端恢复', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('a.md', 'v1');
    const settings = makeSettings(server, { allowDeletions: false });
    const state = newState();
    await runSync(adapter, settings, state);

    await adapter.remove('a.md');
    const result = await runSync(adapter, settings, state);

    expect(result.summary.downloaded).toBe(1);
    expect(adapter.readText('a.md')).toBe('v1');
  });

  it('首次同步同内容文件不产生冲突和传输', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('same.md', 'identical');
    adapter.setMtime('same.md', Date.now() - 10000);
    server.setFile('vault/same.md', 'identical', Date.now());
    const settings = makeSettings(server);
    const state = newState();

    const result = await runSync(adapter, settings, state);

    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.downloaded).toBe(0);
    expect(result.summary.conflicts).toBe(0);
    expect(state.files['same.md']).toBeTruthy();
  });

  it('首次同步下载远端独有文件（含空文件）', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    server.setFile('vault/remote-only.md', 'remote');
    server.setFile('vault/empty.txt', '');
    const settings = makeSettings(server);
    const state = newState();

    const result = await runSync(adapter, settings, state);

    expect(result.summary.errors).toEqual([]);
    expect(result.summary.downloaded).toBe(2);
    expect(adapter.readText('remote-only.md')).toBe('remote');
    expect(adapter.readText('empty.txt')).toBe('');
    expect(state.files['remote-only.md']).toBeTruthy();
    expect(state.files['empty.txt']).toBeTruthy();
  });

  it('默认不同步 .obsidian，但开启配置同步后仍排除本插件目录', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('note.md', 'note');
    await adapter.writeText('.obsidian/app.json', '{}');
    await adapter.writeText('.obsidian/plugins/webdavrsync/data.json', '{"password":"secret"}');

    const settings = makeSettings(server);
    const state = newState();
    await runSync(adapter, settings, state);
    expect(server.getFile('vault/.obsidian/app.json')).toBeUndefined();

    const settings2 = makeSettings(server, { syncConfig: true });
    const state2 = newState();
    await runSync(adapter, settings2, state2);
    expect(server.getFile('vault/.obsidian/app.json')).toBeTruthy();
    expect(server.getFile('vault/.obsidian/plugins/webdavrsync/data.json')).toBeUndefined();
    expect(server.getFile('vault/note.md')).toBeTruthy();
  });

  it('默认忽略备份目录和恢复 .bak 文件', () => {
    const ignore = compileIgnore({
      ...DEFAULT_SETTINGS,
      ignoreText: '',
      backupFolder: '.webdavrsync-backups',
    });
    expect(ignore('.webdavrsync-backups/backup.wdrsbackup')).toBe(true);
    expect(
      ignore('.obsidian/plugins/copilot/data.json.pre-restore-20261026.bak')
    ).toBe(true);
    expect(ignore('notes/a.md')).toBe(false);
  });

  it('默认忽略 node_modules 和嵌套 .git', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('proj/package.json', '{}');
    await adapter.writeText('proj/node_modules/pkg/index.js', 'x');
    await adapter.writeText('proj/.git/config', 'x');
    const settings = makeSettings(server);
    const state = newState();

    const result = await runSync(adapter, settings, state);

    expect(result.summary.errors).toEqual([]);
    expect(server.getFile('vault/proj/package.json')).toBeTruthy();
    expect(server.getFile('vault/proj/node_modules/pkg/index.js')).toBeUndefined();
    expect(server.getFile('vault/proj/.git/config')).toBeUndefined();
  });

  it('密码错误时中止同步并给出认证错误', async () => {
    const server = new MockDavServer();
    servers.push(server);
    const adapter = new MemoryAdapter();
    await adapter.writeText('a.md', 'v1');
    const settings = makeSettings(server, { password: 'wrong' });
    const state = newState();

    await expect(runSync(adapter, settings, state)).rejects.toThrow(/认证失败/);
  });

  it('插件 onload/onunload 冒烟测试', async () => {
    const app = {
      vault: {
        on: () => ({}),
        adapter: new MemoryAdapter(),
        getAbstractFileByPath: () => null,
        trash: async () => {},
      },
      workspace: {
        onLayoutReady: (callback) => callback(),
      },
    };
    const plugin = new WebDAVrSyncPlugin(app, { id: 'webdavrsync' });
    await plugin.onload();
    expect(plugin.commands.length).toBe(2);
    expect(plugin.statusBarEl.textContent).toContain('WebDAVrSync');
    plugin.onunload();
  });

  it('设置页面可以完整渲染（Obsidian API 冒烟测试）', () => {
    const plugin = {
      settings: Object.assign({}, DEFAULT_SETTINGS, {
        serverUrl: 'http://127.0.0.1:1',
      }),
      describeState: () => '尚未同步',
      saveSettings: async () => {},
      runSync: async () => {},
      testConnection: async () => {},
      resetSyncState: async () => {},
    };
    const tab = new WebDAVrSyncSettingTab({}, plugin);
    tab.containerEl = new FakeElement();
    expect(() => tab.display()).not.toThrow();
  });
});

describe('配置导出/导入', () => {
  it('导出配置可以包含或排除密码', () => {
    const plugin = makeConfigPlugin();
    const withPassword = plugin.buildConfigExport(true);
    expect(withPassword.format).toBe(CONFIG_FORMAT);
    expect(withPassword.formatVersion).toBe(1);
    expect(withPassword.pluginVersion).toBe('1.1.0');
    expect(withPassword.passwordIncluded).toBe(true);
    expect(withPassword.settings.password).toBe('secret');

    const withoutPassword = plugin.buildConfigExport(false);
    expect(withoutPassword.passwordIncluded).toBe(false);
    expect(withoutPassword.settings.password).toBe('');
    expect(withoutPassword.settings.serverUrl).toBe('http://old.example:1080');
  });

  it('导入不含密码的配置时保留当前密码', () => {
    const plugin = makeConfigPlugin();
    const imported = parseConfigImport(
      JSON.stringify(plugin.buildConfigExport(false)),
      plugin.settings
    );
    expect(imported.passwordIncluded).toBe(false);
    expect(imported.settings.password).toBe('secret');
    expect(imported.settings.serverUrl).toBe('http://old.example:1080');
  });

  it('导入新服务器会清空文件对照表', async () => {
    const plugin = makeConfigPlugin();
    const next = normalizeSettings({
      ...plugin.settings,
      serverUrl: 'http://new.example:1080',
      remoteRoot: '/vault',
      password: 'newpass',
    });
    const imported = parseConfigImport(
      JSON.stringify({
        format: CONFIG_FORMAT,
        formatVersion: 1,
        passwordIncluded: true,
        settings: next,
      }),
      plugin.settings
    );

    const result = await plugin.applyConfigImport(imported, { skipConfirm: true });
    expect(result.ok).toBe(true);
    expect(result.targetChanged).toBe(true);
    expect(plugin.settings.serverUrl).toBe('http://new.example:1080');
    expect(plugin.settings.remoteRoot).toBe('/vault');
    expect(plugin.settings.password).toBe('newpass');
    expect(Object.keys(plugin.syncState.files).length).toBe(0);
  });

  it('导入相同服务器会保留文件对照表', async () => {
    const plugin = makeConfigPlugin();
    const imported = parseConfigImport(
      JSON.stringify({
        format: CONFIG_FORMAT,
        formatVersion: 1,
        passwordIncluded: false,
        settings: {
          serverUrl: 'http://old.example:1080',
          remoteRoot: '/',
          username: 'other',
          syncIntervalMinutes: 0,
        },
      }),
      plugin.settings
    );

    const result = await plugin.applyConfigImport(imported, { skipConfirm: true });
    expect(result.ok).toBe(true);
    expect(result.targetChanged).toBe(false);
    expect(plugin.settings.username).toBe('other');
    expect(plugin.settings.password).toBe('secret');
    expect(plugin.syncState.files['a.md']).toBeTruthy();
  });

  it('拒绝无效配置', () => {
    const plugin = makeConfigPlugin();
    expect(() => parseConfigImport('{bad json', plugin.settings)).toThrow();
    expect(() =>
      parseConfigImport(
        JSON.stringify({ format: 'other-plugin', settings: { serverUrl: 'http://x' } }),
        plugin.settings
      )
    ).toThrow();
    const empty = normalizeSettings({ ...DEFAULT_SETTINGS, serverUrl: '' });
    expect(() =>
      parseConfigImport(
        JSON.stringify({ format: CONFIG_FORMAT, settings: { username: 'u' } }),
        empty
      )
    ).toThrow();
    expect(() =>
      parseConfigImport(
        JSON.stringify({
          format: CONFIG_FORMAT,
          formatVersion: 999,
          settings: { serverUrl: 'http://x' },
        }),
        plugin.settings
      )
    ).toThrow(/版本过新/);
  });

  it('可以直接导入插件 data.json 形状的文件', () => {
    const plugin = makeConfigPlugin();
    const raw = {
      settings: Object.assign({}, plugin.settings, {
        serverUrl: 'http://raw.example:1080',
      }),
      state: { version: 1, lastSync: 123, files: { 'x.md': {} } },
    };
    const imported = parseConfigImport(JSON.stringify(raw), plugin.settings);
    expect(imported.settings.serverUrl).toBe('http://raw.example:1080');
    expect(imported.passwordIncluded).toBe(true);
    expect(imported.settings.password).toBe('secret');
  });

  it('同步进行中拒绝导入配置', async () => {
    const plugin = makeConfigPlugin();
    plugin.syncing = true;
    const imported = parseConfigImport(
      JSON.stringify(plugin.buildConfigExport(true)),
      plugin.settings
    );
    await expect(
      plugin.applyConfigImport(imported, { skipConfirm: true })
    ).rejects.toThrow(/同步正在进行/);
  });

  it('normalizeSettings 会修正非法数值和冲突策略', () => {
    const settings = normalizeSettings({
      syncIntervalMinutes: 9999,
      conflictStrategy: 'unknown',
    });
    expect(settings.syncIntervalMinutes).toBe(1440);
    expect(settings.conflictStrategy).toBe('keep-both');
    expect(settings.backupFolder).toBe('.webdavrsync-backups');
    expect(settings.backupKeep).toBe(10);
    expect(settings.backupIncludePluginCode).toBe(false);
  });
});

describe('插件配置与密钥备份', () => {
  it('收集插件配置、其他插件明文 token 和 Copilot Keychain 密钥', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);

    const bundle = await plugin.collectPluginBackup({
      includePluginCode: false,
    });

    expect(bundle.format).toBe(BACKUP_FORMAT);
    expect(bundle.vaultName).toBe('TestVault');
    expect(bundle.excludedPlugins).toContain('webdavrsync');
    expect(bundle.plugins.map((item) => item.id).sort()).toEqual([
      'copilot',
      'other',
    ]);

    const copilot = bundle.plugins.find((item) => item.id === 'copilot');
    expect(copilot.files['data.json']).toBeTruthy();
    expect(copilot.files['manifest.json']).toBeTruthy();
    expect(copilot.files['main.js']).toBeUndefined();

    const other = bundle.plugins.find((item) => item.id === 'other');
    expect(other.files['data.json'].data).toContain('plaintext-token');

    expect(
      bundle.copilotSecrets.map((item) => item.keychainId).sort()
    ).toEqual(['copilot-vabcd1234-open-a-i-api-key', 'kid1']);
    expect(
      bundle.copilotSecrets.find((item) => item.keychainId === 'kid1').value
    ).toBe('sk-ant-secret');
    expect(
      bundle.copilotSecrets.find(
        (item) => item.keychainId === 'copilot-vabcd1234-open-a-i-api-key'
      ).value
    ).toBe('legacy-secret');

    expect(
      bundle.detectedSecrets.some(
        (item) =>
          item.plugin === 'other' &&
          item.path === 'apiToken' &&
          item.kind === 'plaintext'
      )
    ).toBe(true);
    expect(
      bundle.detectedSecrets.some(
        (item) =>
          item.plugin === 'copilot' &&
          item.path.includes('apiKeyKeychainId') &&
          item.kind === 'keychain-ref'
      )
    ).toBe(true);
    expect(bundle.vaultConfig['community-plugins.json'].data).toContain(
      'copilot'
    );
    expect(bundle.stats.copilotSecretCount).toBe(2);
    expect(bundle.warnings).toEqual([]);
  });

  it('开启插件代码备份后会包含 main.js', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);

    const bundle = await plugin.collectPluginBackup({
      includePluginCode: true,
    });
    const copilot = bundle.plugins.find((item) => item.id === 'copilot');
    expect(copilot.files['main.js']).toBeTruthy();
    expect(copilot.files['main.js'].encoding).toBe('utf8');
    expect(copilot.files['main.js'].data).toContain('copilot-main');

    const other = bundle.plugins.find((item) => item.id === 'other');
    expect(other.files['main.js']).toBeTruthy();
  });

  it('加密备份可以正确解密，错误密码会失败', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);
    const bundle = await plugin.collectPluginBackup({
      includePluginCode: false,
    });

    const envelope = await encryptBackupBundle(bundle, 'password123', {
      iterations: 10000,
    });
    expect(envelope.format).toBe(BACKUP_FILE_FORMAT);
    expect(envelope.cipher).toBe('AES-256-GCM');
    expect(envelope.kdf).toBe('PBKDF2-SHA256');
    expect(envelope.ciphertext.length).toBeGreaterThan(100);

    const decrypted = await decryptBackupBundle(envelope, 'password123');
    expect(decrypted.copilotSecrets.length).toBe(2);
    expect(decrypted.plugins.length).toBe(2);

    await expect(
      decryptBackupBundle(envelope, 'wrong-password')
    ).rejects.toThrow(/密码错误/);
  });

  it('恢复备份会写回插件配置和 Copilot 密钥，并生成 .bak', async () => {
    const { plugin, adapter, secrets } = makeBackupPlugin();
    await seedBackupVault(adapter);
    const bundle = await plugin.collectPluginBackup({
      includePluginCode: true,
    });

    await adapter.writeText(
      '.obsidian/plugins/copilot/data.json',
      '{"old":true}'
    );
    await adapter.writeText(
      '.obsidian/plugins/copilot/main.js',
      'console.log("old");'
    );
    secrets.set('kid1', 'old-key');

    const result = await plugin.restorePluginBackup(bundle, {
      skipConfirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.restoredFiles).toBeGreaterThan(0);
    expect(result.restoredSecrets).toBe(2);
    expect(
      adapter.readText('.obsidian/plugins/copilot/data.json')
    ).toContain('apiKeyKeychainId');
    expect(
      adapter.readText('.obsidian/plugins/copilot/main.js')
    ).toContain('copilot-main');
    expect(secrets.get('kid1')).toBe('sk-ant-secret');
    expect(secrets.get('copilot-vabcd1234-open-a-i-api-key')).toBe(
      'legacy-secret'
    );
    expect(
      adapter.files().filter((path) => path.includes('.pre-restore-')).length
    ).toBeGreaterThan(0);
  });

  it('不包含插件代码时不恢复 manifest.json', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);
    const bundle = await plugin.collectPluginBackup({
      includePluginCode: false,
    });

    await adapter.writeText(
      '.obsidian/plugins/copilot/manifest.json',
      '{"version":"current-installed"}'
    );

    await plugin.restorePluginBackup(bundle, { skipConfirm: true });

    expect(
      adapter.readText('.obsidian/plugins/copilot/manifest.json')
    ).toContain('current-installed');
    expect(
      adapter.readText('.obsidian/plugins/copilot/data.json')
    ).toContain('apiKeyKeychainId');
  });

  it('SecretStorage 不可用时给出警告但仍备份插件配置', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);
    delete plugin.app.secretStorage;

    const bundle = await plugin.collectPluginBackup({
      includePluginCode: false,
    });

    expect(bundle.plugins.length).toBe(2);
    expect(bundle.copilotSecrets.length).toBe(0);
    expect(bundle.warnings.join(' ')).toMatch(/SecretStorage/);
  });

  it('同步进行中拒绝恢复插件备份', async () => {
    const { plugin, adapter } = makeBackupPlugin();
    await seedBackupVault(adapter);
    const bundle = await plugin.collectPluginBackup({
      includePluginCode: false,
    });
    plugin.syncing = true;
    await expect(
      plugin.restorePluginBackup(bundle, { skipConfirm: true })
    ).rejects.toThrow(/同步正在进行/);
  });
});
