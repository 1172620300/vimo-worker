
# Vimo Worker

Vimo 独立算力客户端。发布源为本仓库的 GitHub Releases，版本与 Vimo Desktop 独立。

开发：`npm ci`、`npm test`、`npm start`。构建：`npm run build:release`。

当前阶段支持检查、下载、SHA256 校验和 Agent 版本上报；自动重启安装暂未启用。现有节点部署配置与维护步骤见 [PHASE1.md](PHASE1.md)。服务端补丁位于 [server-integration](server-integration/DEPLOYMENT.md)。
