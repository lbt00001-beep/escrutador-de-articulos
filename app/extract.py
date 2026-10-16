"""Extracción del texto y metadatos de un artículo desde URL o PDF."""
import ipaddress
import re
import socket
import time
from dataclasses import dataclass, field, asdict
from urllib.parse import urlparse

import pymupdf
import httpx
import trafilatura

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)


class ExtractionError(Exception):
    pass


@dataclass
class Article:
    text: str
    title: str = ""
    author: str = ""
    date: str = ""
    source: str = ""
    url: str = ""
    links: list = field(default_factory=list)
    archived_from: str = ""

    def to_dict(self):
        return asdict(self)


def _check_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ExtractionError("La URL debe empezar por http:// o https://")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        raise ExtractionError(f"No se puede resolver el dominio «{parsed.hostname}».")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ExtractionError("Solo se admiten URLs públicas.")


def _external_links(html: str, base_host: str) -> list:
    """Enlaces del cuerpo que apuntan a otros dominios: posibles fuentes citadas."""
    try:
        body = trafilatura.extract(html, output_format="xml", include_links=True) or ""
    except Exception:
        body = ""
    links = []
    for href, label in re.findall(r'<ref target="([^"]+)">(.*?)</ref>', body, re.S):
        host = urlparse(href).hostname or ""
        if href.startswith("http") and base_host not in host:
            label = re.sub(r"<[^>]+>", "", label).strip()
            if (href, label) not in links:
                links.append((href, label))
    return [{"url": u, "text": t} for u, t in links[:40]]


BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

# Páginas de desafío antibot (Cloudflare, DataDome, PerimeterX...) que no contienen el artículo
_CHALLENGE = re.compile(r"Just a moment\.\.\.|cf-chl-|captcha-delivery|px-captcha|Please enable JS and disable",
                        re.I)


# Huellas de navegador actuales que se prueban por orden. Los antibots (DataDome en El País, p. ej.)
# deciden petición a petición y bloquean unas huellas y no otras, así que se rota antes de rendirse.
IMPERSONATE_PROFILES = ["chrome", "safari", "chrome_android", "safari_ios"]


def _is_blocked(status: int, html: str) -> bool:
    return status in (401, 403, 429) or bool(_CHALLENGE.search(html[:20000]))


def _fetch_browser(url: str) -> tuple[int, str]:
    """Descarga imitando la huella TLS/HTTP2 de un navegador real; muchos medios devuelven 403 a
    clientes que no la tienen aunque la página se lea sin JavaScript."""
    last = None
    try:
        from curl_cffi import requests as cr
    except ImportError:
        cr = None
    if cr is not None:
        for profile in IMPERSONATE_PROFILES:
            try:
                resp = cr.get(url, impersonate=profile, timeout=25, allow_redirects=True,
                              headers={"Accept-Language": BROWSER_HEADERS["Accept-Language"]})
            except Exception:
                continue  # error de red con esta huella: se prueba la siguiente
            last = (resp.status_code, resp.text)
            if not _is_blocked(*last):
                return last
            time.sleep(0.4)
    try:
        with httpx.Client(follow_redirects=True, timeout=25, headers=BROWSER_HEADERS) as client:
            resp = client.get(url)
            if last is None or not _is_blocked(resp.status_code, resp.text):
                return resp.status_code, resp.text
    except httpx.HTTPError:
        if last is None:
            raise
    return last


def _fetch_archive(url: str) -> tuple[str, str]:
    """Última copia en archive.org (Wayback Machine). Devuelve (html, url_de_la_copia) o ('', '')."""
    # El año 3000 redirige a la copia más reciente; id_ devuelve el HTML original sin la barra de Wayback
    try:
        resp = httpx.get(f"https://web.archive.org/web/3000id_/{url}", timeout=20, follow_redirects=True,
                         headers={"User-Agent": USER_AGENT})
    except httpx.HTTPError:
        return "", ""
    if resp.status_code != 200 or "/web/" not in str(resp.url):
        return "", ""
    return resp.text, str(resp.url).replace("id_/", "/", 1)


def _extract_body(html: str) -> str:
    text = trafilatura.extract(html, include_comments=False, include_tables=True, favor_precision=True)
    if not text or len(text) < 400:
        text = trafilatura.extract(html, include_comments=False, include_tables=True, favor_recall=True)
    return text or ""


def from_url(url: str) -> Article:
    url = url.strip()
    _check_public_url(url)
    try:
        status, html = _fetch_browser(url)
    except httpx.HTTPError as e:
        status, html = 0, ""
        fetch_error = str(e)
    else:
        fetch_error = ""

    blocked = status != 200 or bool(_CHALLENGE.search(html[:20000]))
    text = "" if blocked else _extract_body(html)
    archived_from = ""
    if blocked or len(text.split()) < 250:  # bloqueado o solo el gancho de un muro de pago
        arch_html, arch_url = _fetch_archive(url)
        arch_text = _extract_body(arch_html) if arch_html else ""
        if len(arch_text) > len(text):
            html, text, archived_from = arch_html, arch_text, arch_url

    if len(text) < 300:
        if status in (401, 403, 429) or (blocked and status == 200):
            reason = f"La web bloquea las descargas automáticas (error {status})" if status != 200 \
                else "La web muestra un control antibot"
        elif status and status != 200:
            reason = f"La web respondió con error {status}"
        elif fetch_error:
            reason = f"No se pudo descargar la página ({fetch_error})"
        else:
            reason = "No se encontró el cuerpo del artículo (¿muro de pago o página dinámica?)"
        raise ExtractionError(f"{reason} y no hay copia en archive.org. Usa la pestaña «Pegar texto» "
                              "(copia el artículo desde el navegador) o guárdalo como PDF y súbelo.")

    meta = trafilatura.extract_metadata(html, default_url=url)
    host = urlparse(url).hostname or ""
    return Article(
        text=text,
        title=(meta.title if meta else "") or "",
        author=(meta.author if meta else "") or "",
        date=(meta.date if meta else "") or "",
        source=((meta.sitename if meta else "") or host.removeprefix("www.")),
        url=url,
        links=_external_links(html, host.removeprefix("www.")),
        archived_from=archived_from,
    )


def from_text(text: str, title: str = "", url: str = "") -> Article:
    text = re.sub(r"\n{3,}", "\n\n", (text or "").strip())
    if len(text) < 300:
        raise ExtractionError("El texto pegado es demasiado corto (mínimo unos 300 caracteres).")
    first_line = text.split("\n", 1)[0].strip()
    host = (urlparse(url).hostname or "").removeprefix("www.") if url else ""
    return Article(text=text, title=title.strip() or (first_line if len(first_line) < 200 else ""),
                   source=host or "Texto pegado", url=url.strip() if url.startswith("http") else "")


def from_pdf(data: bytes, filename: str = "") -> Article:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        raise ExtractionError("El archivo no es un PDF válido.")
    pages, links = [], []
    for page in doc:
        pages.append(page.get_text("text"))
        for ln in page.get_links():
            uri = ln.get("uri")
            if uri and uri.startswith("http") and {"url": uri, "text": ""} not in links:
                links.append({"url": uri, "text": ""})
    text = "\n".join(pages)
    # Une líneas partidas por guion y normaliza espacios
    text = re.sub(r"-\n(\w)", r"\1", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 300:
        raise ExtractionError("El PDF no contiene texto seleccionable (¿es un escaneo?).")
    meta = doc.metadata or {}
    raw_date = re.sub(r"\D", "", meta.get("creationDate") or "")[:8]
    return Article(
        text=text,
        title=meta.get("title") or filename.rsplit(".", 1)[0],
        author=meta.get("author") or "",
        date=f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}" if len(raw_date) == 8 else "",
        source=filename,
        links=links[:40],
    )
