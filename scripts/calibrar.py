"""Ejecuta el banco de calibración y comprueba que las notas separan el buen periodismo de la
desinformación y son estables. Uso: python scripts/calibrar.py --help"""
import argparse
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import analyze, extract, metrics, scoring  # noqa: E402
from app.config import DEFAULT_SETTINGS  # noqa: E402

BANK_DIR = ROOT / "calibracion"
OUT_DIR = BANK_DIR / "resultados"


def load_text(item: dict) -> dict:
    if item.get("archivo"):
        text = (BANK_DIR / item["archivo"]).read_text(encoding="utf-8")
        return extract.from_text(text).to_dict()
    return extract.from_url(item["url"]).to_dict()


def analyze_item(item: dict, model: str, web: bool) -> dict:
    t0 = time.time()
    try:
        article = load_text(item)
        m = metrics.compute(article["text"], article["links"])
        result = analyze.run(article, m, model, web)
        return {"id": item["id"], "ok": True, "segundos": round(time.time() - t0), "result": result}
    except Exception as e:  # el informe recoge el fallo sin detener el banco
        return {"id": item["id"], "ok": False, "error": str(e)}


def summarize(bank: dict, runs: list) -> tuple[list, dict]:
    """Recalcula las notas con el scoring actual y comprueba los objetivos."""
    goals = bank["objetivos"]
    by_id = {t["id"]: t for t in bank["textos"]}
    rows = []
    for run in runs:
        if not run["ok"]:
            rows.append({"id": run["id"], "error": run["error"], **by_id[run["id"]]})
            continue
        p = scoring.score(run["result"])
        rows.append({**by_id[run["id"]], "id": run["id"], "genero": p["genero"], "global": p["nota"],
                     "fiabilidad": p["fiabilidad"]["nota"], "calidad": p["calidad"]["nota"],
                     "limite": bool(p["limite"]), "coste": (run["result"].get("_meta") or {}).get("coste_usd")})

    ok = [r for r in rows if "error" not in r]
    alta = [r for r in ok if r["grupo"] == "alta"]
    baja = [r for r in ok if r["grupo"] == "baja"]
    stats = {
        "alta_media": round(statistics.mean(r["global"] for r in alta), 2) if alta else None,
        "alta_min": min((r["global"] for r in alta), default=None),
        "baja_media": round(statistics.mean(r["global"] for r in baja), 2) if baja else None,
        "baja_max": max((r["global"] for r in baja), default=None),
        "coste_total": round(sum(r["coste"] or 0 for r in ok), 3),
    }
    stats["separacion"] = (round(stats["alta_min"] - stats["baja_max"], 2)
                           if alta and baja else None)
    checks = {
        "Todos los textos de calidad ≥ %.1f" % goals["alta_global_min"]:
            all(r["global"] >= goals["alta_global_min"] for r in alta),
        "Todos los textos de desinformación ≤ %.1f" % goals["baja_global_max"]:
            all(r["global"] <= goals["baja_global_max"] for r in baja),
        "Fiabilidad de la desinformación ≤ %.1f" % goals["baja_fiabilidad_max"]:
            all((r["fiabilidad"] if r["fiabilidad"] is not None else 10) <= goals["baja_fiabilidad_max"] for r in baja),
    }
    # Estabilidad: textos analizados varias veces
    repeated = {}
    for r in ok:
        repeated.setdefault(r["id"], []).append(r["global"])
    spread = {k: round(statistics.pstdev(v), 2) for k, v in repeated.items() if len(v) > 1}
    if spread:
        checks["Desviación al repetir ≤ %.1f" % goals["desviacion_max"]] = \
            all(s <= goals["desviacion_max"] for s in spread.values())
    stats["desviaciones"] = spread
    return rows, {"stats": stats, "checks": checks}


def report_md(model: str, web: bool, rows: list, summary: dict) -> str:
    s = summary["stats"]
    lines = [f"# Calibración · {datetime.now():%Y-%m-%d %H:%M}", "",
             f"Modelo: `{model}` · Búsqueda web: {'sí' if web else 'no'} · Coste: {s['coste_total']} $", "",
             "| Texto | Grupo | Género detectado | Global | Fiabilidad | Calidad |", "|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda x: (x["grupo"], -(x.get("global") or 0))):
        if "error" in r:
            lines.append(f"| {r['id']} | {r['grupo']} | ERROR: {r['error'][:80]} | | | |")
            continue
        fiab = "—" if r["fiabilidad"] is None else r["fiabilidad"]
        lines.append(f"| {r['id']} | {r['grupo']} | {r['genero']} | **{r['global']}**{' (límite)' if r['limite'] else ''} | {fiab} | {r['calidad']} |")
    lines += ["", f"Media grupo alto: **{s['alta_media']}** (mínimo {s['alta_min']}) · "
              f"Media grupo bajo: **{s['baja_media']}** (máximo {s['baja_max']}) · Separación: **{s['separacion']}**", ""]
    if s["desviaciones"]:
        lines += ["Desviación típica al repetir: " + ", ".join(f"{k} {v}" for k, v in s["desviaciones"].items()), ""]
    lines += ["## Objetivos", ""] + [f"- {'✅' if v else '❌'} {k}" for k, v in summary["checks"].items()]
    return "\n".join(lines) + "\n"


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # la consola de Windows no admite ✅/❌ en cp1252
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--modelo", default=DEFAULT_SETTINGS["default_model"])
    ap.add_argument("--sin-web", action="store_true")
    ap.add_argument("--repetir", type=int, default=1, help="veces que se analiza cada texto")
    ap.add_argument("--solo", nargs="*", help="ids del banco a ejecutar")
    ap.add_argument("--hilos", type=int, default=4)
    ap.add_argument("--reusar", help="JSON de una ejecución anterior: solo recalcula las notas")
    args = ap.parse_args()

    bank = json.loads((BANK_DIR / "banco.json").read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.reusar:
        saved = json.loads(Path(args.reusar).read_text(encoding="utf-8"))
        model, web, runs = saved["modelo"], saved["busqueda_web"], saved["ejecuciones"]
    else:
        model, web = args.modelo, not args.sin_web
        items = [t for t in bank["textos"] if not args.solo or t["id"] in args.solo] * args.repetir
        print(f"Analizando {len(items)} textos con {model} (web: {web})…", flush=True)
        with ThreadPoolExecutor(max_workers=args.hilos) as pool:
            runs = []
            for run in pool.map(lambda it: analyze_item(it, model, web), items):
                print(f"  {'OK ' if run['ok'] else 'ERR'} {run['id']} {run.get('segundos', '')}s"
                      f"{'' if run['ok'] else ' ' + run['error'][:100]}", flush=True)
                runs.append(run)

    rows, summary = summarize(bank, runs)
    stamp = Path(args.reusar).stem if args.reusar else f"{datetime.now():%Y%m%d-%H%M}-{model.split('/')[-1]}"
    if not args.reusar:
        (OUT_DIR / f"{stamp}.json").write_text(json.dumps(
            {"modelo": model, "busqueda_web": web, "ejecuciones": runs}, ensure_ascii=False), encoding="utf-8")
    md = report_md(model, web, rows, summary)
    (OUT_DIR / f"{stamp}{'-recalculo' if args.reusar else ''}.md").write_text(md, encoding="utf-8")
    print(md)


if __name__ == "__main__":
    main()
