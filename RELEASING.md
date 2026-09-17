# Vimo Worker 发布

更新源配置在 `release.config.json`，默认仓库为 `1172620300/vimo-worker`。仓库需要公开，客户端才能匿名检查和下载更新。

1. 修改 `package.json` 中的版本号，例如 `0.1.1`，并运行 `npm install --package-lock-only` 同步锁文件。
2. 本机运行 `npm test` 和 `npm run build:release`。产物位于 `dist/`，包含安装包、`latest.yml` 和 blockmap。
3. 提交代码，创建与版本一致的标签，例如 `v0.1.1`，然后推送标签。GitHub Actions 会创建 Release 并上传更新文件。
4. 在 GitHub Release 正文填写更新说明。客户端启动约 5 秒后自动检查，发现新版时由用户决定是否下载和安装。

不要单独修改 `latest.yml`，它的文件名、大小和 SHA512 必须与同一次构建生成的安装包一致。
