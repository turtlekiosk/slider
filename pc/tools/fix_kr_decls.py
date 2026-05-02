#!/usr/bin/env python3
"""
fix_kr_decls.py — patch K&R-style `extern T NAME();` declarations in include/
to match the function's actual definition signature in src/.

Why: C treats `T NAME();` as "unspecified args" (K&R). Clang accepts it, but
when the function is called indirectly through that declaration, wasm's
call_indirect type-checks against the declaration's signature, not the
definition's. Empty-paren decls hide the real signature and produce runtime
"function signature mismatch" errors. Filling in the real params upstream
eliminates the latent mismatch class entirely without touching binaries
(decls don't appear in the output binary, so decomp matching is unaffected).

Usage:
    python3 pc/tools/fix_kr_decls.py            # dry-run, prints proposed edits
    python3 pc/tools/fix_kr_decls.py --apply    # write changes to headers
    python3 pc/tools/fix_kr_decls.py --report   # write a CSV/log to /tmp

Heuristics:
  - Only headers under include/ are modified.
  - Definitions are looked up across src/ and pc/src/ (recursively, *.c, *.cpp,
    *.c_inc).
  - If a function has multiple definitions with different signatures, it's
    SKIPPED and listed in --report (manual review needed).
  - If no definition is found (probably an SDK function defined out-of-tree),
    it's SKIPPED and listed.
  - Function-pointer typedefs (typedef T (*NAME)();) are NOT touched here —
    they're a separate category handled elsewhere.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INCLUDE_DIR = REPO_ROOT / "include"
SRC_DIRS = [REPO_ROOT / "src", REPO_ROOT / "pc" / "src"]
SRC_GLOBS = ("*.c", "*.cpp", "*.c_inc", "*.cc")

# Match a K&R-style declaration:
#   [extern] return-type identifier();
# Up to a single line, with optional leading whitespace, optional `extern`,
# any combination of return-type tokens (including pointers/qualifiers), the
# identifier, then `()`. We do *not* match function-pointer typedefs
# `typedef T (*X)();` here.
DECL_RE = re.compile(
    r"""^(?P<indent>[ \t]*)
        (?P<extern>extern[ \t]+)?
        (?P<rettype>(?:[A-Za-z_][A-Za-z0-9_]*[ \t*]+)+)
        (?P<name>[A-Za-z_][A-Za-z0-9_]*)
        [ \t]*\([ \t]*\)[ \t]*;[ \t]*$""",
    re.VERBOSE,
)

# Match a definition: same shape but with a parameter list and an opening `{`
# (possibly on a continuation line — we read forward until we see `(...)` then
# `{`). For simplicity we assume the parameter list is on the same line as the
# function name and ends on the same line; this is true for the vast majority
# of definitions in this codebase.
DEFN_RE = re.compile(
    r"""^(?:static[ \t]+|extern[ \t]+|inline[ \t]+)*
        (?P<rettype>(?:[A-Za-z_][A-Za-z0-9_]*[ \t*]+)+)
        (?P<name>[A-Za-z_][A-Za-z0-9_]*)
        [ \t]*\((?P<params>[^)]*)\)[ \t]*
        (?:\{|$)""",
    re.VERBOSE,
)


def find_definitions() -> dict[str, list[tuple[Path, str, str]]]:
    """Return {name -> [(path, return_type_text, params_text), ...]}."""
    defs: dict[str, list[tuple[Path, str, str]]] = defaultdict(list)
    for src_root in SRC_DIRS:
        if not src_root.exists():
            continue
        for ext in SRC_GLOBS:
            for path in src_root.rglob(ext):
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                for line in text.splitlines():
                    m = DEFN_RE.match(line)
                    if not m:
                        continue
                    name = m.group("name")
                    if name in {"if", "while", "for", "switch", "return",
                                "sizeof", "typedef"}:
                        continue
                    rettype = m.group("rettype").strip()
                    params = m.group("params").strip()
                    defs[name].append((path, rettype, params))
    return defs


def find_kr_decls() -> list[tuple[Path, int, str, re.Match]]:
    """Return [(path, line_no, line_text, match), ...].

    Skips declarations inside `struct`/`class`/`union` blocks — those are
    C++ member functions whose signatures live in class scope and can't be
    matched against free-function definitions in src/."""
    out = []
    aggregate_kw = re.compile(r"^\s*(?:typedef\s+)?(struct|class|union)\b")
    for path in INCLUDE_DIR.rglob("*.h"):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        depth = 0
        aggregate_depths: list[int] = []  # brace depths at which struct/class opened
        pending_aggregate = False  # saw `struct foo` on prior line, awaiting `{`
        for i, line in enumerate(lines):
            opens = line.count("{")
            closes = line.count("}")
            if pending_aggregate and "{" in line:
                aggregate_depths.append(depth)
                pending_aggregate = False
            kw = aggregate_kw.match(line)
            if kw and ";" not in line:
                if "{" in line:
                    aggregate_depths.append(depth)
                else:
                    pending_aggregate = True
            depth += opens - closes
            while aggregate_depths and depth <= aggregate_depths[-1]:
                aggregate_depths.pop()
            if aggregate_depths:
                continue
            m = DECL_RE.match(line)
            if not m:
                continue
            if m.group("rettype").strip().startswith(("typedef ", "#define ")):
                continue
            out.append((path, i, line, m))
    return out


def normalize_params(params: str) -> str:
    """Collapse whitespace and treat empty `()` as equivalent to `(void)`.

    The decomp uses K&R `()` for zero-arg functions; the PC port adapter
    layer rewrites them as `(void)`. Both mean the same thing, so the
    ambiguity check should treat them as identical signatures."""
    p = re.sub(r"\s+", " ", params).strip()
    if p == "":
        return "void"
    return p


def signatures_compatible(defs: list[tuple[Path, str, str]]) -> str | None:
    """If all definitions share the same params, return that param string;
    otherwise None."""
    sigs = {normalize_params(p) for _, _, p in defs}
    if len(sigs) == 1:
        return sigs.pop()
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write changes to headers (default: dry run)")
    ap.add_argument("--report", action="store_true",
                    help="write skipped/ambiguous list to /tmp/kr_report.txt")
    ap.add_argument("--limit", type=int, default=0,
                    help="only process the first N decls (debugging)")
    args = ap.parse_args()

    print(f"Scanning definitions under {[str(s) for s in SRC_DIRS]}…")
    defs = find_definitions()
    print(f"  collected {sum(len(v) for v in defs.values())} definitions "
          f"across {len(defs)} unique names")

    print(f"Scanning K&R decls under {INCLUDE_DIR}…")
    decls = find_kr_decls()
    print(f"  found {len(decls)} K&R declarations")

    if args.limit:
        decls = decls[: args.limit]

    edits: dict[Path, list[tuple[int, str, str]]] = defaultdict(list)
    skipped_no_def = []
    skipped_ambiguous = []
    skipped_kr_def = []  # definition itself is K&R — can't tell intent

    for path, lineno, line, m in decls:
        name = m.group("name")
        candidates = defs.get(name, [])
        if not candidates:
            skipped_no_def.append((path, lineno, name))
            continue
        params = signatures_compatible(candidates)
        if params is None:
            skipped_ambiguous.append((path, lineno, name, candidates))
            continue
        # Empty already became "void" via normalize_params.

        # Reconstruct the line: replace `()` with `(<params>)`.
        new_line = line[: m.start()] + (
            (m.group("indent") or "")
            + (m.group("extern") or "")
            + m.group("rettype")
            + name
            + f"({params});"
        )
        # Preserve any trailing comment on the original line that the regex
        # consumed (DECL_RE anchors `$`, so trailing text is impossible —
        # nothing to preserve).
        edits[path].append((lineno, line, new_line))

    print()
    print(f"Edits planned:    {sum(len(v) for v in edits.values())} "
          f"across {len(edits)} files")
    print(f"Skipped (no def): {len(skipped_no_def)}")
    print(f"Skipped (ambig):  {len(skipped_ambiguous)}")
    print(f"Skipped (kr def): {len(skipped_kr_def)}")

    if args.report:
        rep_path = Path("/tmp/kr_report.txt")
        with rep_path.open("w") as f:
            f.write("=== Skipped: no definition found ===\n")
            for path, lineno, name in skipped_no_def:
                f.write(f"{path}:{lineno+1}: {name}\n")
            f.write("\n=== Skipped: ambiguous (multiple sigs) ===\n")
            for path, lineno, name, cands in skipped_ambiguous:
                f.write(f"{path}:{lineno+1}: {name}\n")
                for cp, _, cparams in cands:
                    f.write(f"    -> {cp}: ({cparams})\n")
            f.write("\n=== Skipped: definition is also K&R ===\n")
            for path, lineno, name in skipped_kr_def:
                f.write(f"{path}:{lineno+1}: {name}\n")
        print(f"Report written: {rep_path}")

    if not args.apply:
        # Show a preview of the first 25 edits so the user can sanity-check.
        sample_count = 0
        for path, items in edits.items():
            for lineno, old, new in items:
                print(f"  {path.relative_to(REPO_ROOT)}:{lineno+1}")
                print(f"    -  {old.rstrip()}")
                print(f"    +  {new.rstrip()}")
                sample_count += 1
                if sample_count >= 25:
                    print("  …")
                    break
            if sample_count >= 25:
                break
        print()
        print("Dry run only. Re-run with --apply to write changes.")
        return 0

    # Apply edits: rewrite each affected file in one pass.
    for path, items in edits.items():
        text_lines = path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        for lineno, _old, new in items:
            ending = "\n"
            if text_lines[lineno].endswith("\r\n"):
                ending = "\r\n"
            text_lines[lineno] = new + ending
        path.write_text("".join(text_lines), encoding="utf-8")
    print(f"Applied {sum(len(v) for v in edits.values())} edits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
