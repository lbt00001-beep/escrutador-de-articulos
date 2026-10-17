"""API y servidor web del Escrutador de Artículos."""
import json
import re
import time
import uuid
from datetime import datetime

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import analyze, extract, metrics
from .config import (APP_CREDIT, APP_VERSION, APP_YEAR, BASE_DIR, FAST_MODEL, HISTORY_DIR, IS_PUBLIC, MAX_PDF_MB, MODELS,
                     OPENROUTER_KEY_URL, OPENROUTER_MODELS_URL, get_api_key, get_api_key_with_source,
                     load_settings, mask_key, save_settings)

STATIC_DIR = BASE_DIR / "static"
MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024

app = FastAPI(title="Escrutador de Artículos", version=APP_VERSION)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _visitor_key(header_key: str | None) -> str:
    """Clave que envía el navegador; en local, si no hay, se usa la configurada en el servidor."""
    key = (header_key or "").strip()
    if key and not key.startswith("sk-or-"):
        raise HTTPException(400, "La clave de OpenRouter empieza por «sk-or-».")
    return key or get_api_key()


def _local_only():
    if IS_PUBLIC:
        raise HTTPException(404, "No disponible en la versión web: los datos se guardan en tu navegador.")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
def config():
    settings = load_settings()
    key, source = get_api_key_with_source()
    return {
        "public": IS_PUBLIC,
        "fast_model": FAST_MODEL,
        "max_pdf_mb": MAX_PDF_MB,
        "models": MODELS,
        "default_model": settings["default_model"],
        "web_search": settings["web_search"],
        "web_results": settings["web_results"],
        "has_key": bool(key),
        "key_source": source,
        "key_masked": mask_key(key),
        "version": APP_VERSION,
        "year": APP_YEAR,
        "credit": APP_CREDIT,
    }


# ---------- Ajustes (solo versión local; en la web se guardan en el navegador) ----------

class SettingsUpdate(BaseModel):
    api_key: str | None = None      # None = no tocar; "" con clear_key = borrar
    clear_key: bool = False
    default_model: str | None = None
    web_search: bool | None = None
    web_results: int | None = None


@app.post("/api/settings")
def update_settings(upd: SettingsUpdate):
    _local_only()
    settings = load_settings()
    if upd.clear_key:
        settings["api_key"] = ""
    elif upd.api_key:
        key = upd.api_key.strip()
        if not key.startswith("sk-or-"):
            raise HTTPException(400, "La clave de OpenRouter empieza por «sk-or-».")
        settings["api_key"] = key
    if upd.default_model:
        settings["default_model"] = upd.default_model.strip()
    if upd.web_search is not None:
        settings["web_search"] = upd.web_search
    if upd.web_results is not None:
        settings["web_results"] = max(1, min(15, upd.web_results))
    save_settings(settings)
    return config()


class KeyTest(BaseModel):
    api_key: str = ""


@app.post("/api/settings/test")
async def test_key(req: KeyTest, x_openrouter_key: str | None = Header(None)):
    """Comprueba la clave contra OpenRouter y devuelve su saldo/límite."""
    key = _visitor_key(req.api_key or x_openrouter_key)
    if not key:
        raise HTTPException(400, "No hay ninguna clave que probar.")
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(OPENROUTER_KEY_URL, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError as e:
            raise HTTPException(502, f"No se pudo contactar con OpenRouter: {e}")
    if resp.status_code != 200:
        raise HTTPException(400, "OpenRouter rechaza la clave (no existe o está revocada).")
    data = resp.json().get("data", {})
    return {"ok": True, "label": data.get("label"), "usage": data.get("usage"),
            "limit": data.get("limit"), "limit_remaining": data.get("limit_remaining"),
            "is_free_tier": data.get("is_free_tier")}


_models_cache: dict = {"t": 0, "items": []}


@app.get("/api/models/all")
async def all_models():
    """Catálogo completo de OpenRouter (público) para elegir cualquier modelo por su ID."""
    if time.time() - _models_cache["t"] > 6 * 3600:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                data = (await client.get(OPENROUTER_MODELS_URL)).json()["data"]
        except (httpx.HTTPError, ValueError, KeyError):
            return _models_cache["items"]
        items = []
        for m in data:
            p = m.get("pricing") or {}
            try:
                price = f"${float(p.get('prompt', 0)) * 1e6:.2f} / ${float(p.get('completion', 0)) * 1e6:.2f}"
            except (TypeError, ValueError):
                price = ""
            items.append({"id": m["id"], "name": m.get("name", m["id"]), "price": price})
        _models_cache.update(t=time.time(), items=sorted(items, key=lambda x: x["id"]))
    return _models_cache["items"]


# ---------- Análisis ----------

@app.post("/api/extract")
async def extract_article(url: str = Form(""), text: str = Form(""), title: str = Form(""),
                          file: UploadFile | None = File(None)):
    try:
        if file is not None and file.filename:
            data = await file.read()
            if len(data) > MAX_PDF_BYTES:
                raise HTTPException(413, f"El PDF supera los {MAX_PDF_MB} MB.")
            article = await run_in_threadpool(extract.from_pdf, data, file.filename)
        elif text.strip():
            article = extract.from_text(text, title, url)
        elif url.strip():
            article = await run_in_threadpool(extract.from_url, url)
        else:
            raise HTTPException(400, "Indica una URL, pega el texto o sube un PDF.")
    except extract.ExtractionError as e:
        raise HTTPException(422, str(e))
    art = article.to_dict()
    return {"article": art, "metrics": metrics.compute(art["text"], art["links"])}


class AnalyzeRequest(BaseModel):
    article: dict
    metrics: dict
    model: str | None = None
    web_search: bool | None = None
    web_results: int | None = None
    genero: str | None = None  # None = lo detecta la IA
    rapido: bool = False       # modo rápido: modelo barato y sin búsqueda web


@app.get("/api/genres")
def genres():
    from .scoring import GENRES, QUALITY_CRITERIA, RUBRICS
    return {"generos": GENRES,
            "rubricas": {g: {"peso_fiabilidad": r["peso_fiabilidad"],
                             "criterios": {k: {"nombre": QUALITY_CRITERIA[k][0], "peso": w}
                                           for k, w in r["criterios"].items()}}
                         for g, r in RUBRICS.items()}}


class RescoreRequest(BaseModel):
    result: dict
    genero: str
    record_id: str | None = None


@app.post("/api/rescore")
def rescore(req: RescoreRequest):
    """Recalcula las notas como otro género con los criterios ya puntuados (sin IA, sin coste)."""
    try:
        puntuacion = analyze.rescore(req.result, req.genero)
    except analyze.AnalysisError as e:
        raise HTTPException(400, str(e))
    if not IS_PUBLIC and req.record_id:
        path = _history_path(req.record_id)
        rec = json.loads(path.read_text(encoding="utf-8"))
        rec["result"]["puntuacion"] = puntuacion
        path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return puntuacion


@app.post("/api/analyze")
async def analyze_article(req: AnalyzeRequest, x_openrouter_key: str | None = Header(None)):
    settings = load_settings()
    key = _visitor_key(x_openrouter_key)
    if not key:
        raise HTTPException(401, "Falta tu clave de OpenRouter: ábrela en ⚙ Ajustes y pégala "
                                 "(se obtiene en https://openrouter.ai/keys).")
    model = req.model or settings["default_model"]
    web = settings["web_search"] if req.web_search is None else req.web_search
    web_results = max(1, min(15, req.web_results or settings["web_results"]))
    try:
        result = await run_in_threadpool(analyze.run, req.article, req.metrics, model, web, key, web_results,
                                         req.genero, req.rapido)
    except analyze.AnalysisError as e:
        raise HTTPException(502, str(e))
    record = {
        "id": datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6],
        "fecha_analisis": datetime.now().isoformat(timespec="seconds"),
        "article": req.article,
        "metrics": req.metrics,
        "result": result,
    }
    if not IS_PUBLIC:  # en la web el historial vive en el navegador del visitante
        (HISTORY_DIR / f"{record['id']}.json").write_text(json.dumps(record, ensure_ascii=False, indent=1),
                                                          encoding="utf-8")
    return record


def _history_path(item_id: str):
    _local_only()
    if not re.fullmatch(r"[\w-]+", item_id):
        raise HTTPException(400, "Identificador no válido.")
    path = HISTORY_DIR / f"{item_id}.json"
    if not path.exists():
        raise HTTPException(404, "Análisis no encontrado.")
    return path


@app.get("/api/history")
def history():
    _local_only()
    items = []
    for path in sorted(HISTORY_DIR.glob("*.json"), reverse=True)[:100]:
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append({
            "id": rec["id"],
            "fecha": rec["fecha_analisis"],
            "titulo": rec["article"].get("title") or rec["result"].get("titulo_inferido") or "Sin título",
            "fuente": rec["article"].get("source", ""),
            "nota": rec["result"].get("puntuacion", {}).get("nota"),
        })
    return items


@app.get("/api/history/{item_id}")
def history_item(item_id: str):
    return json.loads(_history_path(item_id).read_text(encoding="utf-8"))


@app.delete("/api/history/{item_id}")
def history_delete(item_id: str):
    _history_path(item_id).unlink()
    return {"ok": True}
