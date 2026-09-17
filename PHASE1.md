# 第一阶段发布与版本监控

本仓库与 `1172620300/vimo-desktop` 独立。当前 Worker 为 `0.1.0`；Desktop 下一补丁版为 `0.1.1`，不要求同步升级。

## 当前能力

- Windows NSIS 安装包、启动检查更新、人工下载、SHA512（更新库）和 SHA256（额外校验）。
- GUI 与独立 Agent 都可以检查 Worker Releases。Agent 每六小时检查，失败十五分钟后重试。
- Agent 心跳包含 `workerVersion`、`latestVersion`、`updateAvailable`、`updateState` 和 `hostname`。
- 后台版本展示代码在 `server-integration/`，适用于已核验的 Vimo gateway 部署。
- 远端发布先创建草稿，全部资产上传完成才公开；发布脚本拒绝覆盖既有 Release。

## 运行配置与已有节点

`VIMO_WORKER_HOME` 可指定现有恢复模块的数据目录（绝对路径）。它包含 `config.json`、`secrets/`、`logs/`、状态文件和 ComfyUI 启动配置。GUI、Supervisor 和 Agent 必须使用相同目录、相同 Windows 账号。环境变量不是秘密，不应在其中填写 Token。

未设置变量的源码部署继续使用已有 `recovery/config.json`；打包安装后的新配置默认位于 `%APPDATA%/vimo-worker-client/recovery/`。安装包不携带任何机器凭据。安装器不会自动把已有的独立服务、计划任务或源码目录迁移到新程序。已有节点首次切换前，应由管理员保留数据目录并重新指定 Supervisor 程序路径；新机器仍需部署 ComfyUI、SSH 和节点配置。

第一阶段没有启动/升级 Supervisor 的服务安装器。GUI 安装完成不代表旧 Agent 已升级：服务器展示以实际运行 Agent 的心跳版本为准。不要把 GUI 版本当作执行节点版本。

## 更新安全边界

尚未完成调度端排空确认、服务退出与重启健康检查，因此生产 Worker 的自动重启安装关闭。下载校验完成后会显示维护升级说明；管理员应先在后台暂停接单，等待正在运行任务结束，再人工升级整个节点的程序。配置、模型、日志和工作目录必须保留。

后续阶段再接入 DRAINING/UPDATING、空闲自动升级、开机启动、顶层进程恢复和回滚。当前安装包未配置可信 Windows 签名证书；构建日志中的 signtool 步骤不代表已签名。

## 发布

1. 修改 `package.json` 并同步 lockfile；运行 `npm ci`、`npm test`、`npm run build:release`。
2. 产物为 `Vimo-Worker-Setup-X.Y.Z.exe`、`.exe.blockmap`、`latest.yml` 和 `SHA256SUMS.txt`。
3. 提交并推送本仓库 `vX.Y.Z` 标签，GitHub Actions 自动构建与发布。标签版本必须与 package 一致。
4. 在分支上手动运行 workflow 只构建 artifact，不发布；`npm run release` 仅允许匹配标签的 CI 环境。
5. 如上传失败，保留草稿，客户端看不到残缺资产。检查后人工处理草稿，不能覆盖已发布的版本。

任何正式发布之前，必须在 Windows 测试节点验证旧版到新版升级、配置保留、主程序启动和实际 Agent 心跳。
