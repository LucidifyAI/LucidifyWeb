import sys, json, hashlib
from pathlib import Path
import importlib.resources as ir
import joblib

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def unwrap_model(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            m = unwrap_model(v)
            if m is not None: return m
        return None
    if isinstance(obj, (list, tuple)):
        for v in obj:
            m = unwrap_model(v)
            if m is not None: return m
        return None
    return obj

def main():
    base = ir.files("yasa")
    clf_dir = base / "classifiers"
    candidates = [p for p in clf_dir.iterdir() if p.name.lower().endswith((".joblib",".pkl",".pickle"))]

    print("Found classifier files:")
    for p in candidates:
        print("  -", p.name)

    # Prefer EEG 0.5.0 explicitly
    chosen = next((p for p in candidates if p.name == "clf_eeg_lgb_0.5.0.joblib"), None)
    if chosen is None:
        chosen = candidates[0]
    print("\nChosen classifier:", chosen.name)
    sys.stdout.flush()

    with ir.as_file(chosen) as model_path:
        clf = joblib.load(model_path)

    print("Loaded object type:", type(clf))
    sys.stdout.flush()

    clf = unwrap_model(clf)
    booster = None

    if hasattr(clf, "_Booster") and clf._Booster is not None:
        booster = clf._Booster
        print("Using clf._Booster")
    elif hasattr(clf, "booster_"):
        booster = clf.booster_
        print("Using clf.booster_")
    elif hasattr(clf, "dump_model"):
        booster = clf
        print("Using clf as booster")
    else:
        raise RuntimeError(f"Cannot find LightGBM Booster on object type {type(clf)}")

    if not hasattr(booster, "dump_model"):
        raise RuntimeError(f"Booster object has no dump_model(): {type(booster)}")

    print("Dumping model...")
    sys.stdout.flush()

    dump = booster.dump_model()

    out_json = Path("yasa_model_dump.json")
    with out_json.open("w", encoding="utf-8") as f:
        json.dump(dump, f)

    print("\nWrote:", out_json.resolve())
    print("SHA256:", sha256_file(out_json))

if __name__ == "__main__":
    main()
