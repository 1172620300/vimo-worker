# Vimo gateway 版本监控补丁

目标实例：`i-bp1cqdy98q154gv8a1lp`（cn-hangzhou，h3-dispatch profile）。
目标服务：`vimo-gateway.service`。
当前工作目录：`/opt/vimo/releases/20260916-admin`。

新增 `worker_versions.py`，更新 `vimo_workers.py` 与 `admin-static/app.js`。不需要 schema migration：版本信息存入现有 workers.body JSON 字段。后台继续使用原有登录验证。

原始文件 SHA256：

- vimo_workers.py：57f7bf8b7ad0e85f45d2de53ef9eeedf679800d0031a3bc1e73a06e274cfb0cd
- admin-static/app.js：dab35284d29fad303dffc1246a0bc34bcc20c322101f407c21cb877e85491b73

部署前检查当前文件是否仍匹配，避免覆盖其他任务的修改。先运行测试：`python -m unittest -v test_worker_versions.py`。测试依赖版本与线上一致，见 requirements-test.txt。

上线需要服务重启。现有 app.py 启动时会将 running 任务标记失败，因此必须先通过后台暂停接单，并等待所有正在执行任务结束。不要仅依据 health.queue_depth=0 判断无任务，因为任务可能正在运行。

维护窗口中备份上述文件，复制新文件并原子替换；重启服务，确认 /health、旧版心跳、新版心跳和登录后的 Worker 列表。异常时恢复原文件、删除本次新增的 worker_versions.py，再重启。不要修改或删除 SQLite 数据库、密钥和 outputs 内容。

服务端最新版来源固定为 Worker GitHub Releases，成功缓存六小时、失败十五分钟后重试。未上报当前版本、没有稳定 Release 或检查失败均显示未知，不能误报已是最新。阶段一不实施 minimum/recommended 的任务阻断策略。
