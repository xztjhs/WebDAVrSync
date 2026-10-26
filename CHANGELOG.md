# Changelog

All notable changes to WebDAVrSync are documented in this file.

## 1.2.0 — 2026-10-26

### Added

- 加密插件配置与密钥备份（`.wdrsbackup`）：
  - 收集所有插件的 `data.json`、`manifest.json` 和 JSON/YAML/TOML/INI/CONF/TXT 配置文件；
  - 可选包含插件代码（`main.js`、`styles.css` 等）；
  - 读取 Copilot 在 Obsidian Keychain / SecretStorage 中的 API Key：
    provider 的 `apiKeyKeychainId`，以及 `copilot-v<vaultId>-...` 形式的旧版/模型级密钥；
  - 其他插件明文写入 `data.json` 的 token/key 会随配置文件进入备份；
  - AES-256-GCM + PBKDF2-SHA256（210,000 次）加密，密码不保存；
  - 本地下载 + WebDAV 上传，支持保留最近 N 个备份；
  - 从本地 `.wdrsbackup` 或远端备份列表恢复；
  - 恢复前生成 `.pre-restore-*.bak`，恢复 Copilot 密钥到 Keychain。
- 备份文件夹默认 `.webdavrsync-backups`，已加入同步忽略规则，避免被普通同步拉回本地。

### Changed

- 版本号升至 1.2.0。
- 设置项新增 `backupFolder`、`backupKeep`、`backupIncludePluginCode`。
- 使用手册增加加密备份/恢复、Copilot Keychain 机制和安全说明。

### Tested

- 29 个 Bun 集成测试通过，新增插件备份收集、Copilot Keychain 密钥、明文 token 扫描、
  加密/解密、恢复、SecretStorage 不可用、manifest 恢复策略等用例。

## 1.1.0 — 2026-10-26

### Added

- 配置导出 / 导入：
  - 导出含密码的 JSON，可直接在另一台机器恢复全部设置；
  - 导出不含密码的 JSON，导入时保留当前密码；
  - 可直接导入插件目录下的 `data.json`（只读取 settings，忽略 state）；
  - 导入前弹窗显示服务器、根目录、密码处理方式；
  - 服务器或远程根目录变化时自动清空文件对照表。
- 专门的 `使用手册.md`，包含其他机器安装、配置导入导出、SFTPGo/Unraid 故障排查。
- `CHANGELOG.md`。

### Changed

- 连接失败提示现在包含实际请求 URL，并提示检查 SFTPGo 的 Docker 端口映射和防火墙。
- 设置加载统一经过 `normalizeSettings`，自动修正非法间隔、冲突策略等字段。
- 版本号升至 1.1.0。

### Tested

- 20 个 Bun 集成测试通过，新增配置导出/导入、密码保留、状态清空/保留、无效配置拒绝等用例。

## 1.0.0 — 2026-10-25

### Added

- 本地 Obsidian 仓库与 WebDAV 双向同步。
- 上传、下载、删除传播、冲突副本。
- 手动同步、启动同步、定时同步、编辑停止后自动同步。
- 可选同步 `.obsidian` 配置；本插件目录始终排除。
- 忽略规则 glob、内容校验、状态栏进度。
- `install.ps1` 安装脚本和 MIT 许可证。
