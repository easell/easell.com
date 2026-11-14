#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""备用推送通道：本地无法直连 github.com:443 时，改走 GitHub Git Data API 复刻提交

背景：中国大陆网络下 `git push` 常被重置（schannel/502/超时），而 api.github.com 往往仍可访问。
做法：读取本地提交链（author/committer/时间/消息/文件内容逐字照抄），在远端用 API 重建同样的
      commit 对象——因为输入完全相同，最终 SHA 与本地一致，不会产生分叉，以后网络恢复仍可正常 push。

用法：
    GIT_API_PROXY=http://127.0.0.1:53688 python scripts/api-push.py --dry-run   # 演练，不写远端
    python scripts/api-push.py                                                  # 真正推送

前置：repo 有写权限的 PAT 已存在 git credential（host=github.com）；远端 HEAD 必须是本地 HEAD 的祖先。
"""
from __future__ import annotations

import base64
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

REPO = os.environ.get("GIT_API_REPO", "easell/easell.com")
BRANCH = os.environ.get("GIT_API_BRANCH", "main")
PROXY = os.environ.get("GIT_API_PROXY") or None
DRY = "--dry-run" in sys.argv


def sh(*args: str, binary: bool = False):
    out = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return out.stdout if binary else out.stdout.decode("utf-8", "replace")


def token() -> str:
    p = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                       stdout=subprocess.PIPE, text=True, check=True,
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    for line in p.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("git credential 里没有 github.com 的令牌")


OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}) if PROXY else urllib.request.ProxyHandler({})
)


def api(method: str, path: str, body: dict | None = None) -> dict:
    url = f"https://api.github.com/repos/{REPO}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "easell-api-push",
    })
    last = ""
    for attempt in range(4):
        try:
            with OPENER.open(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {method} {path}: {e.read().decode('utf-8', 'replace')[:400]}"
            if e.code in (401, 403, 404, 409, 422):   # 永久性错误，重试无意义
                break
        except Exception as e:                        # 网络类错误，退避重试
            last = f"ERR {method} {path}: {e}"
        if attempt < 3:
            import time
            time.sleep(2 * (attempt + 1))
    raise SystemExit(last)


def parse_commit(sha: str):
    raw = sh("git", "cat-file", "commit", sha)
    head, _, message = raw.partition("\n\n")
    meta = {}
    for line in head.splitlines():
        if line.startswith("author "):
            meta["author"] = line[7:]
        elif line.startswith("committer "):
            meta["committer"] = line[10:]
    return meta["author"], meta["committer"], message


def ident(raw: str) -> dict:
    """'Name <email> 1710000000 +0800' -> GitHub 需要的 {name,email,date}"""
    name_email, _, ts = raw.rpartition("> ")
    name, _, email = (name_email + ">").partition(" <")
    epoch, _, tz = ts.partition(" ")
    offset = (1 if tz[0] == "+" else -1) * (int(tz[1:3]) * 60 + int(tz[3:5]))
    dt = datetime.datetime.fromtimestamp(int(epoch), datetime.timezone(datetime.timedelta(minutes=offset)))
    return {"name": name, "email": email.rstrip(">"), "date": dt.isoformat()}


def changes(parent: str | None, sha: str):
    """返回 [(path, mode|None, blob|None)]；blob 为 None 表示该提交删除了这个文件"""
    if parent is None:                                  # 首个提交：整棵树都要上传
        out = []
        for rec in sh("git", "ls-tree", "-r", "-z", sha).split("\x00"):
            if rec:
                meta, _, path = rec.partition("\t")
                mode, _, blob = meta.split(" ")
                out.append((path, mode, blob))
        return out
    fields = [p for p in sh("git", "diff-tree", "-r", "-z", "--no-commit-id", "--no-renames",
                            "--diff-filter=ADM", "--name-status", parent, sha).split("\x00") if p]
    out = []
    for i in range(0, len(fields) - 1, 2):
        status, path = fields[i], fields[i + 1]
        if status.startswith("D"):
            out.append((path, None, None))
            continue
        rec = sh("git", "ls-tree", sha, "--", path).strip()
        if not rec:
            continue
        mode, _, blob = rec.split("\t")[0].split(" ")
        out.append((path, mode, blob))
    return out


TOKEN = token()


def main() -> None:
    remote_sha = api("GET", f"/git/ref/heads/{BRANCH}")["object"]["sha"]
    head = sh("git", "rev-parse", "HEAD").strip()
    print(f"remote {BRANCH} = {remote_sha}")
    print(f"HEAD          = {head}")
    try:
        sh("git", "merge-base", "--is-ancestor", remote_sha, head)
    except subprocess.CalledProcessError:
        raise SystemExit("远端 HEAD 不是本地 HEAD 的祖先，不能快进；请先手工核对，不要强推")

    commits = sh("git", "rev-list", "--reverse", f"{remote_sha}..{head}").split()
    print(f"待复刻提交 {len(commits)} 个")
    if not commits:
        print("已是最新，无需推送")
        return

    mapped: dict[str, str] = {remote_sha: remote_sha}
    parent_tree = sh("git", "rev-parse", f"{remote_sha}^{{tree}}").strip()
    for sha in commits:
        author, committer, message = parse_commit(sha)
        real_parent = sh("git", "rev-parse", f"{sha}^").strip()
        entries = []
        for path, mode, blob in changes(real_parent, sha):
            if blob is None:
                entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                continue
            content = sh("git", "cat-file", "blob", blob, binary=True)
            new_blob = api("POST", "/git/blobs",
                           {"content": base64.b64encode(content).decode(), "encoding": "base64"})
            entries.append({"path": path, "mode": mode, "type": "blob", "sha": new_blob["sha"]})
        print(f"  {sha[:8]} {message.splitlines()[0][:50]}  ({len(entries)} 文件)")
        if DRY:
            mapped[sha] = sha
            continue
        tree = api("POST", "/git/trees", {"base_tree": parent_tree, "tree": entries})
        commit = api("POST", "/git/commits", {
            "message": message,
            "tree": tree["sha"],
            "parents": [mapped[real_parent]],
            "author": ident(author),
            "committer": ident(committer),
        })
        if commit["sha"] != sha:
            print(f"    ! SHA 不一致：本地 {sha} → 远端 {commit['sha']}（内容相同，仅元数据差异）")
        mapped[sha] = commit["sha"]
        parent_tree = tree["sha"]

    if DRY:
        print("dry-run 结束，未写入远端")
        return
    final = mapped[commits[-1]]
    api("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": final, "force": False})
    print(f"已更新 refs/heads/{BRANCH} -> {final}")
    if final == head:
        print("远端 SHA 与本地一致，执行下面这条让跟踪引用归位：")
        print(f"  git update-ref refs/remotes/origin/{BRANCH} {final}")


if __name__ == "__main__":
    main()
