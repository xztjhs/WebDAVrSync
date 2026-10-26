# WebDAVrSync

一个轻量、开源、免费的 Obsidian 双向同步插件。只使用 WebDAV，不依赖 S3、Dropbox、OneDrive 等任何专有服务。

> **重要：** 如果本仓库仍启用了 Remotely Save 或其他同步插件，请先停用它们。
> 两个同步插件同时写同一批文件会造成冲突。

- 无构建步骤、无第三方运行时依赖：`main.js` 即可直接运行。
- 支持 SFTPGo、Nextcloud、ownCloud、Apache mod_dav、nginx-dav 等标准 WebDAV 服务。
- 保留完整源码，MIT 许可证，可自由修改、分发、商用。

## 功能

- 本地仓库 ↔ WebDAV 双向同步（上传、下载、删除）。
- 手动同步、定时同步、启动时同步、编辑停止后自动同步。
- 冲突默认“保留双方”：较新版本保留原文件名，较旧版本保存为
  `文件名 (conflict 20261025-143000 设备名).扩展名`。
- 可切换为“仅保留较新版本”。
- 关闭“删除同步”后，删除不会传播，已删除的一侧会从另一侧恢复。
- 可选择是否同步 `.obsidian` 配置；本插件目录始终排除（避免密码上传）。
- 首次同步或双方同时修改时，可逐字节校验同尺寸文件，减少误报冲突。
- 中文、空格、特殊字符路径按 URL 编码处理。
- 状态栏显示同步进度，点击状态栏可立即同步。
- 配置导出 / 导入：可导出含密码或不含密码的 JSON，在另一台机器快速恢复设置。
- 加密插件配置与密钥备份：包含所有插件 `data.json`、其他配置文件、Copilot Keychain API Key，以及其他插件明文 token/key。
- 详细图文步骤见 [使用手册.md](使用手册.md)。

## 安装

### 方法一：复制文件夹（推荐）

把整个 `webdavrsync` 文件夹放到目标仓库：

```text
<你的 Obsidian 仓库>/.obsidian/plugins/webdavrsync/
```

确保目录中有 `manifest.json` 和 `main.js`，然后：

1. 打开 Obsidian → 设置 → 第三方插件（Community plugins）。
2. 关闭“安全模式”（如果尚未关闭）。
3. 在“已安装插件”中找到 **WebDAVrSync**，启用。
4. 打开插件设置，填写 WebDAV 地址、用户名、密码、远程根目录。
5. 点击“测试连接”，成功后点击“立即同步”。

### 方法二：PowerShell 安装脚本

在插件目录中运行：

```powershell
.\install.ps1 -VaultPath "D:\我的Obsidian仓库"
```

如需连同本机配置（含密码）一起复制：

```powershell
.\install.ps1 -VaultPath "D:\我的Obsidian仓库" -WithConfig
```

加 `-Enable` 会把插件写入目标仓库的 `community-plugins.json`（需要重启 Obsidian）：

```powershell
.\install.ps1 -VaultPath "D:\我的Obsidian仓库" -Enable
```

> 如果 Obsidian 正在运行，复制或启用后请重启 Obsidian，或执行命令面板中的
> “Reload app without saving”。

> 把插件文件夹复制到另一台机器时，`data.json` 中的“文件对照表”属于原机器。
> 建议删除 `data.json` 后重新填写账号，或在插件设置中点击一次“重置同步状态”。

## 配置说明

| 设置 | 说明 |
| --- | --- |
| WebDAV 地址 | 例如 `http://192.168.254.253:1080`，可省略 `http://` |
| 用户名 / 密码 | HTTP Basic Auth 凭据 |
| 远程根目录 | `/` 表示账号根目录；`/obsidian` 表示同步到该子目录（不存在会自动创建） |
| 设备名称 | 仅用于冲突文件名，例如 `PC`、`Laptop` |
| 同步间隔 | 分钟；`0` 表示关闭定时同步 |
| 启动时自动同步 | Obsidian 启动后约 4 秒执行一次 |
| 文件变更后自动同步 | 停止编辑约 8 秒后执行 |
| 删除同步 | 是否把删除传播到另一端 |
| 冲突处理 | 保留双方 / 仅保留较新版本 |
| 同步 .obsidian 配置 | 默认关闭；本插件目录始终排除 |
| 内容校验 | 同尺寸文件逐字节比较，较慢但更安全 |
| 忽略规则 | 每行一个 glob：`*` 匹配一层，`**` 匹配任意层，`#` 注释 |

## 配置导出 / 导入

在插件设置最下方：

- **导出配置（含密码）**：生成 `webdavrsync-config-YYYYMMDD-HHMMSS-with-password.json`，
  包含地址、账号、密码和全部同步设置，可直接在另一台机器导入。文件含明文密码，
  请勿公开分享。
- **导出配置（不含密码）**：适合备份或分享；导入到已有配置时保留当前密码。
- **导入配置**：选择导出的 JSON，也可以直接选择本插件目录下的 `data.json`。

导入时会弹窗显示目标服务器、远程根目录和密码处理方式，确认后才会应用。导入不会
自动同步，也不会导入“文件对照表”：

- 服务器或远程根目录发生变化 → 清空文件对照表，下次同步重新比较两端文件；
- 服务器和根目录未变化 → 保留现有文件对照表，只更新设置。

导入后请先点“测试连接”，确认无误再点“立即同步”。

## 插件配置与密钥备份（加密）

普通的 `.obsidian` 同步会复制各插件的 `data.json`，但 **Copilot 的模型 API Key
不在 `data.json` 里**：当前 Copilot 使用 Obsidian 的 OS Keychain / SecretStorage，
`data.json` 只保存 `apiKeyKeychainId` 引用。因此新增一个独立的加密备份功能。

在插件设置最下方“插件配置与密钥备份（加密）”中：

- **立即创建加密备份**
  - 读取所有插件（不含 WebDAVrSync 自己）的 `data.json`、`manifest.json`，
    以及 `.json` / `.yaml` / `.toml` / `.ini` / `.conf` / `.env` / `.txt` 等配置文件；
  - 其他插件明文写在 `data.json` 里的 token / key 会随配置文件一起进入备份；
  - 读取 Copilot 在 Obsidian Keychain 中的密钥，包括 provider 的
    `apiKeyKeychainId` 和 `copilot-v<vaultId>-...` 形式的模型/旧版密钥；
  - 可选“备份时包含插件代码”（`main.js`、`styles.css` 等）；
  - 使用 **AES-256-GCM + PBKDF2-SHA256（210,000 次）** 加密；
  - 备份文件同时下载到本机，并上传到 WebDAV 的
    `.webdavrsync-backups/` 文件夹（可在设置中修改，默认保留最近 10 个）；
  - 密码不会保存；忘记密码无法恢复。
- **从本地文件恢复**
  - 选择 `.wdrsbackup` 文件，输入密码，恢复插件配置和 Copilot 密钥。
- **从 WebDAV 恢复**
  - 列出远端备份文件夹中的 `.wdrsbackup`，选择后输入密码恢复。

恢复时会：

- 覆盖对应插件的 `data.json` / 其他配置文件；如果备份包含插件代码，也会覆盖
  `manifest.json` 和代码文件（不包含代码时不恢复 `manifest.json`，避免版本不一致）；
- 覆盖前在每个文件旁生成 `.pre-restore-*.bak`（该模式已加入同步忽略，不会上传）；
- 把 Copilot 密钥写回 Obsidian Keychain；
- 备份中会记录 `community-plugins.json` / `core-plugins.json` 供参考，
  但恢复时**不覆盖**这两个启用列表，避免改变当前 Obsidian 的插件启用状态；
- 完成后建议重启 Obsidian。

本功能不包含：

- WebDAVrSync 自己的 `data.json`（用“配置导出”备份它）；
- 其他插件使用 SecretStorage / IndexedDB / localStorage 保存、且未在
  `data.json` 中留下引用的密钥；
- 插件之外的数据（笔记本身仍由普通同步处理；Copilot 保存成 Markdown 的聊天记录
  也属于笔记）。

不包含插件代码时，目标机器应先安装相同或兼容版本的插件；需要完整迁移插件版本时，
可开启“备份时包含插件代码”。

> 备份密码只存在于你的记忆中。忘记密码时，备份文件无法解密。
> 备份文件虽然经过加密，仍建议放在可信的 WebDAV 服务器上，并使用 HTTPS。

> **注意：** 加密备份不会改变普通 `.obsidian` 同步的行为。当前 `syncConfig` 开启时，
> 各插件的 `data.json` 仍会以明文同步到 WebDAV。如果不希望明文上传插件配置，
> 请关闭“同步 .obsidian 配置”，或把 `.obsidian/plugins/*/data.json` 加入忽略规则，
> 然后使用本加密备份恢复插件配置和密钥。

## 同步逻辑

插件在 `data.json` 中维护一份“文件对照表”，记录每个文件上次同步时的：

- 本地修改时间与大小；
- 远端修改时间、大小与 ETag。

每次同步：

1. 扫描本地文件（通过 Obsidian `DataAdapter`，包括 `.obsidian` 等隐藏路径）。
2. 通过 WebDAV `PROPFIND` 递归扫描远端文件。
3. 按路径合并三份数据：本地、远端、上次同步状态。
4. 只有一侧变化 → 传输该侧版本。
5. 两侧都变化 → 按冲突策略处理。
6. 一侧删除、另一侧未变化 → 按“删除同步”设置传播或恢复。
7. 仅一侧存在、且没有历史状态 → 视为新文件，上传或下载。
8. 首次遇到两侧同路径文件 → 比较大小；大小相同且开启内容校验时逐字节比较，
   内容相同则直接标记为已同步。

冲突副本会同时保留在本地和远端，因此两台设备最终都能看到两个版本。

### 不会同步的内容

- 空文件夹（只同步文件；有文件的目录会自动创建）。
- 默认忽略：`.obsidian/workspace.json`、`.obsidian/workspace-mobile.json`、
  `.trash/`、`.webdavrsync-backups/`、`*.pre-restore-*.bak`、任意层级的 `.git/`
  与 `node_modules/`、`.DS_Store`、`Thumbs.db`、`*.tmp`。
- 本插件目录 `.obsidian/plugins/webdavrsync/`（无论是否同步 `.obsidian`）。
- 匹配“忽略规则”的路径。

## 常见错误排查

| 现象 | 可能原因 |
| --- | --- |
| `无法连接 WebDAV ... 目标计算机积极拒绝` | 端口没有监听或被防火墙拦截。SFTPGo 在 Docker 中时，除了在 SFTPGo 里设置 WebDAV 端口，还必须在 Unraid/Docker 容器模板里发布同样的端口（例如 `1080:1080/TCP`）。 |
| `认证失败（HTTP 401）` | 用户名或密码错误；SFTPGo 用户被禁用。 |
| `HTTP 405 Method Not Allowed` | 地址指向了 SFTPGo 管理界面或其他 HTTP 服务，而不是 WebDAV 端口。 |
| `HTTP 404` | 远程根目录不存在且自动创建失败，检查账号权限。 |
| 能连接但同步报错 | 查看 Obsidian 开发者工具 Console 中的 `[WebDAVrSync]` 日志。 |

SFTPGo 默认 WebDAV 端口是 `10080`，管理界面默认是 `8080`。如果修改过端口，请同时检查
Docker 端口映射；只改 SFTPGo 内部端口而不同步修改容器映射，宿主机仍然无法访问。

## 安全说明

- 密码以明文形式保存在本插件目录的 `data.json` 中。本插件目录已被强制排除同步。
- 发布源码或分享插件文件夹前，请删除 `data.json`；仓库中的 `.gitignore` 已忽略它。
- 建议只在可信局域网使用 HTTP；跨公网请使用 HTTPS 反向代理并配置强密码。
- 本插件不实现跨设备互斥锁。请避免两台设备在同一时刻修改同一个文件；
  默认“保留双方”策略会把两个版本都留下。

## 已知限制

- 空目录不同步。
- 远端文件的修改时间是服务器 `Last-Modified`（通常是上传时间），不是原始本地
  mtime；选择“仅保留较新版本”时可能受此影响。默认“保留双方”不受影响。
- 不做大小写不敏感文件系统的路径合并；Windows/macOS 上请避免仅大小写不同的文件名。
- 首次同步大仓库、且开启内容校验时，会比较同尺寸文件，耗时较长。
- WebDAV 服务必须支持 `PROPFIND`、`PUT`、`GET`、`MKCOL`、`DELETE` 和 HTTP Basic Auth。
- 插件主要面向桌面版 Obsidian；移动版能否使用取决于该平台的 `requestUrl`
  是否允许 `PROPFIND` 等自定义方法。

## 开发与测试

插件是纯 CommonJS JavaScript，不需要打包。修改 `main.js` 后重启 Obsidian 即可。

测试使用 [Bun](https://bun.sh)：

```powershell
cd <插件目录>
bun test tests/sync.test.js
```

测试会启动一个内存 WebDAV 服务器和一个模拟的 Obsidian `DataAdapter`，
覆盖上传、下载、冲突、删除、忽略规则、中文路径、配置导出导入、加密备份/恢复等场景。

## 版本历史

- **1.2.0**（2026-10-26）：新增加密插件配置与密钥备份；包含 Copilot Keychain API Key、
  其他插件明文 token/key；支持本地/WebDAV 恢复。
- **1.1.0**（2026-10-26）：新增配置导出 / 导入；连接失败提示更明确；补充使用手册。
- **1.0.0**（2026-10-25）：首个版本，双向同步、冲突副本、定时/自动同步、忽略规则。

完整记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。

---

## English summary

WebDAVrSync is a small, dependency-free, MIT-licensed Obsidian plugin that
synchronizes a vault with any standard WebDAV server. It supports manual,
interval, startup and change-triggered syncs, two-way deletion propagation,
conflict copies, ignore globs, optional `.obsidian` config sync, JSON
config export/import, and an encrypted plugin-config/secrets backup that
includes Copilot Keychain API keys and plaintext plugin tokens. The plugin
folder itself is always excluded because `data.json` contains the WebDAV
password. No build step is required: copy the folder into
`<vault>/.obsidian/plugins/webdavrsync/` and enable it.
