"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const VERDICTS = ["Correcto", "Mayormente correcto", "Parcialmente correcto", "Engañoso", "Incorrecto", "No verificable", "Opinión"];
const VERDICT_COLOR = {
  "Correcto": "var(--ok)", "Mayormente correcto": "var(--ok-2)", "Parcialmente correcto": "var(--mid)",
  "Engañoso": "var(--warn)", "Incorrecto": "var(--bad)", "No verificable": "var(--na)", "Opinión": "var(--op)",
};

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
function modelOptions(selected) {
  const list = [...cfg.models];
  if (selected && !list.some((m) => m.id === selected)) list.unshift({ id: selected, name: selected, price: "", note: "modelo personalizado" });
  return list.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.name)}${m.price ? ` · ${esc(m.price)}` : ""} — ${esc(m.note)}</option>`).join("");
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
  $("#credit").textContent = `${c.credit} · ${c.year} · v${c.version}`;
  $("#keyStorageNote").textContent = c.public
    ? "Se guarda solo en este navegador y se envía a OpenRouter con cada análisis; nunca se almacena en el servidor."
    : "Se guarda solo en este ordenador (data/settings.json).";
  $("#pdfLimit").textContent = `máx. ${c.max_pdf_mb} MB`;
}

async function init() {
  try {
    applyConfig(await api("/api/config"));
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
  $("#setModel").innerHTML = modelOptions(cfg.default_model);
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
    default_model: $("#customModel").value.trim() || $("#setModel").value,
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
$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  const fd = new FormData();
  if (mode === "url") {
    const url = $("#url").value.trim();
    if (!url) return showError("Pega la dirección del artículo.");
    fd.append("url", url);
  } else if (mode === "text") {
    const text = $("#pasted").value.trim();
    if (text.length < 300) return showError("Pega el texto completo del artículo (mínimo unos 300 caracteres).");
    fd.append("text", text);
    fd.append("title", $("#pastedTitle").value.trim());
    fd.append("url", $("#pastedUrl").value.trim());
  } else {
    if (!pdfFile) return showError("Elige un archivo PDF.");
    if (cfg && pdfFile.size > cfg.max_pdf_mb * 1048576) {
      return showError(`El PDF pesa ${fmt(pdfFile.size / 1048576)} MB y el máximo es ${cfg.max_pdf_mb} MB. Usa «Pegar texto» con el contenido del artículo.`);
    }
    fd.append("file", pdfFile);
  }
  if (cfg && !cfg.has_key) { openSettings(); return showError("Añade tu clave de OpenRouter en Ajustes para poder analizar."); }

  setBusy(true);
  $("#results").classList.add("hidden");
  step("extract");
  let timerId;
  try {
    const ext = await api("/api/extract", { method: "POST", body: fd });
    step("metrics");
    await new Promise((r) => setTimeout(r, 250));
    step("ai");
    const t0 = Date.now();
    timerId = setInterval(() => { $("#timer").textContent = `· ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    const rec = await api("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...keyHeaders() },
      body: JSON.stringify({ article: ext.article, metrics: ext.metrics, model: $("#model").value,
        web_search: $("#web").checked, web_results: cfg.web_results }),
    });
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
        <div class="kicker"><span class="chip navy">${esc(r.tipo_texto || "Artículo")}</span><span class="chip">${esc(m.idioma)} · ${fmt(m.palabras, 0)} palabras · ${m.minutos_lectura} min</span></div>
        <h2>${esc(title)}</h2>
        <div class="byline">${byline}</div>
        ${m.posible_texto_parcial ? `<p class="warn" style="margin:0 0 14px">Solo se han podido leer ${fmt(m.palabras, 0)} palabras. Si el artículo es de pago o está incompleto, cópialo desde el navegador en «Pegar texto» o súbelo en PDF para un análisis completo.</p>` : ""}
        ${safeUrl(a.archived_from) ? `<p class="source-note">La web original bloqueó la descarga; se ha leído la <a href="${esc(a.archived_from)}" target="_blank" rel="noopener">copia guardada en archive.org</a>.</p>` : ""}
        <p class="summary">${esc(r.resumen)}</p>
        <div class="thesis"><b>Tesis del autor:</b> ${esc(r.tesis)}</div>
      </div>
      <div class="score">${dial(p.nota)}<div class="label" style="color:${scoreColor(p.nota)}">${esc(p.etiqueta || "")}</div>
        ${p.limite ? `<div class="cap">${esc(p.limite)}</div>` : ""}</div>
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
  window.scrollTo({ top: 0 });
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

function sectionVerificacion(r) {
  const items = r.verificacion || [];
  if (!items.length) return section("s-verif", 2, "Contraste de los datos", "", `<p class="empty">No hay afirmaciones verificables relevantes.</p>`);
  return section("s-verif", 2, "Contraste de los datos",
    "Datos externos que confirman o refutan lo que afirma el artículo.",
    `${distribution(items)}<div class="claims">${items.map((c) => {
      const links = (c.fuentes || []).filter((f) => safeUrl(f.url));
      return `<div class="claim" style="--vc:${VERDICT_COLOR[c.veredicto] || "var(--na)"}">
        <div class="claim-top"><div class="claim-q">${esc(c.afirmacion)}</div>${verdict(c.veredicto)}</div>
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
    "Cada idea va seguida de su calificación.",
    `${distribution(all)}<ol class="ideas">${ideas.map((i) => `<li>
      <div class="idea-text">${esc(i.idea)}</div>${rating(i)}
      ${(i.secundarias || []).length ? `<ul class="secondary">${i.secundarias.map((s) => `<li><div class="idea-text"><span class="tag">Secundaria</span>${esc(s.idea)}</div>${rating(s)}</li>`).join("")}</ul>` : ""}
    </li>`).join("")}</ol>`);
}

function sectionRigor(r) {
  const fal = r.falacias_y_sesgos || [];
  const om = r.omisiones || [];
  const pp = r.perspectivas || {};
  return section("s-rigor", 4, "Rigor argumental y contexto", "Falacias, sesgos, omisiones y pluralidad de puntos de vista.",
    `<div class="grid2">
      <div class="box"><h4>Falacias y sesgos detectados (${fal.length})</h4>
        ${fal.length ? fal.map((f) => `<div class="fallacy"><b>${esc(f.tipo)}</b><q>“${esc(f.fragmento)}”</q><span class="muted small">${esc(f.explicacion)}</span></div>`).join("") : `<p class="empty">No se detectan falacias relevantes.</p>`}
      </div>
      <div>
        <div class="box"><h4>Contexto omitido (${om.length})</h4>
          ${om.length ? `<ul class="plain">${om.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : `<p class="empty">Sin omisiones relevantes.</p>`}</div>
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
    "Medidas calculadas automáticamente sobre el texto, sin intervención de la IA.",
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

function sectionValoracion(r, p) {
  const meta = r._meta || {};
  const webs = meta.fuentes_web || [];
  return section("s-val", 6, `Valoración final: ${fmt(p.nota)} / 10`,
    "Media ponderada de siete criterios. La exactitud se calcula a partir de los veredictos de la sección 2.",
    `<div class="rubric">${(p.desglose || []).map((c) => `<div>
      <div class="crit-top"><span class="crit-name">${esc(c.nombre)}<small>peso ${Math.round(c.peso * 100)} %</small></span><span class="crit-val">${fmt(c.puntuacion)}</span></div>
      <div class="bar"><span style="width:${c.puntuacion * 10}%;background:${scoreColor(c.puntuacion)}"></span></div>
      <div class="crit-just">${esc(c.justificacion)}</div>
      ${c.origen !== "Evaluación del modelo" ? `<div class="crit-origin">${esc(c.origen)}</div>` : ""}
    </div>`).join("")}</div>
    ${p.limite ? `<p class="warn">${esc(p.limite)} Nota sin límite: ${fmt(p.nota_sin_limite)}.</p>` : ""}
    <div class="grid2">
      <div class="box"><h4>Fortalezas</h4><ul class="plain">${(r.fortalezas || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
      <div class="box"><h4>Debilidades</h4><ul class="plain">${(r.debilidades || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
    </div>
    <div class="verdict-box"><h4>Valoración global</h4><p>${esc(r.valoracion_global)}</p></div>
    <div class="meta-line">Modelo: ${esc(meta.modelo)} · Búsqueda web: ${meta.busqueda_web ? "sí" : "no"}
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
  L.push(`**Nota: ${p.nota}/10 — ${p.etiqueta}**  `, `Tipo: ${r.tipo_texto}`, "", `> ${r.resumen}`, "", `**Tesis:** ${r.tesis}`, "");
  L.push("## Texto original del artículo", "");
  if (a.url) L.push(`Fuente: ${a.url}${a.archived_from ? ` (leído desde ${a.archived_from})` : ""}`, "");
  String(a.text || "").split(/\n+/).map((p) => p.trim()).filter(Boolean).forEach((p) => L.push(`> ${p}`, ">"));
  L.push("");
  L.push("## 1. Datos en los que se apoya el autor", "");
  (r.datos_del_autor || []).forEach((d) => L.push(`- ${d.dato} — *Fuente:* ${d.fuente_citada} (${d.tipo_fuente})`));
  L.push("", "## 2. Contraste de los datos", "");
  (r.verificacion || []).forEach((c) => {
    L.push(`- **${c.afirmacion}** → **${c.veredicto}**`, `  ${c.evidencia}`);
    (c.fuentes || []).filter((f) => f.url).forEach((f) => L.push(`  - [${f.titulo}](${f.url})`));
  });
  L.push("", "## 3. Ideas principales y secundarias", "");
  (r.ideas_principales || []).forEach((i, n) => {
    L.push(`${n + 1}. ${i.idea} → **${i.veredicto}**: ${i.justificacion}`);
    (i.secundarias || []).forEach((s) => L.push(`   - ${s.idea} → **${s.veredicto}**: ${s.justificacion}`));
  });
  L.push("", "## 4. Rigor", "");
  (r.falacias_y_sesgos || []).forEach((f) => L.push(`- **${f.tipo}**: “${f.fragmento}” — ${f.explicacion}`));
  (r.omisiones || []).forEach((o) => L.push(`- Omisión: ${o}`));
  L.push("", "## 5. Valoración", "", "| Criterio | Peso | Nota |", "|---|---|---|");
  (p.desglose || []).forEach((c) => L.push(`| ${c.nombre} | ${Math.round(c.peso * 100)} % | ${c.puntuacion} |`));
  if (p.limite) L.push("", `*${p.limite}*`);
  L.push("", `**Nota final: ${p.nota}/10**`, "", r.valoracion_global, "");
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
  list.innerHTML = items.map((h) => `<li data-id="${esc(h.id)}">
    <span class="hn" style="color:${scoreColor(h.nota)}">${fmt(h.nota)}</span>
    <span><div class="ht">${esc(h.titulo)}</div><div class="hs">${esc(h.fuente)} · ${esc(new Date(h.fecha).toLocaleDateString("es-ES"))}</div></span>
    <button class="del" title="Borrar" data-del="${esc(h.id)}">🗑</button></li>`).join("");
  $$("li[data-id]", list).forEach((li) => li.addEventListener("click", (e) => {
    if (e.target.dataset.del) return;
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
