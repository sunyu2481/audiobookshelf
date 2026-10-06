# 自动发布个人 Docker 镜像

[![镜像构建状态](https://github.com/sunyu2481/audiobookshelf/actions/workflows/docker-build.yml/badge.svg?branch=master)](https://github.com/sunyu2481/audiobookshelf/actions/workflows/docker-build.yml)

本仓库的 `.github/workflows/docker-build.yml` 使用 GitHub Actions 自动检查代码、构建镜像并推送到 GitHub 镜像仓库。镜像名称由 GitHub 仓库名自动生成：

```text
ghcr.io/sunyu2481/audiobookshelf
```

工作流支持 `linux/amd64` 和 `linux/arm64`，适用于常见的电脑、服务器和 ARM64 设备。构建前会运行静态检查和测试，包括依赖 FFmpeg／FFprobe 的远程音频探测测试；检查失败时不会发布镜像。

## 发布方式

| 操作 | 发布的镜像标签 |
| --- | --- |
| 推送 `master` 默认分支 | `latest`、`master`、`sha-完整提交编号` |
| 推送 `main` 分支 | `main`、`sha-完整提交编号`；如果它是默认分支，也会发布 `latest` |
| 推送 `v2.37.1` 这样的版本标签 | `v2.37.1`、`2.37.1`、`sha-完整提交编号` |
| 在 Actions 中手动运行 | 对应分支或版本标签，以及填写的额外标签 |

手动运行的输入填写单个标签，例如 `test-strm`，也可以留空。不要填写完整镜像地址。手动指定 `latest` 会更新该标签，适合明确需要切换默认镜像版本的场景。

工作流没有路径过滤，因此依赖锁文件、Dockerfile 和工作流自身的改动同样会触发发布。推送其他普通开发分支不会发布。相同分支连续推送时，旧构建会被取消，优先构建最新提交。工作流保留了提交信息中包含 `skip ci` 时跳过的约定。

## GitHub 配置

1. 在仓库的 Actions 页面启用工作流。Fork 的仓库可能需要手动启用。
2. 提交并推送包含工作流的代码。
3. 在 Actions 中查看“构建并发布 Docker 镜像”，确认检查和发布两个任务成功。
4. 首次发布后，在个人主页的 Packages 中找到 `audiobookshelf`。如果需要匿名拉取，将镜像包的可见性设置为公开；GitHub 代码仓库公开不代表镜像包自动公开。

无需创建 Docker Hub 或 GHCR 的访问令牌。工作流使用自动提供的 `GITHUB_TOKEN`，并只给发布任务授予 `packages: write` 权限。如果已经存在同名镜像包并遇到权限错误，在该包的设置中检查它是否允许当前代码仓库的 Actions 写入。

## 使用和更新镜像

仓库中的 `docker-compose.yml` 已指向个人镜像。首次发布成功后执行：

```sh
docker compose pull
docker compose up -d
```

镜像仓库更新不会自动重启已经运行的容器，需要执行上述更新命令。原有配置、元数据和媒体目录仍通过卷挂载保留。

使用内网 OpenList 的 STRM 功能时，在服务配置中追加：

```yaml
environment:
  SSRF_REQUEST_FILTER_WHITELIST: "192.168.1.1"
```

更多使用说明见 [STRM 文档](strm.md)。如果需要回退，可以将 Compose 中的镜像标签改为某次成功构建的 `sha-完整提交编号`，再执行拉取和更新。

当前工作流只发布到 GHCR。如果以后需要发布到 Docker Hub，需要另外配置 Docker Hub 镜像名、登录用户名和访问令牌。
