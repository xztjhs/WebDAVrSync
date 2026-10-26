# Changelog

All notable changes to WebDAVrSync are documented in this file.

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
