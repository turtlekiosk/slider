#!/usr/bin/env python3
"""
Replace (TYPE)&none_proc1 / (TYPE)none_proc1 casts with references to
typed stubs, guarded by #ifdef TARGET_PC.

Algorithm:
 1. Scan all .h/.c/.c_inc for `typedef RET (*NAME)(ARGS);` -> typedef map.
 2. Build include graph: src_file -> set(files it `#include`s, restricted to .c/.c_inc).
 3. Compute reverse graph; identify "translation-unit roots" = .c files NOT included
    by any .c/.c_inc.
 4. For each TU root R, compute transitive closure of includes. Collect TYPES used
    in casts across the closure. Generate one stub-block (per unique type) at the
    top of R, just after the first contiguous run of #include lines.
 5. Replace casts (`(TYPE)&none_proc1` / `(TYPE)none_proc1`) with `_none_<TYPE>` in
    EVERY file (.c and .c_inc). Files that aren't TU roots get casts replaced but
    no stub block — their TU root provides the stubs.
"""
import re
from pathlib import Path
from collections import defaultdict, deque

ROOT = Path("/Users/calvin/Developer/explore/ACGC-PC-Port")
SRC  = ROOT / "src"
INC  = ROOT / "include"

CAST_RE = re.compile(r'\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*&?\s*none_proc1\b')
TYPEDEF_RE = re.compile(
    r'typedef\s+([^;()]+?)\s*\(\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\(([^;]*?)\)\s*;',
    re.DOTALL,
)
INC_RE = re.compile(r'^\s*#include\s+["<]([^">]+)[">]', re.MULTILINE)

_C_KEYWORDS_AND_TYPES = {
    "void","int","char","short","long","float","double","signed","unsigned",
    "const","volatile","restrict","struct","union","enum","static","extern",
    "register","auto","u8","u16","u32","u64","s8","s16","s32","s64","f32","f64",
    "size_t","ssize_t","BOOL","bool","true","false",
}

def scan_typedefs():
    typedefs = {}
    for base in (INC, SRC, ROOT / "pc" / "include"):
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.suffix not in (".h", ".c", ".c_inc"):
                continue
            try:
                text = p.read_text(errors="replace")
            except Exception:
                continue
            for m in TYPEDEF_RE.finditer(text):
                ret = " ".join(m.group(1).split())
                name = m.group(2)
                args = " ".join(m.group(3).split())
                if name not in typedefs:
                    typedefs[name] = (ret, args)
    return typedefs

def split_args(args_str):
    if not args_str.strip() or args_str.strip() == "void":
        return []
    parts = []
    depth = 0
    cur = []
    for ch in args_str:
        if ch == ',' and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            cur.append(ch)
    if cur:
        parts.append("".join(cur).strip())
    return parts

def _strip_param_name(p):
    p = p.strip()
    arr_suffix = ""
    m_arr = re.match(r'^(.*?)((?:\[[^\]]*\])+)$', p)
    if m_arr:
        p_inner = m_arr.group(1).rstrip()
        arr_suffix = m_arr.group(2)
    else:
        p_inner = p
    m = re.match(r'^(.*?)([A-Za-z_][A-Za-z0-9_]*)\s*$', p_inner, re.DOTALL)
    if m:
        before, last = m.group(1), m.group(2)
        if last in _C_KEYWORDS_AND_TYPES or not before.strip():
            return p_inner + arr_suffix
        if "(*" in p_inner:
            return p_inner + arr_suffix
        return before.rstrip() + arr_suffix
    return p_inner + arr_suffix

def make_param_list(args_str):
    parts = split_args(args_str)
    if not parts:
        return "void"
    return ", ".join(f"{_strip_param_name(p)} _p{i}" for i, p in enumerate(parts))

def make_body(ret_type, args_str):
    rt = ret_type.strip()
    voids = ["(void)_p%d;" % i for i in range(len(split_args(args_str)))]
    body = " ".join(voids)
    if rt == "void":
        return "{ " + body + " }"
    return "{ " + body + (" " if body else "") + "return 0; }"

def collect_used_types(text):
    return set(m.group(1) for m in CAST_RE.finditer(text))

def replace_casts(text, unresolved):
    def repl(m):
        t = m.group(1)
        if t in unresolved:
            return m.group(0)
        return f"_none_{t}"
    return CAST_RE.sub(repl, text)

def find_insert_position(text):
    """Find a file-scope position to insert the stub block.

    Target anchor = earliest of:
      (a) first `_none_<TYPE>` reference in this file
      (b) first `#include "...c"` or `#include "...c_inc"` line

    Then we back up from that anchor to the most recent file-scope point
    (brace depth 0) by scanning forward from the start of the file and
    tracking `{`/`}` depth (ignoring strings/comments).
    """
    anchor = len(text)

    # (b) first c/c_inc include
    for m in re.finditer(r'^[ \t]*#include\s+["<]([^">]+)[">]', text, re.MULTILINE):
        p = m.group(1)
        if p.endswith(".c") or p.endswith(".c_inc"):
            anchor = min(anchor, m.start())
            break

    # (a) first _none_ use
    m = re.search(r'\b_none_[A-Za-z_]', text)
    if m:
        anchor = min(anchor, m.start())

    if anchor >= len(text):
        return 0

    # Scan forward, tracking brace depth + skipping strings/comments, and
    # record the most recent position where depth was 0 at end of line.
    depth = 0
    i = 0
    n = len(text)
    last_scope_pos = 0
    while i < anchor and i < n:
        c = text[i]
        # line comment
        if c == '/' and i + 1 < n and text[i+1] == '/':
            nl = text.find('\n', i)
            i = n if nl == -1 else nl + 1
            if depth == 0:
                last_scope_pos = i
            continue
        # block comment
        if c == '/' and i + 1 < n and text[i+1] == '*':
            end = text.find('*/', i + 2)
            i = n if end == -1 else end + 2
            continue
        # string
        if c == '"':
            i += 1
            while i < n:
                if text[i] == '\\' and i + 1 < n:
                    i += 2
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        # char literal
        if c == "'":
            i += 1
            while i < n:
                if text[i] == '\\' and i + 1 < n:
                    i += 2
                    continue
                if text[i] == "'":
                    i += 1
                    break
                i += 1
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                # record position right after matching close brace + newline
                nl = text.find('\n', i)
                last_scope_pos = (nl + 1) if nl != -1 else i + 1
        elif c == '\n' and depth == 0:
            last_scope_pos = i + 1
        i += 1
    return last_scope_pos

def resolve_include(host_file, inc_path):
    """Resolve a `#include "..."` or <...> to a Path, restricted to .c/.c_inc."""
    if not (inc_path.endswith(".c") or inc_path.endswith(".c_inc")):
        return None
    candidates = [
        host_file.parent / inc_path,
        SRC / inc_path,
        ROOT / inc_path,
    ]
    # Strip leading "../"s and try anchored at ROOT or SRC
    stripped = inc_path
    while stripped.startswith("../"):
        stripped = stripped[3:]
    candidates += [ROOT / stripped, SRC / stripped]
    # Try by basename anywhere in src/
    tail = Path(inc_path).name
    for c in SRC.rglob(tail):
        candidates.append(c)
    for c in candidates:
        try:
            if c.is_file():
                return c.resolve()
        except Exception:
            pass
    return None

def main():
    print("Scanning typedefs...")
    typedefs = scan_typedefs()
    print(f"  found {len(typedefs)} function-pointer typedefs")

    # Collect all .c and .c_inc files
    print("Building include graph...")
    all_files = set()
    for p in SRC.rglob("*.c"):     all_files.add(p.resolve())
    for p in SRC.rglob("*.c_inc"): all_files.add(p.resolve())

    includes_of = defaultdict(set)   # file -> set of files it includes
    included_by = defaultdict(set)   # file -> set of files that include it
    file_text = {}                   # cache

    for f in all_files:
        try:
            text = f.read_text(errors="replace")
        except Exception:
            continue
        file_text[f] = text
        for m in INC_RE.finditer(text):
            target = resolve_include(f, m.group(1))
            if target is not None and target in all_files:
                includes_of[f].add(target)
                included_by[target].add(f)

    # TU roots: .c files that are not included by any .c/.c_inc.
    tu_roots = sorted(p for p in all_files if p.suffix == ".c" and not included_by.get(p))
    print(f"  {len(tu_roots)} translation-unit roots, {len(all_files)} total files")

    # For each TU root, compute transitive closure of includes
    closure = {}  # tu_root -> set of files
    for r in tu_roots:
        seen = {r}
        stack = [r]
        while stack:
            cur = stack.pop()
            for nxt in includes_of.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        closure[r] = seen

    # Replace casts in EVERY file (we'll later add stubs only to TU roots).
    # Track unresolved types so we leave their casts alone.
    print("Replacing casts...")
    unresolved_global = set()
    files_modified = set()
    for f in all_files:
        text = file_text.get(f)
        if text is None:
            continue
        types_here = collect_used_types(text)
        if not types_here:
            continue
        unresolved = {t for t in types_here if t not in typedefs}
        unresolved_global |= unresolved
        new_text = replace_casts(text, unresolved)
        if new_text != text:
            file_text[f] = new_text
            files_modified.add(f)

    # Generate stubs for each TU root
    print("Generating stub blocks at TU roots...")
    for r in tu_roots:
        types_in_tu = set()
        for f in closure[r]:
            for m in CAST_RE.finditer(file_text.get(f, "")):
                # NOTE: after replace, no casts remain — re-extract from ORIGINAL.
                # But we already replaced, so use the type names that WERE replaced:
                pass
        # Re-extract from each file's ORIGINAL text by looking at substitutions.
        # Easier: just re-scan replaced text for `_none_<TYPE>` references.
        for f in closure[r]:
            text = file_text.get(f, "")
            for m in re.finditer(r'\b_none_([A-Za-z_][A-Za-z0-9_]*)\b', text):
                types_in_tu.add(m.group(1))
        if not types_in_tu:
            continue

        resolved_types = sorted(t for t in types_in_tu if t in typedefs)
        if not resolved_types:
            continue

        stub_lines = []
        for t in resolved_types:
            ret, args = typedefs[t]
            params = make_param_list(args)
            body = make_body(ret, args)
            stub_lines.append(f"static {ret} _none_{t}({params}) {body}")

        stub_block = (
            "\n#ifdef TARGET_PC\n"
            "/* Typed stubs for (TYPE)&none_proc1 casts — wasm call_indirect requires\n"
            " * exact signature match. Generated by fix_none_proc1_casts.py. */\n"
            + "\n".join(stub_lines)
            + "\n#endif\n"
        )
        text = file_text[r]
        insert_pos = find_insert_position(text)
        new_text = text[:insert_pos] + stub_block + "\n" + text[insert_pos:]
        file_text[r] = new_text
        files_modified.add(r)

    # Write all modified files
    for f in files_modified:
        f.write_text(file_text[f])

    print(f"\nWrote {len(files_modified)} files")
    if unresolved_global:
        print(f"\nUnresolved types ({len(unresolved_global)}): {sorted(unresolved_global)}")

if __name__ == "__main__":
    main()
