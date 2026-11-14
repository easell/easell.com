#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
easell.com 阿里云部署脚本
─────────────────────────────────────────────────────────
用途：把本地 dist 构建产物发布到阿里云轻量服务器（47.104.165.13）。

用法（在项目根目录执行）：
    SRV_PWD='服务器root密码' python scripts/deploy-aliyun.py
    SRV_PWD='...' python scripts/deploy-aliyun.py --skip-build   # 只上传，不重新构建

做的事：
    1. npm run build（除非 --skip-build）
    2. 打包 dist → tar.gz
    3. SFTP 上传到服务器 /tmp
    4. 解压到 dist.new → 原子切换（旧的留作 dist.old，便于回退）
    5. 从公网验证首页/关键页状态码

为什么不用 git push 自动部署：
    站点已从 Cloudflare Pages 迁到阿里云内地节点（备案要求），
    Cloudflare 的 Git 自动构建不再影响线上。以后更新流程 = 本脚本。

依赖：pip install paramiko
注意：密码只从环境变量读取，不落盘。
"""
import os
import subprocess
import sys
import tarfile
import tempfile

import paramiko

HOST = "47.104.165.13"
USER = "root"
REMOTE_ROOT = "/var/www/easell"
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

sys.stdout.reconfigure(encoding="utf-8")


def run_local(cmd, cwd=PROJECT):
    print(f"\n▶ {cmd}")
    r = subprocess.run(cmd, shell=True, cwd=cwd)
    if r.returncode != 0:
        sys.exit(f"✗ 本地命令失败：{cmd}")


def build_tar():
    dist = os.path.join(PROJECT, "dist")
    if not os.path.isdir(dist):
        sys.exit("✗ 找不到 dist 目录，请先构建")
    tmp = os.path.join(tempfile.gettempdir(), "easell-deploy.tar.gz")
    if os.path.exists(tmp):
        os.remove(tmp)
    print(f"\n▶ 打包 dist → {tmp}")
    with tarfile.open(tmp, "w:gz") as tar:
        for name in os.listdir(dist):
            tar.add(os.path.join(dist, name), arcname=name)
    size = os.path.getsize(tmp) / 1024 / 1024
    print(f"  包大小 {size:.2f} MB")
    return tmp


def deploy(tar_path, pwd):
    print(f"\n▶ 连接 {HOST}")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, pwd, timeout=20, banner_timeout=30)

    def sh(cmd, t=300):
        si, so, se = c.exec_command(cmd, timeout=t)
        out = so.read().decode("utf-8", "replace").strip()
        err = se.read().decode("utf-8", "replace").strip()
        if so.channel.recv_exit_status() != 0:
            print(f"  ! {err[-400:]}")
        return out

    sftp = c.open_sftp()
    print("▶ 上传中…")
    sftp.put(tar_path, "/tmp/easell-deploy.tar.gz")
    sftp.close()

    print("▶ 解压并原子切换")
    out = sh(
        f"rm -rf {REMOTE_ROOT}/dist.new && mkdir -p {REMOTE_ROOT}/dist.new && "
        f"tar -xzf /tmp/easell-deploy.tar.gz -C {REMOTE_ROOT}/dist.new && "
        f"chown -R www-data:www-data {REMOTE_ROOT}/dist.new && "
        f"rm -rf {REMOTE_ROOT}/dist.old && mv {REMOTE_ROOT}/dist {REMOTE_ROOT}/dist.old && "
        f"mv {REMOTE_ROOT}/dist.new {REMOTE_ROOT}/dist && "
        f"echo OK && find {REMOTE_ROOT}/dist -name '*.html' | wc -l"
    )
    print(f"  完成：{out}")

    print("\n▶ 服务器端自检")
    for path in ["/", "/quality/", "/contact/"]:
        code = sh(
            "curl -sk -o /dev/null -w '%{http_code}' "
            f"--resolve www.easell.com:443:127.0.0.1 https://www.easell.com{path}"
        )
        print(f"  {path:14} {code}")
    c.close()


def verify_public():
    print("\n▶ 公网验证")
    for path in ["/", "/quality/", "/news/"]:
        r = subprocess.run(
            f'curl -4 --noproxy "*" -s -o /dev/null -w "%{{http_code}}" https://www.easell.com{path}',
            shell=True, capture_output=True, text=True,
        )
        print(f"  {path:14} {r.stdout.strip()}")


def main():
    pwd = os.environ.get("SRV_PWD", "")
    if not pwd:
        sys.exit("✗ 请先设置密码环境变量：SRV_PWD='密码' python scripts/deploy-aliyun.py")

    if "--skip-build" not in sys.argv:
        run_local("npm run build")

    tar_path = build_tar()
    deploy(tar_path, pwd)
    verify_public()
    print("\n✓ 部署完成")


if __name__ == "__main__":
    main()
