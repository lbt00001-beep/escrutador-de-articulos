"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const VERDICTS = ["Correcto", "Mayormente correcto", "Parcialmente correcto", "Engañoso", "Incorrecto", "No verificable",
  "Opinión bien fundamentada", "Opinión discutible", "Opinión sin fundamento", "Opinión"];
const VERDICT_COLOR = {
  "Correcto": "var(--ok)", "Mayormente correcto": "var(--ok-2)", "Parcialmente correcto": "var(--mid)",
  "Engañoso": "var(--warn)", "Incorrecto": "var(--bad)", "No verificable": "var(--na)", "Opinión": "var(--op)",
  "Opinión bien fundamentada": "var(--op)", "Opinión discutible": "var(--op-2)", "Opinión sin fundamento": "var(--op-3)",
};
const CLAIM_CLASSES = ["Hecho", "Interpretación", "Valoración", "Recurso retórico", "Predicción"];
let genres = null; // géneros y rúbricas del servidor

let mode = "url";
let pdfFile = null;
let current = null; // registro del análisis mostrado

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "-");
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const fmt = (n, d = 1) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString("es-ES", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const verdict = (v) => `<span class="verdict v-${slug(v)}">${esc(v || "No verificable")}</span>`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

let cfg = null; // configuración del servidor (modelos, ajustes, versión)

/* ---------- Inicio ---------- */
const usd = (v) => (v == null ? "" : `${v < 0.1 ? fmt(v, 3) : fmt(v, 2)} $`);
const stars = (q) => "★".repeat(q || 0) + "☆".repeat(5 - (q || 0));

function modelList(selected) {
  const list = [...cfg.models];
  if (selected && !list.some((m) => m.id === selected)) list.unshift({ id: selected, name: selected, note: "Modelo personalizado del catálogo de OpenRouter." });
  return list;
}

// Selector principal: nombre y coste aproximado por análisis
function modelOptions(selected) {
  return modelList(selected).map((m) => {
    const cost = m.cost_web != null ? ` · ~${usd(m.cost_web)}/análisis` : "";
    return `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.name)}${cost}${m.badge ? ` — ${esc(m.badge)}` : ""}</option>`;
  }).join("");
}

// Ajustes: tarjetas con calidad, coste con/sin búsqueda web y si el dato es medido o estimado
function modelCards(selected) {
  return modelList(selected).map((m) => `<label class="model-card ${m.id === selected ? "selected" : ""}">
    <input type="radio" name="setModel" value="${esc(m.id)}" ${m.id === selected ? "checked" : ""}>
    <span class="mc-body">
      <span class="mc-top"><b>${esc(m.name)}</b>${m.badge ? `<span class="chip navy">${esc(m.badge)}</span>` : ""}</span>
      ${m.quality ? `<span class="mc-meta"><span class="stars" title="Calidad en esta tarea: ${m.quality} de 5">${stars(m.quality)}</span>
        <span>${usd(m.cost_web)} con web · ${usd(m.cost_noweb)} sin web</span>
        <span class="muted">${m.measured ? "medido" : "estimado"}</span></span>` : ""}
      <span class="mc-note">${esc(m.note)}</span>
    </span>
  </label>`).join("");
}

/* Almacenamiento del navegador (versión web): clave, preferencias e historial del visitante */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(`escrutador.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`escrutador.${k}`, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(`escrutador.${k}`); } catch { /* sin almacenamiento */ } },
};
const isPublic = () => Boolean(cfg && cfg.public);
const browserKey = () => (isPublic() ? LS.get("key", "") : "");
const keyHeaders = () => (browserKey() ? { "X-OpenRouter-Key": browserKey() } : {});
const maskKey = (k) => (k && k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-4)}` : "");

function applyConfig(c) {
  if (c.public) {
    // En la web, las preferencias y la clave son de cada visitante y viven en su navegador
    const prefs = LS.get("prefs", {});
    const key = LS.get("key", "");
    c = { ...c, ...prefs, has_key: Boolean(key), key_source: key ? "este navegador" : "", key_masked: maskKey(key) };
  }
  cfg = c;
  $("#model").innerHTML = modelOptions(c.default_model);
  $("#web").checked = c.web_search;
  $("#keyWarn").classList.toggle("hidden", c.has_key);
  $("#credit").textContent = `${c.credit} · versión ${c.version} · ${c.year}`;
  $("#keyStorageNote").textContent = c.public
    ? "Se guarda solo en este navegador y se envía a OpenRouter con cada análisis; nunca se almacena en el servidor."
    : "Se guarda solo en este ordenador (data/settings.json).";
  $("#pdfLimit").textContent = `máx. ${c.max_pdf_mb} MB`;
}

async function init() {
  try {
    applyConfig(await api("/api/config"));
    genres = await api("/api/genres");
    $("#genre").insertAdjacentHTML("beforeend", genres.generos.map((g) => `<option>${esc(g)}</option>`).join(""));
    if (!cfg.has_key) openSettings();
  } catch {
    showError("No se pudo conectar con el servidor.");
  }
  const m = location.hash.match(/^#a=([\w-]+)/);
  if (m) loadHistoryItem(m[1]);
}

/* ---------- Ajustes ---------- */
const dlg = $("#settings");

function renderKeyStatus() {
  const st = $("#keyStatus");
  if (cfg.has_key) {
    st.className = "key-status ok";
    st.textContent = `Clave activa ${cfg.key_masked} · guardada en: ${cfg.key_source}`;
  } else {
    st.className = "key-status none";
    st.textContent = "No hay ninguna clave configurada: la app no puede analizar hasta que añadas una.";
  }
  const removable = isPublic() ? Boolean(browserKey()) : cfg.key_source === "Ajustes";
  $("#clearKey").classList.toggle("hidden", !removable);
}

function keyMsg(text, kind = "") { const el = $("#keyMsg"); el.textContent = text; el.className = `small ${kind}`; }

async function openSettings() {
  $("#apiKey").value = "";
  $("#apiKey").type = "password";
  $("#toggleKey").textContent = "Mostrar";
  $("#customModel").value = "";
  keyMsg("");
  $("#modelList").innerHTML = modelCards(cfg.default_model);
  $("#signupGuide").open = !cfg.has_key;
  $("#setWeb").checked = cfg.web_search;
  $("#setWebResults").value = cfg.web_results;
  renderKeyStatus();
  if (!dlg.open) dlg.showModal();
  if (!$("#allModels").children.length) {
    const all = await fetch("/api/models/all").then((r) => r.json()).catch(() => []);
    $("#allModels").innerHTML = all.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.price)}</option>`).join("");
  }
}

$("#settingsBtn").onclick = openSettings;
document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) openSettings(); });

$("#toggleKey").onclick = () => {
  const inp = $("#apiKey");
  inp.type = inp.type === "password" ? "text" : "password";
  $("#toggleKey").textContent = inp.type === "password" ? "Mostrar" : "Ocultar";
};

$("#testKey").onclick = async () => {
  keyMsg("Comprobando con OpenRouter…");
  try {
    const r = await api("/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...keyHeaders() },
      body: JSON.stringify({ api_key: $("#apiKey").value.trim() }),
    });
    const saldo = r.limit_remaining != null ? ` Saldo disponible: ${fmt(r.limit_remaining, 2)} $.` : "";
    keyMsg(`Clave válida${r.label ? ` («${r.label}»)` : ""}. Gastado hasta ahora: ${fmt(r.usage, 2)} $.${saldo}`, "ok");
  } catch (e) { keyMsg(e.message, "err"); }
};

$("#clearKey").onclick = async () => {
  if (!confirm("¿Borrar la clave guardada?")) return;
  if (isPublic()) {
    LS.del("key");
    applyConfig(await api("/api/config"));
  } else {
    applyConfig(await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear_key: true }) }));
  }
  renderKeyStatus();
  keyMsg(cfg.has_key ? `Clave borrada. Se usa la de respaldo (${cfg.key_source}).` : "Clave borrada.", "ok");
};

$("#saveSettings").onclick = async () => {
  const prefs = {
    default_model: $("#customModel").value.trim() || ($('input[name="setModel"]:checked') || {}).value || cfg.default_model,
    web_search: $("#setWeb").checked,
    web_results: Math.max(1, Math.min(15, Number($("#setWebResults").value) || 8)),
  };
  const key = $("#apiKey").value.trim();
  if (key && !key.startsWith("sk-or-")) return keyMsg("La clave de OpenRouter empieza por «sk-or-».", "err");
  try {
    if (isPublic()) {
      if (key) LS.set("key", key);
      LS.set("prefs", prefs);
      applyConfig(await api("/api/config"));
    } else {
      applyConfig(await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(key ? { ...prefs, api_key: key } : prefs) }));
    }
    dlg.close();
  } catch (e) { keyMsg(e.message, "err"); }
};

$$(".tab").forEach((t) => t.addEventListener("click", () => {
  mode = t.dataset.tab;
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== mode));
}));

const drop = $("#drop");
$("#file").addEventListener("change", (e) => setFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
function setFile(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return showError("Solo se admiten archivos PDF.");
  pdfFile = f;
  $("#dropText").innerHTML = `<b>${esc(f.name)}</b> · ${fmt(f.size / 1048576)} MB — <u>cambiar</u>`;
}

/* ---------- Flujo de análisis ---------- */
const isFast = () => $("#fast").checked;
$("#fast").addEventListener("change", () => {
  // En modo rápido el modelo y la búsqueda web los fija la app
  $("#model").disabled = isFast();
  $("#web").disabled = isFast();
  $("#web").closest(".switch").classList.toggle("off", isFast());
});

const NO_TEXT_PDF = /no contiene texto seleccionable/i;

// Extrae un artículo; si es un PDF escaneado, aplica OCR en el navegador y lo envía como texto
async function extractSource(src, onStatus = () => {}) {
  const fd = new FormData();
  if (src.url) fd.append("url", src.url);
  if (src.text) {
    fd.append("text", src.text);
    fd.append("title", src.title || "");
  }
  if (src.file) fd.append("file", src.file);
  try {
    return await api("/api/extract", { method: "POST", body: fd });
  } catch (err) {
    if (!src.file || !NO_TEXT_PDF.test(err.message)) throw err;
    onStatus("PDF escaneado: reconociendo el texto con OCR…");
    const text = await ocrPdf(src.file, onStatus);
    const title = src.file.name.replace(/\.pdf$/i, "");
    const ext = await extractSource({ text, title }, onStatus);
    ext.article.source = `${src.file.name} (OCR)`;
    return ext;
  }
}

async function analyzeExtracted(ext) {
  return api("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...keyHeaders() },
    body: JSON.stringify({
      article: ext.article, metrics: ext.metrics, model: $("#model").value,
      web_search: $("#web").checked, web_results: cfg.web_results,
      genero: $("#genre").value || null, rapido: isFast(),
    }),
  });
}

function needsKey() {
  if (cfg && !cfg.has_key) { openSettings(); showError("Añade tu clave de OpenRouter en Ajustes para poder analizar."); return true; }
  return false;
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  if (mode === "batch") return runBatch();
  let src;
  if (mode === "url") {
    const url = $("#url").value.trim();
    if (!url) return showError("Pega la dirección del artículo.");
    src = { url };
  } else if (mode === "text") {
    const text = $("#pasted").value.trim();
    if (text.length < 300) return showError("Pega el texto completo del artículo (mínimo unos 300 caracteres).");
    src = { text, title: $("#pastedTitle").value.trim(), url: $("#pastedUrl").value.trim() };
  } else {
    if (!pdfFile) return showError("Elige un archivo PDF.");
    if (cfg && pdfFile.size > cfg.max_pdf_mb * 1048576) {
      return showError(`El PDF pesa ${fmt(pdfFile.size / 1048576)} MB y el máximo es ${cfg.max_pdf_mb} MB. Usa «Pegar texto» con el contenido del artículo.`);
    }
    src = { file: pdfFile };
  }
  if (needsKey()) return;

  setBusy(true);
  $("#results").classList.add("hidden");
  $("#progressNote").textContent = isFast()
    ? "Modo rápido: suele tardar unos 20 segundos."
    : "El contraste con búsqueda web suele tardar entre 30 y 90 segundos.";
  step("extract");
  let timerId;
  try {
    const ext = await extractSource(src, (msg) => { $("#progressNote").textContent = msg; });
    step("metrics");
    await new Promise((r) => setTimeout(r, 250));
    step("ai");
    const t0 = Date.now();
    timerId = setInterval(() => { $("#timer").textContent = `· ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    const rec = await analyzeExtracted(ext);
    if (isPublic()) saveLocalRecord(rec);
    step("score");
    await new Promise((r) => setTimeout(r, 300));
    render(rec);
    history.replaceState(null, "", `#a=${rec.id}`);
  } catch (err) {
    showError(err.message);
  } finally {
    clearInterval(timerId);
    $("#timer").textContent = "";
    setBusy(false);
  }
});

/* ---------- OCR de PDFs escaneados (en el navegador; el PDF no sale del equipo) ---------- */
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168";
const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_MAX_PAGES = 15;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("No se pudo cargar el motor de OCR."));
    document.head.appendChild(s);
  });
}

async function ocrPdf(file, onStatus = () => {}) {
  const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  await loadScript(TESSERACT);
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, OCR_MAX_PAGES);
  const worker = await window.Tesseract.createWorker("spa");
  const parts = [];
  try {
    for (let i = 1; i <= pages; i++) {
      onStatus(`OCR: leyendo la página ${i} de ${pages}…`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      // intent "print" evita requestAnimationFrame, que el navegador congela si la pestaña no está visible
      // (p. ej. durante un lote largo mientras el usuario está en otra pestaña)
      await page.render({ canvasContext: canvas.getContext("2d"), viewport, intent: "print" }).promise;
      const { data } = await worker.recognize(canvas);
      parts.push(data.text.trim());
    }
  } finally {
    await worker.terminate();
  }
  const text = parts.join("\n\n").replace(/-\n(\w)/g, "$1").trim();
  if (text.length < 300) throw new Error("El OCR no ha podido leer texto suficiente en el PDF.");
  return text;
}

/* ---------- Lotes ---------- */
let batchFiles = [];
let batch = null; // { items: [{label, src, estado, rec, error}], start }

$("#batchFiles").addEventListener("change", (e) => setBatchFiles([...e.target.files]));
const batchDrop = $("#batchDrop");
["dragenter", "dragover"].forEach((ev) => batchDrop.addEventListener(ev, (e) => { e.preventDefault(); batchDrop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => batchDrop.addEventListener(ev, (e) => { e.preventDefault(); batchDrop.classList.remove("over"); }));
batchDrop.addEventListener("drop", (e) => setBatchFiles([...e.dataTransfer.files]));
function setBatchFiles(files) {
  batchFiles = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  $("#batchDropText").innerHTML = batchFiles.length
    ? `<b>${batchFiles.length} PDF</b> seleccionados — <u>cambiar</u>`
    : "Y/o añade varios PDF <u>elige archivos</u>";
}

async function runBatch() {
  const urls = $("#batchUrls").value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
  const tooBig = batchFiles.filter((f) => cfg && f.size > cfg.max_pdf_mb * 1048576);
  if (tooBig.length) return showError(`Estos PDF superan ${cfg.max_pdf_mb} MB: ${tooBig.map((f) => f.name).join(", ")}.`);
  const items = [
    ...[...new Set(urls)].map((url) => ({ label: hostOf(url), src: { url } })),
    ...batchFiles.map((file) => ({ label: file.name, src: { file } })),
  ].map((it) => ({ ...it, estado: "pendiente" }));
  if (items.length < 2) return showError("Añade al menos dos enlaces o PDF para analizar un lote.");
  if (items.length > 30) return showError("El máximo por lote es de 30 artículos.");
  if (needsKey()) return;

  const coste = items.length * (isFast() ? 0.005 : $("#web").checked ? 0.04 : 0.01);
  if (!confirm(`Se van a analizar ${items.length} artículos. Coste aproximado con tu clave: ${fmt(coste, 2)} $. ¿Continuar?`)) return;

  batch = { items, start: new Date() };
  $("#go").disabled = true;
  $("#results").classList.add("hidden");
  renderBatch();
  let next = 0;
  const workerFn = async () => {
    while (next < items.length) {
      const it = items[next++];
      it.estado = "analizando";
      renderBatch();
      try {
        const ext = await extractSource(it.src, (msg) => { it.nota = msg; renderBatch(); });
        it.rec = await analyzeExtracted(ext);
        if (isPublic()) saveLocalRecord(it.rec);
        it.estado = "ok";
      } catch (err) {
        it.estado = "error";
        it.error = err.message;
      }
      it.nota = "";
      renderBatch();
    }
  };
  await Promise.all([workerFn(), workerFn()]);
  batch.end = new Date();
  $("#go").disabled = false;
  renderBatch();
}

function scoreCell(n) {
  return n == null ? "—" : `<b style="color:${scoreColor(n)}">${fmt(n)}</b>`;
}

function renderBatch() {
  const box = $("#batchProgress");
  if (!batch) { box.classList.add("hidden"); return; }
  const done = batch.items.filter((i) => i.estado === "ok" || i.estado === "error").length;
  const ok = batch.items.filter((i) => i.rec);
  const coste = ok.reduce((s, i) => s + ((i.rec.result._meta || {}).coste_usd || 0), 0);
  const finished = Boolean(batch.end);
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="batch-head">
      <h3>${finished ? "Lote terminado" : "Analizando el lote…"} <span class="muted">${done} de ${batch.items.length}</span></h3>
      <div class="batch-actions">
        ${finished && ok.length ? `<button class="btn ghost" type="button" data-batch="report">Ver informe conjunto</button>
          <button class="btn ghost" type="button" data-batch="md">Descargar Markdown</button>` : ""}
        ${finished ? `<button class="btn ghost" type="button" data-batch="close">Cerrar</button>` : ""}
      </div>
    </div>
    <div class="bar"><span style="width:${(done / batch.items.length) * 100}%;background:var(--navy)"></span></div>
    <table class="data batch-table">
      <thead><tr><th>Artículo</th><th>Género</th><th>Global</th><th>Fiabilidad</th><th>Calidad</th><th></th></tr></thead>
      <tbody>${batch.items.map((it, i) => {
        if (!it.rec) {
          const estado = it.estado === "error" ? `<span class="src-none">Error: ${esc(it.error)}</span>`
            : it.estado === "analizando" ? `<span class="muted">${esc(it.nota || "Analizando…")}</span>` : `<span class="muted">Pendiente</span>`;
          return `<tr><td>${esc(it.label)}</td><td colspan="5">${estado}</td></tr>`;
        }
        const p = it.rec.result.puntuacion || {};
        const a = it.rec.article;
        return `<tr><td><b>${esc(a.title || it.rec.result.titulo_inferido || it.label)}</b><br><span class="muted small">${esc([a.author, outletName(a.source || "")].filter(Boolean).join(" · "))}</span></td>
          <td>${esc(p.genero || it.rec.result.tipo_texto || "")}</td><td>${scoreCell(p.nota)}</td>
          <td>${scoreCell(p.fiabilidad ? p.fiabilidad.nota : null)}</td><td>${scoreCell(p.calidad ? p.calidad.nota : null)}</td>
          <td><button class="linklike" type="button" data-open="${i}">Ver</button></td></tr>`;
      }).join("")}</tbody>
    </table>
    ${finished ? `<p class="small muted">Coste total: ${fmt(coste, 3)} $. Todos los análisis están en el historial.</p>` : ""}`;
  box.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => { render(batch.items[b.dataset.open].rec); window.scrollTo({ top: box.offsetTop + box.offsetHeight }); }; });
  const act = (k) => box.querySelector(`[data-batch="${k}"]`);
  if (act("report")) act("report").onclick = renderBatchReport;
  if (act("md")) act("md").onclick = downloadBatchMarkdown;
  if (act("close")) act("close").onclick = () => { batch = null; renderBatch(); resetView(); };
}

// Informe conjunto: tabla y ficha breve de cada artículo, lista para imprimir o guardar en PDF
function renderBatchReport() {
  const ok = batch.items.filter((i) => i.rec);
  const el = $("#results");
  el.innerHTML = `<article class="card batch-report">
      <h2>Informe conjunto · ${ok.length} artículos</h2>
      <p class="muted">${esc(batch.start.toLocaleString("es-ES"))} · ${isFast() ? "modo rápido" : "análisis completo"}</p>
      <div class="secnav static"><span class="spacer"></span><button class="btn ghost" type="button" data-act="print">PDF</button></div>
      ${$("#batchProgress table").outerHTML}
    </article>
    ${ok.map((it) => {
      const r = it.rec.result, a = it.rec.article, p = r.puntuacion || {};
      return `<section class="card section batch-card">
        <h3>${esc(a.title || r.titulo_inferido)} <span class="score-pill" style="background:${scoreColor(p.nota)}">${fmt(p.nota)}</span></h3>
        <p class="sub">${esc([a.author, outletName(a.source || ""), a.date, p.genero].filter(Boolean).join(" · "))}${p.fiabilidad ? ` · Fiabilidad ${fmt(p.fiabilidad.nota)} · Calidad ${fmt(p.calidad.nota)}` : ""}</p>
        <p>${esc(r.resumen)}</p>
        ${(r.acciones_editoriales || []).length ? `<h4 class="mini">Acciones editoriales</h4><ol class="plain">${r.acciones_editoriales.map((x) => `<li>${esc(x.accion)}</li>`).join("")}</ol>` : ""}
        <div class="grid2"><div><h4 class="mini">Fortalezas</h4><ul class="plain">${(r.fortalezas || []).slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><h4 class="mini">Debilidades</h4><ul class="plain">${(r.debilidades || []).slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
      </section>`;
    }).join("")}`;
  el.querySelectorAll(".batch-report [data-open]").forEach((b) => b.remove());
  el.querySelector('[data-act="print"]').onclick = () => {
    document.title = `Informe conjunto - ${ok.length} articulos - ${batch.start.toISOString().slice(0, 10)}`;
    window.print();
  };
  el.classList.remove("hidden");
  $("#intake").classList.add("hidden");
  current = null;
}

function downloadBatchMarkdown() {
  const ok = batch.items.filter((i) => i.rec);
  const L = [`# Informe conjunto · ${ok.length} artículos`, "", `${batch.start.toLocaleString("es-ES")}`, "",
    "| Artículo | Medio | Género | Global | Fiabilidad | Calidad |", "|---|---|---|---|---|---|"];
  ok.forEach((it) => {
    const p = it.rec.result.puntuacion || {}, a = it.rec.article;
    L.push(`| ${a.title || it.rec.result.titulo_inferido} | ${outletName(a.source || "")} | ${p.genero || ""} | ${p.nota} | ${p.fiabilidad ? p.fiabilidad.nota ?? "—" : "—"} | ${p.calidad ? p.calidad.nota : "—"} |`);
  });
  batch.items.filter((i) => i.estado === "error").forEach((it) => L.push(`| ${it.label} | — | ERROR: ${it.error} | | | |`));
  ok.forEach((it) => {
    const r = it.rec.result, a = it.rec.article, p = r.puntuacion || {};
    L.push("", `## ${a.title || r.titulo_inferido} — ${p.nota}/10`, "", [a.author, outletName(a.source || ""), a.date, a.url].filter(Boolean).join(" · "), "", r.resumen, "");
    if ((r.acciones_editoriales || []).length) {
      L.push("**Acciones editoriales:**", "");
      r.acciones_editoriales.forEach((x, n) => L.push(`${n + 1}. ${x.accion}${x.motivo ? ` — ${x.motivo}` : ""}`));
      L.push("");
    }
  });
  L.push("---", "", `*${$("#credit").textContent}*`, "");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([L.join("\n")], { type: "text/markdown;charset=utf-8" }));
  link.download = `Informe conjunto - ${ok.length} articulos - ${batch.start.toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------- Comparar dos análisis ---------- */
const compareSel = new Set();
function updateCompareBar() {
  $("#compareBtn").disabled = compareSel.size !== 2;
  $("#compareHint").textContent = compareSel.size === 2 ? "Listo para comparar." : `Marca dos análisis para compararlos (${compareSel.size}/2).`;
}
$("#compareBtn").onclick = async () => {
  const [a, b] = await Promise.all([...compareSel].map(getRecord));
  toggleDrawer(false);
  if (a && b) renderCompare(a, b);
};

async function getRecord(id) {
  return isPublic() ? LS.get("history", []).find((r) => r.id === id) : api(`/api/history/${id}`);
}

function renderCompare(a, b) {
  const recs = [a, b];
  const ps = recs.map((r) => r.result.puntuacion || {});
  // Criterios de calidad de ambos análisis (pueden ser de géneros distintos)
  const keys = [];
  ps.forEach((p) => (p.desglose || []).forEach((c) => { if (!keys.some((k) => k.clave === c.clave)) keys.push(c); }));
  const val = (p, key) => { const c = (p.desglose || []).find((x) => x.clave === key); return c ? c.puntuacion : null; };
  const head = (r, p) => `<div class="cmp-col">
      <div class="kicker"><span class="chip navy">${esc(p.genero || r.result.tipo_texto || "")}</span></div>
      <h3>${esc(r.article.title || r.result.titulo_inferido)}</h3>
      <p class="byline">${esc([r.article.author, outletName(r.article.source || ""), r.article.date].filter(Boolean).join(" · "))}</p>
      <div class="cmp-scores">
        <div><span class="k">Global</span>${scoreCell(p.nota)}</div>
        <div><span class="k">Fiabilidad</span>${scoreCell(p.fiabilidad ? p.fiabilidad.nota : null)}</div>
        <div><span class="k">Calidad</span>${scoreCell(p.calidad ? p.calidad.nota : null)}</div>
      </div>
      <p class="small">${esc(r.result.resumen)}</p>
    </div>`;
  const facts = (r) => {
    const counts = {};
    (r.result.verificacion || []).forEach((v) => { counts[v.veredicto] = (counts[v.veredicto] || 0) + 1; });
    return Object.entries(counts).map(([k, n]) => `${verdict(k)} <span class="muted">${n}</span>`).join(" ") || "<span class='muted'>—</span>";
  };
  const list = (arr) => `<ul class="plain">${(arr || []).slice(0, 4).map((x) => `<li>${esc(typeof x === "string" ? x : x.accion)}</li>`).join("") || "<li>—</li>"}</ul>`;
  const el = $("#results");
  el.innerHTML = `<article class="card compare">
      <div class="batch-head"><h2>Comparación</h2>
        <div class="batch-actions"><button class="btn ghost" type="button" data-act="print">PDF</button><button class="btn ghost" type="button" data-act="new">Nuevo análisis</button></div></div>
      ${ps.some((p) => p.version !== 2) ? `<p class="warn">Uno de los análisis usa los criterios antiguos (v1): sus notas no son comparables con las de la v2. Vuelve a analizarlo para compararlos con justicia.</p>` : ""}
      ${ps[0].genero && ps[1].genero && ps[0].genero !== ps[1].genero ? `<p class="small muted">Son géneros distintos: la calidad se mide con rúbricas diferentes. La fiabilidad sí es directamente comparable.</p>` : ""}
      <div class="cmp-grid">${head(a, ps[0])}${head(b, ps[1])}</div>
      <h4 class="mini">Criterios de calidad</h4>
      <table class="data cmp-table"><thead><tr><th>Criterio</th><th>A</th><th>B</th></tr></thead><tbody>
        ${keys.map((k) => `<tr><td>${esc(k.nombre)}</td><td>${scoreCell(val(ps[0], k.clave))}</td><td>${scoreCell(val(ps[1], k.clave))}</td></tr>`).join("")}
      </tbody></table>
      <div class="cmp-grid">
        <div class="cmp-col"><h4 class="mini">Hechos verificados</h4>${facts(a)}<h4 class="mini">Fortalezas</h4>${list(a.result.fortalezas)}<h4 class="mini">Debilidades</h4>${list(a.result.debilidades)}<h4 class="mini">Acciones editoriales</h4>${list(a.result.acciones_editoriales)}</div>
        <div class="cmp-col"><h4 class="mini">Hechos verificados</h4>${facts(b)}<h4 class="mini">Fortalezas</h4>${list(b.result.fortalezas)}<h4 class="mini">Debilidades</h4>${list(b.result.debilidades)}<h4 class="mini">Acciones editoriales</h4>${list(b.result.acciones_editoriales)}</div>
      </div>
    </article>`;
  el.classList.remove("hidden");
  $("#intake").classList.add("hidden");
  current = null;
  el.querySelector('[data-act="print"]').onclick = () => window.print();
  el.querySelector('[data-act="new"]').onclick = resetView;
  window.scrollTo({ top: 0 });
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.detail || `Error ${r.status}`);
  return data;
}

function setBusy(b) {
  $("#go").disabled = b;
  $("#go").textContent = b ? "Analizando…" : "Analizar artículo";
  $("#progress").classList.toggle("hidden", !b);
}
function step(name) {
  const order = ["extract", "metrics", "ai", "score"];
  const idx = order.indexOf(name);
  $$(".steps li").forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.className = i < idx ? "done" : i === idx ? "active" : "";
  });
}
function showError(msg) { const e = $("#error"); e.textContent = msg; e.classList.remove("hidden"); }
function hideError() { $("#error").classList.add("hidden"); }

/* ---------- Render del informe ---------- */
const isV2 = (p) => Boolean(p && p.version === 2);
const pct = (w) => `${Math.round(w * 100)} %`;

function genreSelect(p) {
  const list = (genres && genres.generos) || [p.genero];
  return `<label class="genre-pick">Evaluado como
    <select id="genrePick">${list.map((g) => `<option ${g === p.genero ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
    ${p.genero !== p.genero_detectado ? `<span class="muted small">(la IA lo detectó como ${esc(p.genero_detectado)})</span>` : ""}
  </label>`;
}

function headScore(p) {
  if (!isV2(p)) {
    return `<div class="score">${dial(p.nota)}<div class="label" style="color:${scoreColor(p.nota)}">${esc(p.etiqueta || "")}</div>
      ${p.limite ? `<div class="cap">${esc(p.limite)}</div>` : ""}
      <div class="legacy-note">Criterios antiguos (v1). Vuelve a analizarlo para obtener fiabilidad y calidad por separado.</div></div>`;
  }
  const f = p.fiabilidad, c = p.calidad;
  return `<div class="score">${dial(p.nota)}<div class="label" style="color:${scoreColor(p.nota)}">${esc(p.etiqueta)}</div>
    ${p.limite ? `<div class="cap">${esc(p.limite)}</div>` : ""}
    <div class="subscores">
      <div><span class="k">Fiabilidad</span><span class="v" style="color:${scoreColor(f.nota)}">${f.nota == null ? "—" : fmt(f.nota)}</span><span class="l">${esc(f.etiqueta)}</span></div>
      <div><span class="k">Calidad</span><span class="v" style="color:${scoreColor(c.nota)}">${fmt(c.nota)}</span><span class="l">${esc(c.etiqueta)}</span></div>
    </div></div>`;
}

function render(rec) {
  current = rec;
  const { article: a, metrics: m, result: r } = rec;
  const p = r.puntuacion || {};
  const title = a.title || r.titulo_inferido || "Artículo sin título";
  const byline = [a.author && `Por ${esc(a.author)}`, a.source && esc(outletName(a.source) || a.source), a.date && esc(a.date),
    safeUrl(a.url) && `<a href="${esc(a.url)}" target="_blank" rel="noopener">ver original ↗</a>`].filter(Boolean).join(" · ");

  const html = `
  <article class="card">
    <div class="report-head">
      <div>
        <div class="kicker">${isV2(p) ? genreSelect(p) : `<span class="chip navy">${esc(r.tipo_texto || "Artículo")}</span>`}<span class="chip">${esc(m.idioma)} · ${fmt(m.palabras, 0)} palabras · ${m.minutos_lectura} min</span></div>
        <h2>${esc(title)}</h2>
        <div class="byline">${byline}</div>
        ${m.posible_texto_parcial ? `<p class="warn" style="margin:0 0 14px">Solo se han podido leer ${fmt(m.palabras, 0)} palabras. Si el artículo es de pago o está incompleto, cópialo desde el navegador en «Pegar texto» o súbelo en PDF para un análisis completo.</p>` : ""}
        ${safeUrl(a.archived_from) ? `<p class="source-note">La web original bloqueó la descarga; se ha leído la <a href="${esc(a.archived_from)}" target="_blank" rel="noopener">copia guardada en archive.org</a>.</p>` : ""}
        ${(r._meta || {}).modo === "rapido" ? `<p class="warn" style="margin:0 0 14px"><b>Modo rápido:</b> los datos se han comprobado solo con el conocimiento del modelo, sin buscar en la web. Para una verificación completa, vuelve a analizarlo sin modo rápido.</p>` : ""}
        <p class="summary">${esc(r.resumen)}</p>
        <div class="thesis"><b>Tesis del autor:</b> ${esc(r.tesis)}</div>
      </div>
      ${headScore(p)}
    </div>
  </article>

  <nav class="secnav">
    <a href="#s-texto">Texto original</a><a href="#s-datos">1 · Datos del autor</a><a href="#s-verif">2 · Verificación</a><a href="#s-ideas">3 · Ideas</a>
    <a href="#s-rigor">4 · Rigor</a><a href="#s-ind">5 · Indicadores</a><a href="#s-val">6 · Valoración</a>
    <span class="spacer"></span>
    <button class="btn ghost" type="button" data-act="md">Markdown</button>
    <button class="btn ghost" type="button" data-act="print">PDF</button>
    <button class="btn ghost" type="button" data-act="new">Nuevo</button>
  </nav>

  ${sectionTexto(a, m)}
  ${sectionDatos(r)}
  ${sectionVerificacion(r)}
  ${sectionIdeas(r)}
  ${sectionRigor(r)}
  ${sectionIndicadores(m)}
  ${sectionValoracion(r, p)}`;

  const el = $("#results");
  el.innerHTML = html;
  el.classList.remove("hidden");
  $("#intake").classList.add("hidden");
  $("#progress").classList.add("hidden");
  requestAnimationFrame(() => { const arc = $(".dial .arc"); if (arc) arc.style.strokeDashoffset = arc.dataset.target; });
  el.querySelector('[data-act="md"]').onclick = downloadMarkdown;
  el.querySelector('[data-act="print"]').onclick = () => window.print();
  el.querySelector('[data-act="new"]').onclick = resetView;
  const toggle = el.querySelector('[data-act="toggle-text"]');
  if (toggle) toggle.onclick = () => {
    const box = $("#originalText");
    const collapsed = box.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "Leer el artículo completo" : "Contraer el texto";
    if (collapsed) $("#s-texto").scrollIntoView({ behavior: "smooth" });
  };
  const pick = $("#genrePick");
  if (pick) pick.onchange = () => regrade(pick.value);
}

/* Re-evalúa como otro género con los criterios ya puntuados: sin IA y sin coste */
async function regrade(genero) {
  try {
    const p = await api("/api/rescore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: current.result, genero, record_id: isPublic() ? null : current.id }),
    });
    current.result.puntuacion = p;
    if (isPublic()) saveLocalRecord(current);
    const y = window.scrollY;
    render(current);
    window.scrollTo({ top: y });
  } catch (e) { showError(e.message); }
}

function scoreColor(n) {
  if (n == null) return "var(--muted)";
  return n >= 7 ? "var(--ok)" : n >= 5.5 ? "var(--mid)" : n >= 4 ? "var(--warn)" : "var(--bad)";
}

function dial(n) {
  const R = 74, C = 2 * Math.PI * R, v = Math.max(0, Math.min(10, n || 0));
  return `<div class="dial"><svg width="170" height="170" viewBox="0 0 170 170">
    <circle cx="85" cy="85" r="${R}" fill="none" stroke="var(--line-2)" stroke-width="12"/>
    <circle class="arc" cx="85" cy="85" r="${R}" fill="none" stroke="${scoreColor(n)}" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - v / 10)}" style="transition:stroke-dashoffset 1.1s ease"/></svg>
    <div class="val"><span class="num">${fmt(n)}</span><span class="of">sobre 10</span></div></div>`;
}

function section(id, n, title, sub, body) {
  return `<section class="card section" id="${id}"><h3><span class="n">${n}</span>${title}</h3><p class="sub">${sub}</p>${body}</section>`;
}

/* Texto íntegro extraído, para que el lector pueda contrastar el análisis con la fuente */
function sectionTexto(a, m) {
  const paras = String(a.text || "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const origin = safeUrl(a.url)
    ? `Fuente: <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(hostOf(a.url))} ↗</a>`
    : `Fuente: ${esc(a.source || "texto aportado por el usuario")}`;
  const archived = safeUrl(a.archived_from) ? ` · leído desde la <a href="${esc(a.archived_from)}" target="_blank" rel="noopener">copia de archive.org</a>` : "";
  const long = paras.length > 4 || (m.palabras || 0) > 350;
  return `<section class="card section" id="s-texto">
    <h3><span class="n" aria-hidden="true">¶</span>Texto original del artículo</h3>
    <p class="sub">${origin}${archived} · ${fmt(m.palabras, 0)} palabras, tal como se ha extraído y analizado.</p>
    <div class="original ${long ? "collapsed" : ""}" id="originalText">
      ${paras.map((p) => `<p>${esc(p)}</p>`).join("")}
    </div>
    ${long ? `<button class="btn ghost toggle-text" type="button" data-act="toggle-text" aria-expanded="false" aria-controls="originalText">Leer el artículo completo</button>` : ""}
  </section>`;
}

function sectionDatos(r) {
  const rows = r.datos_del_autor || [];
  if (!rows.length) return section("s-datos", 1, "Datos en los que se apoya el autor", "Cifras, estudios, declaraciones y hechos que el artículo usa como respaldo.",
    `<p class="empty">El artículo no se apoya en datos concretos: sus afirmaciones descansan en la argumentación o la opinión del autor.</p>`);
  const sinFuente = rows.filter((d) => d.tipo_fuente === "Sin fuente").length;
  const types = {};
  rows.forEach((d) => { types[d.tipo_fuente] = (types[d.tipo_fuente] || 0) + 1; });
  const bar = Object.entries(types).sort((x, y) => y[1] - x[1]).map(([t, c]) => `<span class="chip">${esc(t)} · ${c}</span>`).join("");
  return section("s-datos", 1, "Datos en los que se apoya el autor",
    `${rows.length} datos identificados · <b>${rows.length - sinFuente}</b> con fuente citada, <b>${sinFuente}</b> sin fuente.`,
    `<div class="sourcebar">${bar}</div>
    <table class="data"><thead><tr><th style="width:36%">Dato</th><th style="width:22%">Fuente citada</th><th>Fragmento del artículo</th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td>${esc(d.dato)}<br><span class="chip" style="margin-top:6px">${esc(d.tipo_fuente)}</span></td>
      <td class="${d.tipo_fuente === "Sin fuente" ? "src-none" : ""}">${esc(d.fuente_citada)}</td>
      <td class="frag">“${esc(d.fragmento)}”</td></tr>`).join("")}
    </tbody></table>`);
}

function distribution(items) {
  const counts = {};
  items.forEach((i) => { counts[i.veredicto] = (counts[i.veredicto] || 0) + 1; });
  const total = items.length || 1;
  const present = VERDICTS.filter((v) => counts[v]);
  return `<div class="distribution">${present.map((v) => `<span style="--vc:${VERDICT_COLOR[v]};width:${(counts[v] / total) * 100}%"></span>`).join("")}</div>
    <div class="legend">${present.map((v) => `${verdict(v)} <span class="muted">${counts[v]}</span>`).join("")}</div>`;
}

/* Clasificación previa: qué se verifica (hechos) y qué no (interpretaciones, valoraciones, retórica) */
function claimClasses(r) {
  const claims = r.afirmaciones || [];
  if (!claims.length) return "";
  const counts = {};
  claims.forEach((c) => { counts[c.clase] = (counts[c.clase] || 0) + 1; });
  const others = claims.filter((c) => c.clase !== "Hecho");
  return `<div class="classes">
      <span class="small muted">Afirmaciones clasificadas antes de verificar:</span>
      ${CLAIM_CLASSES.filter((k) => counts[k]).map((k) => `<span class="chip cls cls-${slug(k)}">${esc(k)} · ${counts[k]}</span>`).join("")}
    </div>
    ${others.length ? `<details class="not-verified"><summary>Ver las ${others.length} afirmaciones que no se verifican porque no son hechos</summary>
      <ul>${others.map((c) => `<li><span class="chip cls cls-${slug(c.clase)}">${esc(c.clase)}</span>${c.central ? `<span class="tag-central">central</span>` : ""} ${esc(c.texto)}</li>`).join("")}</ul>
    </details>` : ""}`;
}

function sectionVerificacion(r) {
  const items = r.verificacion || [];
  const v2 = isV2(r.puntuacion);
  const sub = v2
    ? "Solo se verifican los hechos. Las interpretaciones, valoraciones y recursos retóricos se juzgan en las secciones 3 y 6."
    : "Datos externos que confirman o refutan lo que afirma el artículo.";
  if (!items.length) return section("s-verif", 2, "Contraste de los hechos", sub, `${claimClasses(r)}<p class="empty">No hay hechos verificables relevantes.</p>`);
  return section("s-verif", 2, "Contraste de los hechos", sub,
    `${claimClasses(r)}${distribution(items)}<div class="claims">${items.map((c) => {
      const links = (c.fuentes || []).filter((f) => safeUrl(f.url));
      return `<div class="claim" style="--vc:${VERDICT_COLOR[c.veredicto] || "var(--na)"}">
        <div class="claim-top"><div class="claim-q">${c.central ? `<span class="tag-central">central</span>` : ""}${esc(c.afirmacion)}</div>
          <div class="claim-v">${verdict(c.veredicto)}${c.confianza ? `<span class="conf conf-${esc(c.confianza)}">confianza ${esc(c.confianza)}</span>` : ""}</div></div>
        <p><span class="ev-label">Evidencia · </span>${esc(c.evidencia)}</p>
        ${links.length ? `<ul class="links">${links.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.titulo)}">${esc(hostOf(f.url))} · ${esc(f.titulo)}</a></li>`).join("")}</ul>` : ""}
      </div>`;
    }).join("")}</div>`);
}

function sectionIdeas(r) {
  const ideas = r.ideas_principales || [];
  const all = ideas.flatMap((i) => [i, ...(i.secundarias || [])]);
  const rating = (i) => `<div class="idea-rating"><span class="sep">→</span>${verdict(i.veredicto)}${esc(i.justificacion)}</div>`;
  return section("s-ideas", 3, "Ideas principales y secundarias",
    isV2(r.puntuacion) ? "Los hechos se califican por su exactitud; las opiniones, por lo bien fundamentadas que están." : "Cada idea va seguida de su calificación.",
    `${distribution(all)}<ol class="ideas">${ideas.map((i) => `<li>
      <div class="idea-text">${esc(i.idea)}</div>${rating(i)}
      ${(i.secundarias || []).length ? `<ul class="secondary">${i.secundarias.map((s) => `<li><div class="idea-text"><span class="tag">Secundaria</span>${esc(s.idea)}</div>${rating(s)}</li>`).join("")}</ul>` : ""}
    </li>`).join("")}</ol>`);
}

function sectionRigor(r) {
  const fal = r.falacias_y_sesgos || [];
  const om = (r.omisiones || []).map((o) => (typeof o === "string" ? { omision: o } : o));
  const pp = r.perspectivas || {};
  const conf = (c) => (c ? `<span class="conf conf-${esc(c)}">confianza ${esc(c)}</span>` : "");
  return section("s-rigor", 4, "Rigor argumental y contexto",
    "Solo se señalan los problemas claros; una lista vacía es buena señal, no un fallo del análisis.",
    `<div class="grid2">
      <div class="box"><h4>Falacias y sesgos (${fal.length})</h4>
        ${fal.length ? fal.map((f) => `<div class="fallacy"><b>${esc(f.tipo)}</b> ${conf(f.confianza)}<q>“${esc(f.fragmento)}”</q><span class="muted small">${esc(f.explicacion)}</span></div>`).join("") : `<p class="empty">No se detectan falacias claras.</p>`}
      </div>
      <div>
        <div class="box"><h4>Contexto omitido que cambiaría la conclusión (${om.length})</h4>
          ${om.length ? `<ul class="plain">${om.map((o) => `<li>${esc(o.omision)}${o.relevancia ? ` <span class="conf conf-${o.relevancia === "alta" ? "alta" : "media"}">relevancia ${esc(o.relevancia)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="empty">Sin omisiones relevantes.</p>`}</div>
        <div class="box" style="margin-top:20px"><h4>Perspectivas presentes</h4>
          <div class="persp-list">${(pp.presentes || []).map((x) => `<span class="chip">${esc(x)}</span>`).join("") || `<span class="empty">—</span>`}</div></div>
        <div class="box" style="margin-top:16px"><h4>Perspectivas ausentes</h4>
          <div class="persp-list missing">${(pp.ausentes || []).map((x) => `<span class="chip">${esc(x)}</span>`).join("") || `<span class="empty">—</span>`}</div></div>
      </div>
    </div>`);
}

function sectionIndicadores(m) {
  const stat = (k, v, h) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="h">${h}</div></div>`;
  return section("s-ind", 5, "Indicadores objetivos del texto",
    "Medidas calculadas automáticamente sobre el texto, sin intervención de la IA. Son descriptivas: no entran en la nota (una prosa culta da legibilidad baja sin ser peor).",
    `<div class="stats">
      ${stat("Legibilidad", fmt(m.legibilidad), `${esc(m.legibilidad_nivel)} (índice ${esc(m.legibilidad_indice)})`)}
      ${stat("Palabras por frase", fmt(m.palabras_por_frase), m.palabras_por_frase > 28 ? "Frases largas" : "Longitud adecuada")}
      ${stat("Cifras", fmt(m.cifras, 0), `${fmt(m.cifras_por_1000)} por cada 1.000 palabras`)}
      ${stat("Atribuciones", fmt(m.atribuciones, 0), "“según”, “informe”, “declaró”…")}
      ${stat("Citas textuales", fmt(m.citas_textuales, 0), "Entre comillas")}
      ${stat("Enlaces externos", fmt(m.enlaces_externos, 0), "Fuentes enlazadas en el texto")}
      ${stat("Lenguaje cargado", fmt(m.lenguaje_cargado, 0), m.lenguaje_cargado_ejemplos?.length ? esc(m.lenguaje_cargado_ejemplos.join(", ")) : "Sin términos emocionales")}
      ${stat("Absolutos", fmt(m.absolutos, 0), "“siempre”, “nadie”, “sin duda”…")}
      ${stat("Matizadores", fmt(m.matizadores, 0), "“quizá”, “probablemente”…")}
      ${stat("Primera persona", fmt(m.primera_persona, 0), "Marcas de opinión personal")}
    </div>`);
}

function rubricBars(desglose) {
  return `<div class="rubric">${(desglose || []).map((c) => `<div>
      <div class="crit-top"><span class="crit-name">${esc(c.nombre)}<small>peso ${pct(c.peso)}</small></span><span class="crit-val">${fmt(c.puntuacion)}</span></div>
      <div class="bar"><span style="width:${c.puntuacion * 10}%;background:${scoreColor(c.puntuacion)}"></span></div>
      <div class="crit-just">${esc(c.justificacion)}</div>
      ${c.origen && c.origen !== "Evaluación del modelo" ? `<div class="crit-origin">${esc(c.origen)}</div>` : ""}
    </div>`).join("")}</div>`;
}

function sectionValoracion(r, p) {
  const meta = r._meta || {};
  const webs = meta.fuentes_web || [];
  let body;
  if (isV2(p)) {
    const f = p.fiabilidad, c = p.calidad;
    const formula = f.nota == null
      ? "No hay hechos verificables con confianza suficiente, así que la nota global es la de calidad."
      : `Nota global = ${pct(p.peso_fiabilidad)} fiabilidad (${fmt(f.nota)}) + ${pct(1 - p.peso_fiabilidad)} calidad (${fmt(c.nota)}), según la rúbrica de «${esc(p.genero)}».`;
    body = `<p class="formula">${formula}</p>
      <div class="two-scores">
        <div class="score-block">
          <h4>Fiabilidad factual <span style="color:${scoreColor(f.nota)}">${f.nota == null ? "—" : fmt(f.nota)}</span></h4>
          <p class="small">${esc(f.etiqueta)}. Calculada a partir de ${f.hechos_contados} de ${f.hechos_verificados} hechos verificados: los centrales pesan el doble y los de confianza baja no cuentan. Correcto 10 · Mayormente correcto 8 · Parcialmente 5 · Engañoso 2,5 · Incorrecto 0. Con pocos hechos, la nota se modera hacia 6 para que un solo veredicto no la lleve a un extremo.</p>
        </div>
        <div class="score-block">
          <h4>Calidad como ${esc(p.genero)} <span style="color:${scoreColor(c.nota)}">${fmt(c.nota)}</span></h4>
          <p class="small">${esc(c.etiqueta)}. Criterios y pesos propios del género; cambia el género arriba para ver cómo se valoraría con otra rúbrica.</p>
        </div>
      </div>
      ${rubricBars(c.desglose)}`;
  } else {
    body = `<p class="formula">Análisis hecho con los criterios antiguos (v1): una sola nota con siete criterios iguales para todos los géneros.</p>${rubricBars(p.desglose)}`;
  }
  return section("s-val", 6, `Valoración final: ${fmt(p.nota)} / 10`,
    isV2(p) ? "Dos preguntas distintas: ¿son ciertos los hechos? (fiabilidad) y ¿es un buen texto de su género? (calidad)." : "",
    `${body}
    ${p.limite ? `<p class="warn">${esc(p.limite)} Nota sin límite: ${fmt(p.nota_sin_limite)}.</p>` : ""}
    <div class="grid2">
      <div class="box"><h4>Fortalezas</h4><ul class="plain">${(r.fortalezas || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
      <div class="box"><h4>Debilidades</h4><ul class="plain">${(r.debilidades || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
    </div>
    <div class="verdict-box"><h4>Valoración global</h4><p>${esc(r.valoracion_global)}</p></div>
    ${(r.acciones_editoriales || []).length ? `<div class="actions-box"><h4>Acciones editoriales <span class="muted small">lo que un editor pediría para mejorar este texto</span></h4>
      <ol>${r.acciones_editoriales.map((x) => `<li><b>${esc(x.accion)}</b>${x.motivo ? `<span class="muted"> — ${esc(x.motivo)}</span>` : ""}</li>`).join("")}</ol></div>` : ""}
    <div class="meta-line">Modelo: ${esc(meta.modelo)} · Búsqueda web: ${meta.busqueda_web ? "sí" : "no"} · Criterios v${meta.criterios_version || 1}
      ${meta.coste_usd != null ? ` · Coste: ${fmt(meta.coste_usd, 4)} $` : ""}
      ${meta.tokens_entrada ? ` · Tokens: ${fmt(meta.tokens_entrada, 0)} / ${fmt(meta.tokens_salida, 0)}` : ""}
      · Analizado el ${esc(new Date(current.fecha_analisis).toLocaleString("es-ES"))}</div>
    ${webs.length ? `<details class="webs"><summary>Fuentes web consultadas por la IA (${webs.length})</summary>
      <ul class="links">${webs.filter((w) => safeUrl(w.url)).map((w) => `<li><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(hostOf(w.url))} · ${esc(w.titulo)}</a></li>`).join("")}</ul></details>` : ""}`);
}

/* «Ediciones EL PAÍS S.L.» -> «EL PAÍS»: quita la razón social del nombre del medio */
function outletName(v) {
  return fileSafe(v)
    .replace(/^(ediciones|grupo|editorial|editora|publicaciones)\s+/i, "")
    .replace(/[,\s]+(s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|ltd\.?|llc|inc\.?|gmbh|plc)$/i, "")
    .trim();
}

/* Quita los caracteres prohibidos en nombres de archivo de Windows (incluida la barra invertida) */
function fileSafe(v) {
  return String(v || "").replaceAll(String.fromCharCode(92), " ")
    .replace(/[/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/* Nombre de archivo del informe: «Autor - Título - Medio - Fecha» */
function reportFileName() {
  if (!current) return "Escrutador de Artículos";
  const { article: a, result: r } = current;
  const title = fileSafe(a.title || r.titulo_inferido).slice(0, 110);
  const source = a.source && a.source !== "Texto pegado" && !/\.pdf$/i.test(a.source) ? outletName(a.source) : "";
  const parts = [fileSafe(a.author), title, source, fileSafe(a.date)].filter(Boolean);
  return parts.length ? parts.join(" - ") : "Informe Escrutador";
}

// El navegador usa document.title como nombre del PDF al «Guardar como PDF» (también con Ctrl+P)
const APP_TITLE = document.title;
window.addEventListener("beforeprint", () => { if (current && !$("#results").classList.contains("hidden")) document.title = reportFileName(); });
window.addEventListener("afterprint", () => { document.title = APP_TITLE; });

function resetView() {
  $("#results").classList.add("hidden");
  $("#intake").classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
  window.scrollTo({ top: 0 });
}

/* ---------- Exportar a Markdown ---------- */
function downloadMarkdown() {
  const { article: a, result: r } = current;
  const p = r.puntuacion || {};
  const L = [];
  L.push(`# ${a.title || r.titulo_inferido}`, "");
  L.push([a.author, outletName(a.source), a.date, a.url].filter(Boolean).join(" · "), "");
  if (isV2(p)) {
    const f = p.fiabilidad, c = p.calidad;
    L.push(`**Nota global: ${p.nota}/10 — ${p.etiqueta}**  `,
      `Fiabilidad factual: ${f.nota == null ? "sin hechos verificables" : `${f.nota}/10 (${f.etiqueta})`}  `,
      `Calidad como ${p.genero}: ${c.nota}/10 (${c.etiqueta})  `,
      `Género detectado: ${p.genero_detectado}`, "");
  } else {
    L.push(`**Nota: ${p.nota}/10 — ${p.etiqueta}** (criterios v1)  `, `Tipo: ${r.tipo_texto}`, "");
  }
  L.push(`> ${r.resumen}`, "", `**Tesis:** ${r.tesis}`, "");
  L.push("## Texto original del artículo", "");
  if (a.url) L.push(`Fuente: ${a.url}${a.archived_from ? ` (leído desde ${a.archived_from})` : ""}`, "");
  String(a.text || "").split(/\n+/).map((x) => x.trim()).filter(Boolean).forEach((x) => L.push(`> ${x}`, ">"));
  L.push("");
  L.push("## 1. Datos en los que se apoya el autor", "");
  (r.datos_del_autor || []).forEach((d) => L.push(`- ${d.dato} — *Fuente:* ${d.fuente_citada} (${d.tipo_fuente})`));
  L.push("", "## 2. Contraste de los hechos", "");
  if ((r.afirmaciones || []).length) {
    const counts = {};
    r.afirmaciones.forEach((c) => { counts[c.clase] = (counts[c.clase] || 0) + 1; });
    L.push(`Afirmaciones clasificadas: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");
  }
  (r.verificacion || []).forEach((c) => {
    L.push(`- ${c.central ? "[central] " : ""}**${c.afirmacion}** → **${c.veredicto}**${c.confianza ? ` (confianza ${c.confianza})` : ""}`, `  ${c.evidencia}`);
    (c.fuentes || []).filter((f) => f.url).forEach((f) => L.push(`  - [${f.titulo}](${f.url})`));
  });
  L.push("", "## 3. Ideas principales y secundarias", "");
  (r.ideas_principales || []).forEach((i, n) => {
    L.push(`${n + 1}. ${i.idea} → **${i.veredicto}**: ${i.justificacion}`);
    (i.secundarias || []).forEach((s) => L.push(`   - ${s.idea} → **${s.veredicto}**: ${s.justificacion}`));
  });
  L.push("", "## 4. Rigor", "");
  (r.falacias_y_sesgos || []).forEach((f) => L.push(`- **${f.tipo}**${f.confianza ? ` (confianza ${f.confianza})` : ""}: “${f.fragmento}” — ${f.explicacion}`));
  (r.omisiones || []).forEach((o) => L.push(`- Omisión: ${typeof o === "string" ? o : `${o.omision} (relevancia ${o.relevancia})`}`));
  L.push("", "## 5. Valoración", "");
  if (isV2(p)) L.push(`Rúbrica de «${p.genero}». Nota global = ${Math.round(p.peso_fiabilidad * 100)} % fiabilidad + ${Math.round((1 - p.peso_fiabilidad) * 100)} % calidad.`, "");
  L.push("| Criterio | Peso | Nota |", "|---|---|---|");
  (p.desglose || []).forEach((c) => L.push(`| ${c.nombre} | ${Math.round(c.peso * 100)} % | ${c.puntuacion} |`));
  if (p.limite) L.push("", `*${p.limite}*`);
  L.push("", `**Nota final: ${p.nota}/10**`, "", r.valoracion_global, "");
  if ((r.acciones_editoriales || []).length) {
    L.push("## 6. Acciones editoriales", "");
    r.acciones_editoriales.forEach((x, n) => L.push(`${n + 1}. ${x.accion}${x.motivo ? ` — ${x.motivo}` : ""}`));
    L.push("");
  }
  if ((r._meta || {}).modo === "rapido") L.push("*Modo rápido: los datos se comprobaron solo con el conocimiento del modelo, sin búsqueda web.*", "");
  L.push("---", "", `*Informe generado con Escrutador de Artículos (modelo ${(r._meta || {}).modelo || ""}). ${$("#credit").textContent}*`, "");
  const blob = new Blob([L.join("\n")], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${reportFileName()}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------- Historial ---------- */
function toggleDrawer(open) {
  $("#drawer").classList.toggle("open", open);
  $("#scrim").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  if (open) loadHistory();
}
$("#historyBtn").onclick = () => toggleDrawer(true);
$("#closeDrawer").onclick = () => toggleDrawer(false);
$("#scrim").onclick = () => toggleDrawer(false);

/* En la web el historial vive en el navegador del visitante; en local, en el servidor */
const MAX_LOCAL_HISTORY = 25;

function saveLocalRecord(rec) {
  let items = [rec, ...LS.get("history", []).filter((r) => r.id !== rec.id)].slice(0, MAX_LOCAL_HISTORY);
  // Si se llena el almacenamiento del navegador, se descartan los más antiguos
  while (items.length && !LS.set("history", items)) items = items.slice(0, -1);
}

function historySummary(rec) {
  return {
    id: rec.id,
    fecha: rec.fecha_analisis,
    titulo: rec.article.title || rec.result.titulo_inferido || "Sin título",
    fuente: outletName(rec.article.source || ""),
    nota: (rec.result.puntuacion || {}).nota,
  };
}

async function loadHistory() {
  const list = $("#historyList");
  const items = isPublic()
    ? LS.get("history", []).map(historySummary)
    : await fetch("/api/history").then((r) => r.json()).catch(() => []);
  if (!items.length) { list.innerHTML = `<li class="muted">Todavía no hay análisis.</li>`; return; }
  [...compareSel].forEach((id) => { if (!items.some((h) => h.id === id)) compareSel.delete(id); });
  list.innerHTML = items.map((h) => `<li data-id="${esc(h.id)}">
    <input type="checkbox" class="cmp-check" data-cmp="${esc(h.id)}" title="Marcar para comparar" ${compareSel.has(h.id) ? "checked" : ""}>
    <span class="hn" style="color:${scoreColor(h.nota)}">${fmt(h.nota)}</span>
    <span><div class="ht">${esc(h.titulo)}</div><div class="hs">${esc(h.fuente)} · ${esc(new Date(h.fecha).toLocaleDateString("es-ES"))}</div></span>
    <button class="del" title="Borrar" data-del="${esc(h.id)}">🗑</button></li>`).join("");
  updateCompareBar();
  $$("[data-cmp]", list).forEach((c) => c.addEventListener("change", () => {
    if (c.checked) {
      if (compareSel.size >= 2) { c.checked = false; return; }
      compareSel.add(c.dataset.cmp);
    } else compareSel.delete(c.dataset.cmp);
    updateCompareBar();
  }));
  $$("li[data-id]", list).forEach((li) => li.addEventListener("click", (e) => {
    if (e.target.dataset.del || e.target.dataset.cmp) return;
    loadHistoryItem(li.dataset.id);
    toggleDrawer(false);
  }));
  $$("[data-del]", list).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Borrar este análisis del historial?")) return;
    if (isPublic()) LS.set("history", LS.get("history", []).filter((r) => r.id !== b.dataset.del));
    else await fetch(`/api/history/${b.dataset.del}`, { method: "DELETE" });
    loadHistory();
  }));
}

async function loadHistoryItem(id) {
  try {
    const rec = isPublic() ? LS.get("history", []).find((r) => r.id === id) : await api(`/api/history/${id}`);
    if (!rec) return;
    render(rec);
    history.replaceState(null, "", `#a=${id}`);
  } catch (e) { showError(e.message); }
}

init();

// Resalta la tarjeta de modelo elegida en Ajustes
$("#modelList").addEventListener("change", () => {
  $$(".model-card", $("#modelList")).forEach((c) => c.classList.toggle("selected", c.querySelector("input").checked));
});
