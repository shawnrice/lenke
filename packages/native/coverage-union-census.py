#!/usr/bin/env python3
"""UNION the per-package src coverage with the coverage a BUNDLE run gives, mapped back to src.

WHY THIS EXISTS (item 1790). Item 1787's gap census ran ONE package's suite, so any executor line
reached only from `packages/native`'s cross-engine conformance tests counted as uncovered. Those
tests import `@lenke/gql` / `@lenke/gremlin`, which resolve to DIST, so bun's lcov names
`../gql/dist/esm/index.mjs` and nothing in `src/`. This projects those bundle hits back through the
dist sourcemap and unions them with each package's own src lcov.

⚠️ WHAT THIS IS AND IS NOT.
  - A generated line can map to SEVERAL original lines (bundling, inlining). A src line is marked
    covered if ANY generated line mapping to it was hit. That is the UNION direction, so this can
    only ever SHRINK the gap list — it cannot invent a gap.
  - It is therefore an UPPER bound on coverage and a LOWER bound on the gaps. A line it still calls
    uncovered is a real candidate; a line it calls covered might in principle be a mapping artifact.
  - Branch coverage is not modelled at all. A line counts as reached if the statement ran, so an
    `if` whose else-arm never ran still reads covered. Arms need mutation, not this.

Usage: cov-union-1790.py <src-lcov> [<src-lcov> ...] --bundle <bundle-lcov> --out <report>
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path("/home/shawn/projects/pl-graph")

B64 = {c: i for i, c in enumerate(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")}


def vlq_decode(seg: str) -> list[int]:
    out, shift, acc = [], 0, 0
    for ch in seg:
        d = B64[ch]
        acc += (d & 31) << shift
        if d & 32:
            shift += 5
            continue
        value = acc >> 1
        out.append(-value if acc & 1 else value)
        shift, acc = 0, 0
    return out


def parse_lcov(p: Path) -> dict[str, dict[int, int]]:
    hits: dict[str, dict[int, int]] = defaultdict(dict)
    cur = None
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("SF:"):
            cur = line[3:].strip()
        elif line.startswith("DA:") and cur:
            parts = line[3:].strip().split(",")
            if len(parts) >= 2:
                try:
                    ln, n = int(parts[0]), int(parts[1])
                except ValueError:
                    continue
                hits[cur][ln] = max(hits[cur].get(ln, 0), n)
        elif line.startswith("end_of_record"):
            cur = None
    return hits


def map_bundle(bundle_file: Path, gen_hits: dict[int, int]) -> dict[str, set[int]]:
    """Project hit GENERATED lines onto the original src lines the sourcemap names."""
    mp = Path(str(bundle_file) + ".map")
    if not mp.exists():
        return {}
    sm = json.loads(mp.read_text(encoding="utf-8"))
    sources = sm["sources"]
    root = mp.parent
    covered: dict[str, set[int]] = defaultdict(set)
    src_i = 0
    src_line = 0
    for gen_line_0, group in enumerate(sm["mappings"].split(";")):
        gen_line = gen_line_0 + 1
        for seg in group.split(","):
            if not seg:
                continue
            f = vlq_decode(seg)
            if len(f) >= 4:
                src_i += f[1]
                src_line += f[2]
            if len(f) >= 4 and gen_hits.get(gen_line, 0) > 0:
                try:
                    abspath = (root / sources[src_i]).resolve()
                except (IndexError, OSError):
                    continue
                covered[str(abspath)].add(src_line + 1)
    return covered


def is_code(s: str) -> bool:
    s = s.strip()
    if not s or s.startswith(("//", "*", "/*", "*/")):
        return False
    return s not in ("}", "{", "};", "});", ")", "],", "};\n")


def main() -> int:
    args = sys.argv[1:]
    bundle_lcovs = []
    src_lcovs = []
    out = None
    mode = "src"
    for a in args:
        if a == "--bundle":
            mode = "bundle"
        elif a == "--out":
            mode = "out"
        elif mode == "bundle":
            bundle_lcovs.append(Path(a))
        elif mode == "out":
            out = Path(a)
        else:
            src_lcovs.append(Path(a))

    # 1. Own-suite src coverage, keyed by absolute path.
    src_hits: dict[str, dict[int, int]] = defaultdict(dict)
    for p in src_lcovs:
        base = p.parent
        for sf, lines in parse_lcov(p).items():
            key = str((base / sf).resolve()) if not sf.startswith("/") else sf
            # bun writes SF relative to the package dir the run started in
            if not Path(key).exists():
                for guess in (ROOT / "packages/gql" / sf, ROOT / "packages/gremlin" / sf):
                    if guess.exists():
                        key = str(guess.resolve())
                        break
            for ln, n in lines.items():
                src_hits[key][ln] = max(src_hits[key].get(ln, 0), n)

    # 2. Bundle coverage, projected back through the sourcemap.
    projected: dict[str, set[int]] = defaultdict(set)
    for p in bundle_lcovs:
        base = p.parent
        for sf, lines in parse_lcov(p).items():
            bundle = (ROOT / "packages/native" / sf).resolve()
            if not bundle.exists():
                bundle = (base / sf).resolve()
            if not bundle.exists():
                continue
            for f, ls in map_bundle(bundle, lines).items():
                projected[f] |= ls

    # 3. Report, per src file under packages/*/src, the blocks still uncovered after the union.
    report: list[str] = []
    totals = [0, 0, 0]
    for f in sorted(set(src_hits) | set(projected)):
        if "/packages/" not in f or "/src/" not in f or f.endswith(".test.ts"):
            continue
        own = src_hits.get(f, {})
        if not own:
            continue
        text = Path(f).read_text(encoding="utf-8", errors="replace").splitlines()
        proj = projected.get(f, set())
        miss_own = sorted(ln for ln, n in own.items() if n == 0)
        miss_union = [ln for ln in miss_own if ln not in proj]
        code_own = [ln for ln in miss_own if ln <= len(text) and is_code(text[ln - 1])]
        code_union = [ln for ln in miss_union if ln <= len(text) and is_code(text[ln - 1])]
        totals[0] += len(code_own)
        totals[1] += len(code_union)
        if not code_union:
            continue
        blocks: list[list[int]] = []
        for ln in code_union:
            if blocks and ln - blocks[-1][-1] <= 2:
                blocks[-1].append(ln)
            else:
                blocks.append([ln])
        big = [b for b in blocks if len(b) >= 4]
        totals[2] += len(big)
        if not big:
            continue
        rel = f.split("/packages/", 1)[1]
        report.append(f"\n{rel}  own-suite-miss={len(code_own)} union-miss={len(code_union)}")
        for b in sorted(big, key=len, reverse=True)[:8]:
            report.append(f"    {b[0]:>5}-{b[-1]:<5} {len(b):>3} lines | {text[b[0]-1].strip()[:72]}")

    head = (
        f"UNCOVERED CODE LINES under packages/*/src\n"
        f"  own suite only : {totals[0]}\n"
        f"  after UNION    : {totals[1]}   ({totals[0] - totals[1]} were reached only via the "
        f"bundle, i.e. from another package's tests)\n"
        f"  blocks >= 4    : {totals[2]}\n"
    )
    body = head + "\n".join(report) + "\n"
    print(body)
    if out:
        out.write_text(body, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
