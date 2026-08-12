"""
前端版本號解析規則的單一來源。

修改這裡的規則會同時影響 .pipeline/check_frontend_versions.py（只檢查、
不改動，跑在每個 PR 上當關卡）與 .pipeline/bump_versions.py（實際修改
版本號）；調整任何一條規則時必須一併確認兩個呼叫端的行為。

【為什麼要抽出來】

兩支工具原本各自寫了一份解析邏輯，其中「index.html 的 ?v= 怎麼認」
兩邊寫法不同，導致同一份 index.html 在兩支工具眼中版本號不一樣：

  check：限定 src/href 屬性，且只認 .js 與 .css
  bump ：直接對整份 HTML 掃 ?v=(\\d+)，什麼都算

差別在 manifest.json。它在 index.html 是 manifest.json?v=28（帶查詢
字串），但在 sw.js 的 APP_SHELL 裡是 ./manifest.json（不帶），兩者本來
就不共用版本號、也不該一起 bump。bump 的寬鬆寫法會把它算進版本一致性
判斷（於是誤判成不一致而中止），改寫時也會連它一起改掉。

所以這裡採用 check 的限定寫法，並且「讀」與「寫」共用同一條規則——
只共用讀取的正則、卻讓寫入維持全域替換，等於 bug 只修一半。
"""

import re

# index.html 裡帶版本號的本地資源。限定 src/href 屬性，且只認 .js 與 .css，
# 所以 manifest.json?v=N 不會被算進來，也不會被改寫。
# 拆成具名群組是為了讓「讀」與「寫」共用同一條規則：改寫時把 version 換掉，
# 其餘部分（含原本的引號與 ./ 前綴）原樣拼回去。
_INDEX_VERSIONED_ASSET_RE = re.compile(
    r'(?P<prefix>(?:src|href)\s*=\s*["\']\.?/?)'
    r'(?P<path>[^"\'?]+\.(?:js|css))'
    r'\?v=(?P<version>[^"\']+)'
    r'(?P<quote>["\'])'
)

# index.html 引用的本地 js/css，不論有沒有帶 ?v=。
_INDEX_LOCAL_ASSET_RE = re.compile(
    r'(?:src|href)\s*=\s*["\'](\.?/?[^"\':]+\.(?:js|css))(?:\?[^"\']*)?["\']'
)

# index.html 裡任何帶 ?v= 的本地資源，不限副檔名。
# 用來找出「帶了版本號、但不受這裡管理」的資源（例如 manifest.json?v=28），
# 那種資源若在 APP_SHELL 裡是不帶查詢字串的形式，就永遠不會命中快取。
_INDEX_ANY_VERSIONED_ASSET_RE = re.compile(
    r'(?:src|href)\s*=\s*["\']\.?/?(?P<path>[^"\'?]+)\?v=(?P<version>[^"\']+)["\']'
)

# sw.js 的 APP_SHELL 陣列裡帶版本號的項目。同樣只認 .js 與 .css，
# 讓 APP_SHELL 之後若加入 ./manifest.json?v=N 這類項目也不會被誤改。
_SHELL_VERSIONED_ENTRY_RE = re.compile(
    r'(?P<prefix>["\']\.?/?[^"\']*\.(?:js|css))'
    r'\?v=(?P<version>[^"\']+)'
    r'(?P<quote>["\'])'
)

_CACHE_NAME_RE = re.compile(r'const\s+CACHE_NAME\s*=\s*["\']([^"\']+)["\']')
_APP_SHELL_BLOCK_RE = re.compile(r"const\s+APP_SHELL\s*=\s*\[(.*?)\]", re.S)
_QUOTED_STRING_RE = re.compile(r'["\']([^"\']+)["\']')
_DYNAMIC_IMPORT_RE = re.compile(r'import\s*\(\s*["\'](\.[^"\']+\.js)["\']\s*\)')


def parse_index_versions(html: str) -> dict:
    """從 index.html 取出本地資源的 ?v= 版本，回傳 {檔名: 版本}。"""
    return {
        m.group("path"): m.group("version")
        for m in _INDEX_VERSIONED_ASSET_RE.finditer(html)
    }


def parse_index_unmanaged_versions(html: str) -> dict:
    """
    index.html 裡帶了 ?v= 但不屬於受管理範圍（.js／.css）的資源，
    回傳 {檔名: 版本}。

    這是 parse_index_versions() 的補集。這些資源的版本號不歸這裡管，
    但它們如果同時出現在 sw.js 的 APP_SHELL 且那邊不帶查詢字串，
    Cache API 就永遠對不上——check_frontend_versions.py 用這個函式
    把那種情況揪出來。
    """
    out = {}
    for m in _INDEX_ANY_VERSIONED_ASSET_RE.finditer(html):
        path = m.group("path")
        if path.endswith(".js") or path.endswith(".css"):
            continue
        out[path] = m.group("version")
    return out


def parse_index_local_assets(html: str) -> set:
    """從 index.html 取出所有本地 js/css 引用（不論有沒有 ?v=）。"""
    out = set()
    for m in _INDEX_LOCAL_ASSET_RE.finditer(html):
        path = m.group(1).lstrip("./")
        if not path.startswith("http"):
            out.add(path)
    return out


def parse_cache_name(sw: str) -> str:
    m = _CACHE_NAME_RE.search(sw)
    return m.group(1) if m else ""


def parse_app_shell(sw: str) -> list:
    """取出 APP_SHELL 陣列裡的每一個字串項目（保留 ?v= 部分）。"""
    m = _APP_SHELL_BLOCK_RE.search(sw)
    if not m:
        return []
    return _QUOTED_STRING_RE.findall(m.group(1))


def parse_dynamic_imports(js: str) -> set:
    """取出 await import("./xxx.js") 這類動態載入的本地路徑。"""
    return {m.group(1).lstrip("./") for m in _DYNAMIC_IMPORT_RE.finditer(js)}


def rewrite_index_versions(html: str, new_version) -> str:
    """
    把 index.html 裡受管理的資源版本號改成 new_version。

    只改 parse_index_versions() 認得的那些（src/href 上的 .js 與 .css），
    其餘的 ?v=（例如 manifest.json?v=28）原樣不動——讀與寫必須用同一條
    規則，否則會改到不該改的東西。
    """
    return _INDEX_VERSIONED_ASSET_RE.sub(
        lambda m: f"{m.group('prefix')}{m.group('path')}?v={new_version}{m.group('quote')}",
        html,
    )


def rewrite_app_shell_versions(sw: str, new_version) -> str:
    """
    把 sw.js 的 APP_SHELL 裡受管理的項目版本號改成 new_version。

    範圍限定同上：只改 .js 與 .css 的項目。
    """
    return _SHELL_VERSIONED_ENTRY_RE.sub(
        lambda m: f"{m.group('prefix')}?v={new_version}{m.group('quote')}",
        sw,
    )
