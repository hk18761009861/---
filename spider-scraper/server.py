#!/usr/bin/env python3
"""蜘蛛爬虫 · 本地抓取服务

只用 Python 标准库，无需 pip 安装：
    python server.py            # 默认 http://localhost:8765
    python server.py 9000       # 指定端口
    python server.py --no-open  # 不自动打开浏览器

提供两样东西：
  /                 前端页面（index.html 及同目录静态文件）
  /api/crawl?url=   抓取一个网页，返回结构化 JSON（标题/段落/列表/表格/图片/链接）

浏览器有跨域限制，不能直接读别的网站，所以真正的抓取在这里完成，
前端只负责展示与蜘蛛特效。
"""
import ipaddress
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import webbrowser
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UA = "Mozilla/5.0 (compatible; SpiderScraper/1.0; +local)"
MAX_BYTES = 4 * 1024 * 1024
TIMEOUT = 15

SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "head", "canvas", "select", "button"}
BLOCK_TAGS = {
    "p", "div", "section", "article", "main", "aside", "header", "footer", "nav", "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "dl", "dt", "dd", "figure",
    "figcaption", "form", "fieldset", "address", "hr", "br", "table", "tr", "body", "center",
}
VOID_TAGS = {"br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "source", "track", "wbr"}


class Extractor(HTMLParser):
    """把 HTML 拆成按文档顺序排列的内容块。"""

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.stack = []          # 当前打开的标签
        self.skip = 0            # 处于 script/style 等内部的层数
        self.buf = []            # 当前块的文字
        self.buf_links = []      # 当前块里的链接
        self.link = None         # 正在读取的 <a>
        self.blocks = []
        self.links = []          # 全页链接（去重）
        self._seen_links = set()
        self.title = ""
        self.in_title = False
        self.description = ""
        self.table = None        # 正在读取的表格 [[cell, ...], ...]
        self.cell = None
        self.table_depth = 0

    # ---- helpers ----
    def _abs(self, href):
        href = (href or "").strip()
        if not href or href.startswith(("javascript:", "mailto:", "tel:", "#", "data:")):
            return None
        u = urllib.parse.urljoin(self.base, href)
        u, _ = urllib.parse.urldefrag(u)
        return u if u.startswith(("http://", "https://")) else None

    def _kind(self):
        for t in reversed(self.stack):
            if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
                return "h", int(t[1])
            if t == "li":
                return "li", 0
            if t in ("blockquote",):
                return "quote", 0
            if t == "pre":
                return "pre", 0
        return "p", 0

    def flush(self):
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        links = self.buf_links
        self.buf, self.buf_links = [], []
        if len(text) < 2:
            return
        kind, level = self._kind()
        blk = {"kind": kind, "text": text}
        if level:
            blk["level"] = level
        if links:
            blk["links"] = links
        self.blocks.append(blk)

    # ---- parser callbacks ----
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            name = (a.get("name") or a.get("property") or "").lower()
            if name in ("description", "og:description") and not self.description:
                self.description = (a.get("content") or "").strip()
            return
        if tag == "title":
            self.in_title = True
            return
        if tag in SKIP_TAGS:
            if tag not in VOID_TAGS:
                self.skip += 1
            return
        if self.skip:
            return

        if tag == "table":
            if self.table is None:
                self.flush()
                self.table = []
            self.table_depth += 1
        elif self.table is not None and tag == "tr" and self.table_depth == 1:
            self.table.append([])
        elif self.table is not None and tag in ("td", "th") and self.table_depth == 1:
            self.cell = []
        elif tag in BLOCK_TAGS and self.table is None:
            self.flush()

        if tag == "a":
            self.link = {"href": self._abs(a.get("href")), "text": []}
        elif tag == "img":
            src = self._abs(a.get("src") or a.get("data-src") or a.get("data-original"))
            if src and self.table is None:
                self.flush()
                self.blocks.append({"kind": "img", "src": src, "text": (a.get("alt") or "").strip()})
        elif tag == "br":
            if self.cell is not None:
                self.cell.append(" ")
            else:
                self.buf.append(" ")

        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
            return
        if tag in SKIP_TAGS:
            if self.skip:
                self.skip -= 1
            return
        if self.skip:
            return

        if tag == "a" and self.link is not None:
            text = re.sub(r"\s+", " ", "".join(self.link["text"])).strip()
            href = self.link["href"]
            if href:
                item = {"href": href, "text": text}
                if self.cell is None:
                    self.buf_links.append(item)
                if href not in self._seen_links:
                    self._seen_links.add(href)
                    self.links.append(item)
            self.link = None

        if self.table is not None:
            if tag in ("td", "th") and self.cell is not None and self.table_depth == 1:
                if not self.table:
                    self.table.append([])
                self.table[-1].append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
                self.cell = None
            elif tag == "table":
                self.table_depth -= 1
                if self.table_depth == 0:
                    rows = [r for r in self.table if any(c for c in r)]
                    if rows:
                        self.blocks.append({"kind": "table", "rows": rows[:200]})
                    self.table = None
        elif tag in BLOCK_TAGS:
            self.flush()

        # 弹出到匹配的标签（容忍不规范的 HTML）
        if tag in self.stack:
            while self.stack:
                if self.stack.pop() == tag:
                    break

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if self.skip:
            return
        if self.link is not None:
            self.link["text"].append(data)
        if self.cell is not None:
            self.cell.append(data)
        elif self.table is None:
            self.buf.append(data)

    def close(self):
        super().close()
        self.flush()


# ---------------------------------------------------------------- fetching
class CrawlError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def check_target(url):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise CrawlError("请输入以 http:// 或 https:// 开头的网址")
    # 默认不抓本机 / 内网地址（避免被当作跳板访问内网服务）；
    # 要抓自己内网的页面，启动前设置环境变量 SPIDER_ALLOW_LOCAL=1
    if os.environ.get("SPIDER_ALLOW_LOCAL") == "1":
        return
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except socket.gaierror:
        infos = []  # 走代理时本地可能解析不了，交给代理处理
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise CrawlError("出于安全考虑，不抓取本机或内网地址")


_robots_cache = {}


def robots_allowed(url):
    p = urllib.parse.urlparse(url)
    origin = f"{p.scheme}://{p.netloc}"
    rp = _robots_cache.get(origin)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(origin + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                rp.parse(r.read(512 * 1024).decode("utf-8", "replace").splitlines())
        except Exception:
            rp.parse([])  # 读不到 robots.txt 视为允许
        _robots_cache[origin] = rp
    return rp.can_fetch(UA, url)


def decode(raw, content_type):
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    enc = m.group(1) if m else None
    if not enc:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", raw[:4096], re.I)
        enc = m.group(1).decode("ascii", "ignore") if m else None
    if enc and enc.lower() in ("gb2312", "gbk"):
        enc = "gb18030"
    for e in filter(None, [enc, "utf-8", "gb18030"]):
        try:
            return raw.decode(e)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


def crawl(url):
    check_target(url)
    if not robots_allowed(url):
        raise CrawlError("该网站的 robots.txt 不允许抓取这个页面", 403)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            final = r.geturl()
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "xml" not in ctype and ctype:
                raise CrawlError(f"不是网页（Content-Type: {ctype}）", 415)
            raw = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise CrawlError(f"对方网站返回 HTTP {e.code}", 502)
    except urllib.error.URLError as e:
        raise CrawlError(f"连接失败：{e.reason}", 502)
    except (TimeoutError, socket.timeout):
        raise CrawlError("请求超时", 504)
    if final != url:
        check_target(final)
    ex = Extractor(final)
    ex.feed(decode(raw[:MAX_BYTES], ctype))
    ex.close()
    return {
        "url": final,
        "title": re.sub(r"\s+", " ", ex.title).strip(),
        "description": ex.description,
        "blocks": ex.blocks,
        "links": ex.links,
        "truncated": len(raw) > MAX_BYTES,
    }


# ---------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[spider] " + (fmt % args) + "\n")

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/crawl":
            url = (urllib.parse.parse_qs(parsed.query).get("url") or [""])[0].strip()
            try:
                self._json(200, crawl(url))
            except CrawlError as e:
                self._json(e.status, {"error": str(e)})
            except Exception as e:  # 解析异常等
                self._json(500, {"error": f"抓取出错：{e}"})
            return
        if parsed.path in ("/server.py",):
            self.send_error(404)
            return
        super().do_GET()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"🕷  蜘蛛爬虫已启动：http://localhost:{port}   （Ctrl+C 退出）")
    if "--no-open" not in sys.argv:
        webbrowser.open(f"http://localhost:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
