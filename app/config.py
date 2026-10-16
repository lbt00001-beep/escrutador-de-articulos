"""Configuración: versión, ajustes del usuario, clave de OpenRouter y modelos recomendados."""
import json
import os
from pathlib import Path

APP_VERSION = "1.4.0"
APP_YEAR = 2026
APP_CREDIT = "By Luis Benedicto Tuzón with Claude Opus 5.5"

# Modo público (web): cada visitante aporta su propia clave desde el navegador y el servidor
# no guarda nada en disco ni usa ninguna clave propia. Se activa solo en Vercel.
IS_PUBLIC = os.getenv("ESCRUTADOR_PUBLIC") == "1" or bool(os.getenv("VERCEL"))

BASE_DIR = Path(__file__).resolve().parent.parent
# En Vercel solo /tmp es escribible
DATA_DIR = Path("/tmp/escrutador") if os.getenv("VERCEL") else BASE_DIR / "data"
HISTORY_DIR = DATA_DIR / "historial"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_PATH = DATA_DIR / "settings.json"

PORT = int(os.getenv("ESCRUTADOR_PORT", "8010"))

# Vercel limita el cuerpo de la petición a 4,5 MB
MAX_PDF_MB = 4 if IS_PUBLIC else 25

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

# Respaldo local si el usuario no ha guardado la clave en Ajustes
POSSIBLE_KEY_PATHS = [p for p in [
    Path(os.environ["OPENROUTER_KEY_FILE"]) if os.getenv("OPENROUTER_KEY_FILE") else None,
    Path.home() / "Documents" / "Openrouter.txt",
    BASE_DIR / "openrouter_key.txt",
] if p is not None]

# Precios por 1M de tokens (entrada / salida) según OpenRouter, octubre 2026.
# Selección por coste/beneficio para ESTA tarea (verificar un artículo de ~1.000 palabras).
# quality: 1-5 en esta tarea · cost_web / cost_noweb: $ por análisis con / sin búsqueda web
# measured: True si el coste y la calidad se midieron con artículos reales (oct. 2026); False = estimado
# a partir del precio por token (~5k tokens de entrada y ~15k de salida, más ~0,03 $ de búsqueda web).
MODELS = [
    {"id": "anthropic/claude-haiku-5.5", "name": "Claude Haiku 5.5", "price": "$0,10 / $0,50",
     "quality": 4, "cost_web": 0.04, "cost_noweb": 0.01, "measured": True, "badge": "Mejor calidad/precio",
     "note": "Contraste completo con fuentes concretas y enlaces a las páginas exactas."},
    {"id": "google/gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash Lite", "price": "$0,10 / $0,40",
     "quality": 3, "cost_web": 0.012, "cost_noweb": 0.005, "measured": True, "badge": "El más barato",
     "note": "Análisis correcto pero más superficial; detecta menos falacias y omisiones."},
    {"id": "openai/gpt-6-luna", "name": "GPT-6 Luna", "price": "$0,10 / $0,50",
     "quality": 4, "cost_web": 0.04, "cost_noweb": 0.01, "measured": False,
     "note": "Alternativa de OpenAI con precio equivalente a Haiku."},
    {"id": "deepseek/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "price": "$0,02 / $0,72",
     "quality": 3, "cost_web": 0.045, "cost_noweb": 0.012, "measured": False,
     "note": "Entrada casi gratis; útil para artículos muy largos."},
    {"id": "google/gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash Lite", "price": "$0,30 / $2,50",
     "quality": 3, "cost_web": 0.043, "cost_noweb": 0.01, "measured": True,
     "note": "El más rápido (~17 s), pero cita páginas de inicio genéricas en vez de las fuentes exactas."},
    {"id": "google/gemini-3.8-flash", "name": "Gemini 3.8 Flash", "price": "$0,75 / $3,75",
     "quality": 4, "cost_web": 0.08, "cost_noweb": 0.05, "measured": False,
     "note": "El Gemini más capaz a precio medio."},
    {"id": "anthropic/claude-sonnet-5.5", "name": "Claude Sonnet 5.5", "price": "$2 / $10",
     "quality": 5, "cost_web": 0.19, "cost_noweb": 0.16, "measured": False, "badge": "Máxima calidad",
     "note": "Para artículos complejos o polémicos; unas 5 veces el coste de Haiku."},
]

DEFAULT_SETTINGS = {
    "api_key": "",
    "default_model": os.getenv("ESCRUTADOR_MODEL", MODELS[0]["id"]),
    "web_search": True,
    "web_results": 8,
}

# Límite de texto enviado al modelo (caracteres) para controlar coste
MAX_ARTICLE_CHARS = 60_000


def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        settings.update(json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings: dict) -> None:
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=1), encoding="utf-8")


def get_api_key_with_source() -> tuple[str, str]:
    """Orden: clave guardada en Ajustes > variable de entorno > archivo de texto.
    En modo público el servidor no tiene clave propia: siempre la aporta el visitante."""
    if IS_PUBLIC:
        return "", ""
    saved = load_settings().get("api_key", "").strip()
    if saved:
        return saved, "Ajustes"
    env_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if env_key:
        return env_key, "variable de entorno OPENROUTER_API_KEY"
    for path in POSSIBLE_KEY_PATHS:
        try:
            if path.exists():
                content = path.read_text(encoding="utf-8").strip()
                if content.startswith("sk-or-"):
                    return content, f"archivo {path.name}"
        except OSError:
            pass
    return "", ""


def get_api_key() -> str:
    return get_api_key_with_source()[0]


def mask_key(key: str) -> str:
    return f"{key[:8]}…{key[-4:]}" if len(key) > 14 else ""
