import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ROOT / "src" / "locales"
SUPPLEMENT = json.loads((Path(__file__).parent / "helper_intro_supplement.json").read_text(encoding="utf-8"))
EN = json.loads((LOCALES / "en.json").read_text(encoding="utf-8"))
HELPER_KEYS = sorted(k for k in EN if k.startswith("helperIntro."))


def patch_file(code: str, additions: dict[str, str]) -> int:
    path = LOCALES / f"{code}.json"
    if not path.exists():
        return 0
    pack = json.loads(path.read_text(encoding="utf-8"))
    n = 0
    for key, value in additions.items():
        if key not in HELPER_KEYS or key in pack:
            continue
        pack[key] = value
        n += 1
    if n:
        path.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


for code, additions in SUPPLEMENT.items():
    count = patch_file(code, additions)
    if count:
        print(f"{code}: added {count} helperIntro keys")
