/* Kundendatenbank Schulungen – App-Logik
 * Daten: Supabase (Postgres) mit Echtzeit-Abgleich zwischen allen Geräten.
 * Ohne Netz: letzte Lesekopie aus dem Gerätespeicher (nur ansehen, nicht ändern).
 */
(() => {
"use strict";

const SCHULUNGSARTEN = [
  "Unterweisung nach Kap. 1.3 ADR/RID",
  "ADR-Fahrerschulung Basiskurs",
  "ADR-Fahrerschulung Aufbaukurs Tank",
  "ADR-Fahrerschulung Auffrischung",
  "Gefahrgutbeauftragter Fortbildung",
  "IATA-DGR Luftfracht",
  "IMDG-Code Seeverkehr",
  "Ladungssicherung",
  "Betriebsbegehung / Audit",
  "Beratung"
];
const ITEMS = {bericht:"Bericht", bescheinigung:"Bescheinigungen", rechnung:"Rechnung", zahlung:"Zahlung"};
const UEBERFAELLIG_TAGE = 14;
const SNAP_KEY = "kdb_snapshot_v1";
const CFG_KEY = "kdb_config_v1";

let sb = null, channel = null;
let session = null;
let kunden = new Map(), termine = new Map();
let loaded = false, offlineMode = false, liveState = "wait";
let view = "todos";
let openDialog = null; // {type, id, stamp}
const ui = {todoFilter:null, q:"", kunde:"", status:"alle", kq:""};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
const fmtDate = iso => { if(!iso) return "–"; const [y,m,d] = String(iso).slice(0,10).split("-"); return `${d}.${m}.${y}`; };
const daysSince = iso => iso ? Math.round((new Date(todayISO()) - new Date(String(iso).slice(0,10))) / 864e5) : 0;
const fmtEur = v => (v === "" || v == null || isNaN(+v)) ? "" : (+v).toLocaleString("de-DE",{style:"currency",currency:"EUR"});
const kName = id => kunden.get(id)?.name || "Unbekannter Kunde";
const stOf = (t,k) => t?.[k]?.st || "offen";
const canWrite = () => !offlineMode && !!session;

/* ---------- Umwandlung Datenbankzeile <-> App-Modell ---------- */
const nz = v => (v === "" || v == null) ? null : v;
const nint = v => (v === "" || v == null || isNaN(parseInt(v,10))) ? null : parseInt(v,10);
const nnum = v => (v === "" || v == null || isNaN(parseFloat(String(v).replace(",", ".")))) ? null : parseFloat(String(v).replace(",", "."));

function rowToKunde(r){ return {id:r.id, name:r.name, ansprechpartner:r.ansprechpartner||"", telefon:r.telefon||"", email:r.email||"",
  kundennr:r.kundennr||"", strasse:r.strasse||"", ort:r.ort||"", notizen:r.notizen||"", stamp:r.geaendert_am}; }
function kundeToRow(k){ return {name:k.name, ansprechpartner:k.ansprechpartner||"", telefon:k.telefon||"", email:k.email||"",
  kundennr:k.kundennr||"", strasse:k.strasse||"", ort:k.ort||"", notizen:k.notizen||""}; }
function rowToTermin(r){ return {
  id:r.id, kundeId:r.kunde_id, datum:r.datum||"", uhrzeit:r.uhrzeit||"", ort:r.ort||"", teilnehmer:r.teilnehmer ?? "",
  schulungsart:r.schulungsart||"", status:r.status||"geplant", notizen:r.notizen||"",
  bericht:{st:r.bericht_status||"offen", datum:r.bericht_datum||"", info:r.bericht_info||""},
  bescheinigung:{st:r.besch_status||"offen", datum:r.besch_datum||"", anzahl:r.besch_anzahl ?? "", info:r.besch_info||""},
  rechnung:{st:r.rechnung_status||"offen", datum:r.rechnung_datum||"", nummer:r.rechnung_nr||"", betrag:r.rechnung_betrag ?? "", bezahltAm:r.bezahlt_am||""},
  stamp:r.geaendert_am }; }
function terminToRow(t){ return {
  kunde_id:t.kundeId, datum:t.datum, uhrzeit:t.uhrzeit||"", ort:t.ort||"", teilnehmer:nint(t.teilnehmer),
  schulungsart:t.schulungsart||"", status:t.status||"geplant", notizen:t.notizen||"",
  bericht_status:t.bericht.st, bericht_datum:nz(t.bericht.datum), bericht_info:t.bericht.info||"",
  besch_status:t.bescheinigung.st, besch_datum:nz(t.bescheinigung.datum), besch_anzahl:nint(t.bescheinigung.anzahl), besch_info:t.bescheinigung.info||"",
  rechnung_status:t.rechnung.st, rechnung_datum:nz(t.rechnung.datum), rechnung_nr:t.rechnung.nummer||"", rechnung_betrag:nnum(t.rechnung.betrag), bezahlt_am:nz(t.rechnung.bezahltAm) }; }

/* ---------- Fachlogik ---------- */
function todosFor(t){
  if(!t || t.status === "abgesagt") return [];
  const faellig = t.status === "durchgefuehrt" || (t.datum && t.datum <= todayISO());
  if(!faellig) return [];
  const out = [];
  for(const k of ["bericht","bescheinigung","rechnung"]) if(stOf(t,k) === "offen") out.push(k);
  if(stOf(t,"rechnung") === "erledigt" && !t.rechnung?.bezahltAm) out.push("zahlung");
  return out;
}
const isOver = t => daysSince(t.datum) > UEBERFAELLIG_TAGE;

/* ---------- Hilfen ---------- */
function toast(msg){ const el = document.createElement("div"); el.className = "toast"; el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 2800); }
function setStatus(html, bad){ $("#status").innerHTML = html ? `<div class="note ${bad?"bad":""}">${html}</div>` : ""; }
function setLive(state){
  liveState = state;
  const dot = $("#syncDot"), txt = $("#syncText");
  dot.className = "dot " + ({live:"live", wait:"wait", off:"off"}[state] || "");
  txt.textContent = {live:"Live synchronisiert", wait:"Verbinde …", off:"Offline – nur Lesen"}[state] || "";
}
function show(id){ for(const s of ["setup","login","newpw","app"]) $("#"+s).hidden = s !== id; }
function errText(e){
  const m = (e?.message || "").toLowerCase();
  if(m.includes("failed to fetch") || m.includes("network")) return "Keine Verbindung. Bitte Internet prüfen.";
  if(m.includes("foreign key")) return "Dieser Kunde hat noch Termine. Bitte diese zuerst löschen.";
  if(m.includes("jwt") || m.includes("auth")) return "Ihre Anmeldung ist abgelaufen. Bitte neu anmelden.";
  return "Speichern fehlgeschlagen: " + (e?.message || "unbekannter Fehler");
}
function saveSnapshot(){
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({at:new Date().toISOString(), kunden:[...kunden.values()], termine:[...termine.values()]})); } catch(e){}
}
function loadSnapshot(){
  try { const s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); if(!s) return null;
    kunden = new Map(s.kunden.map(k => [k.id,k])); termine = new Map(s.termine.map(t => [t.id,t])); return s.at; } catch(e){ return null; }
}

/* ---------- Routing ---------- */
function setView(v, push=true){
  view = ["todos","termine","kunden"].includes(v) ? v : "todos";
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.view === view));
  if(push && location.hash !== "#"+view) history.replaceState(null, "", "#"+view);
  render();
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
window.addEventListener("hashchange", () => setView(location.hash.slice(1), false));

/* ---------- Darstellung ---------- */
function render(){
  const tList = [...termine.values()];
  $("#cntTodos").textContent = tList.reduce((n,t) => n + todosFor(t).length, 0);
  $("#cntTermine").textContent = tList.length;
  $("#cntKunden").textContent = kunden.size;
  $("#btnNewKunde").hidden = !canWrite(); $("#btnNewTermin").hidden = !canWrite();
  if(!loaded) return;
  const v = $("#view");
  const y = window.scrollY;
  if(view === "todos") v.innerHTML = renderTodos(tList);
  else if(view === "termine") v.innerHTML = renderTermine(tList);
  else v.innerHTML = renderKunden(tList);
  bindView();
  window.scrollTo(0, y);
}

function todoChip(t,k){
  const over = isOver(t);
  return `<span class="todo ${over?"over":""}">${ITEMS[k]}${over?" überfällig":""}${canWrite()?` <button type="button" data-done="${esc(t.id)}" data-k="${k}" title="Als erledigt markieren (heute)" aria-label="${ITEMS[k]} erledigt">✓</button>`:""}</span>`;
}

function renderTodos(tList){
  if(!kunden.size && !tList.length) return `<div class="empty"><strong>Noch keine Kunden angelegt</strong>Legen Sie über „+ Kunde“ den ersten Kunden an und tragen Sie dann mit „+ Termin“ die Schulungstermine ein.</div>`;
  const counts = {bericht:[0,0], bescheinigung:[0,0], rechnung:[0,0], zahlung:[0,0]};
  tList.forEach(t => todosFor(t).forEach(k => { counts[k][0]++; if(isOver(t)) counts[k][1]++; }));
  const stats = Object.keys(ITEMS).map(k => `
    <button type="button" class="stat" data-filter="${k}" aria-pressed="${ui.todoFilter===k}">
      <span class="n">${counts[k][0]}</span>
      <span class="l">${k==="zahlung"?"Zahlungseingänge offen":ITEMS[k]+" offen"}</span>
      <span class="od">${counts[k][1] ? counts[k][1]+" überfällig (> "+UEBERFAELLIG_TAGE+" Tage)" : "&nbsp;"}</span>
    </button>`).join("");

  const byK = new Map();
  tList.forEach(t => {
    let td = todosFor(t);
    if(ui.todoFilter) td = td.filter(k => k === ui.todoFilter);
    if(!td.length) return;
    if(!byK.has(t.kundeId)) byK.set(t.kundeId, []);
    byK.get(t.kundeId).push({t, td});
  });
  const groups = [...byK.entries()].sort((a,b) => kName(a[0]).localeCompare(kName(b[0]),"de")).map(([kid, rows]) => {
    rows.sort((a,b) => (a.t.datum||"").localeCompare(b.t.datum||""));
    const n = rows.reduce((s,r) => s + r.td.length, 0);
    return `<section class="group">
      <div class="group-h"><button class="link" type="button" data-kunde="${esc(kid)}">${esc(kName(kid))}</button><span class="chip c-offen">${n} offen</span></div>
      ${rows.map(({t,td}) => `<div class="trow">
        <div class="when">${fmtDate(t.datum)}<small>${daysSince(t.datum)===0?"heute":"vor "+daysSince(t.datum)+" Tagen"}</small></div>
        <div class="what"><button class="link" type="button" data-termin="${esc(t.id)}"><b>${esc(t.schulungsart||"Termin")}</b></button><br><span>${esc([t.ort, t.teilnehmer!==""?t.teilnehmer+" TN":""].filter(Boolean).join(" · "))}</span></div>
        <div class="todos">${td.map(k => todoChip(t,k)).join("")}</div>
      </div>`).join("")}
    </section>`;
  }).join("");

  const today = todayISO();
  const limD = new Date(); limD.setDate(limD.getDate()+60);
  const lim = new Date(limD.getTime() - limD.getTimezoneOffset()*60000).toISOString().slice(0,10);
  const next = tList.filter(t => t.status !== "abgesagt" && t.status !== "durchgefuehrt" && t.datum > today && t.datum <= lim).sort((a,b) => a.datum.localeCompare(b.datum));
  const upcoming = next.length ? `<div class="klist">${next.map(t => `<div class="trow" data-termin="${esc(t.id)}">
      <div class="when">${fmtDate(t.datum)}<small>${t.uhrzeit?esc(t.uhrzeit)+" Uhr":"in "+(-daysSince(t.datum))+" Tagen"}</small></div>
      <div class="what"><b>${esc(kName(t.kundeId))}</b><br><span>${esc(t.schulungsart||"")}${t.ort?" · "+esc(t.ort):""}</span></div>
      <div class="todos"><span class="chip c-geplant">geplant</span></div></div>`).join("")}</div>`
    : `<div class="empty">In den nächsten 60 Tagen sind keine Termine geplant.</div>`;

  return `<div class="stats">${stats}</div>
    <div class="sec-h"><h2>${ui.todoFilter ? ITEMS[ui.todoFilter]+": offen je Kunde" : "Offen je Kunde und Termin"}</h2><p>Fällig ab Termindatum · rot = älter als ${UEBERFAELLIG_TAGE} Tage · ✓ setzt erledigt mit heutigem Datum</p></div>
    ${groups || `<div class="empty"><strong>Alles erledigt</strong>${ui.todoFilter?"Für diesen Filter gibt es keine offenen Punkte.":"Zu vergangenen Terminen ist nichts mehr offen."}</div>`}
    <div class="sec-h"><h2>Anstehende Termine</h2><p>nächste 60 Tage</p></div>${upcoming}`;
}

function itemChip(t,k){
  const st = stOf(t,k);
  if(st === "erledigt"){
    const d = t[k]?.datum ? fmtDate(t[k].datum) : "erledigt";
    if(k === "rechnung"){
      const paid = t.rechnung?.bezahltAm;
      return `<span class="chip c-erledigt">${d}</span><span class="sub">${esc(t.rechnung?.nummer||"")} ${fmtEur(t.rechnung?.betrag)}${paid?" · bezahlt":" · Zahlung offen"}</span>`;
    }
    return `<span class="chip c-erledigt">${d}</span>${k==="bescheinigung"&&t.bescheinigung?.anzahl!==""?`<span class="sub">${esc(t.bescheinigung.anzahl)} Stück</span>`:""}`;
  }
  if(st === "entfaellt") return `<span class="chip c-entfaellt">entfällt</span>`;
  if(todosFor(t).includes(k)) return `<span class="chip ${isOver(t)?"c-over":"c-offen"}">offen</span>`;
  return `<span class="chip c-geplant">noch nicht fällig</span>`;
}
function terminStatusChip(t){
  if(t.status === "abgesagt") return `<span class="chip c-abgesagt">abgesagt</span>`;
  const n = todosFor(t).length;
  if(t.status === "durchgefuehrt" || (t.datum && t.datum <= todayISO())) return n ? `<span class="chip c-offen">${n} offen</span>` : `<span class="chip c-erledigt">abgeschlossen</span>`;
  return `<span class="chip c-geplant">geplant</span>`;
}

function renderTermine(tList){
  const q = ui.q.trim().toLowerCase();
  const today = todayISO();
  const rows = tList.filter(t => {
    if(ui.kunde && t.kundeId !== ui.kunde) return false;
    const open = todosFor(t).length > 0;
    const past = t.status === "durchgefuehrt" || t.datum <= today;
    if(ui.status === "offen" && !open) return false;
    if(ui.status === "abgeschlossen" && (open || t.status === "abgesagt" || !past)) return false;
    if(ui.status === "geplant" && (t.status === "abgesagt" || past)) return false;
    if(ui.status === "abgesagt" && t.status !== "abgesagt") return false;
    if(q){ const hay = [kName(t.kundeId), t.schulungsart, t.ort, t.notizen, t.rechnung?.nummer].join(" ").toLowerCase(); if(!hay.includes(q)) return false; }
    return true;
  }).sort((a,b) => (b.datum||"").localeCompare(a.datum||""));
  const kOpts = [...kunden.values()].sort((a,b)=>a.name.localeCompare(b.name,"de")).map(k => `<option value="${esc(k.id)}" ${ui.kunde===k.id?"selected":""}>${esc(k.name)}</option>`).join("");
  const filters = `<div class="filters">
    <input type="search" id="fq" placeholder="Suchen: Kunde, Schulungsart, Ort, Rechnungs-Nr." value="${esc(ui.q)}" aria-label="Termine durchsuchen">
    <select id="fk" aria-label="Kunde"><option value="">Alle Kunden</option>${kOpts}</select>
    <select id="fs" aria-label="Status">${[["alle","Alle Termine"],["offen","Mit offenen ToDos"],["abgeschlossen","Abgeschlossen"],["geplant","Geplant"],["abgesagt","Abgesagt"]].map(([v,l])=>`<option value="${v}" ${ui.status===v?"selected":""}>${l}</option>`).join("")}</select>
  </div>`;
  if(!tList.length) return filters + `<div class="empty"><strong>Noch keine Termine</strong>Mit „+ Termin“ legen Sie den ersten Schulungstermin an.</div>`;
  return filters + `<div class="tablebox"><table>
    <thead><tr><th>Datum</th><th>Kunde</th><th>Schulungsart</th><th>TN</th><th>Status</th><th>Bericht</th><th>Bescheinigungen</th><th>Rechnung</th></tr></thead>
    <tbody>${rows.map(t => `<tr data-termin="${esc(t.id)}" tabindex="0">
      <td class="num">${fmtDate(t.datum)}${t.uhrzeit?`<span class="sub">${esc(t.uhrzeit)} Uhr</span>`:""}</td>
      <td>${esc(kName(t.kundeId))}${t.ort?`<span class="sub">${esc(t.ort)}</span>`:""}</td>
      <td>${esc(t.schulungsart||"–")}</td>
      <td class="num">${t.teilnehmer!==""?esc(t.teilnehmer):"–"}</td>
      <td>${terminStatusChip(t)}</td>
      <td>${itemChip(t,"bericht")}</td>
      <td>${itemChip(t,"bescheinigung")}</td>
      <td>${itemChip(t,"rechnung")}</td>
    </tr>`).join("") || `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">Keine Termine für diese Filter.</td></tr>`}</tbody>
  </table></div>`;
}

function renderKunden(tList){
  const q = ui.kq.trim().toLowerCase();
  const list = [...kunden.values()].filter(k => !q || [k.name,k.ansprechpartner,k.ort,k.email,k.kundennr].join(" ").toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name,"de"));
  const filters = `<div class="filters"><input type="search" id="fkq" placeholder="Kunden suchen" value="${esc(ui.kq)}" aria-label="Kunden durchsuchen"></div>`;
  if(!kunden.size) return filters + `<div class="empty"><strong>Noch keine Kunden</strong>Mit „+ Kunde“ legen Sie den ersten Kunden mit Ansprechpartner und Kontaktdaten an.</div>`;
  const today = todayISO();
  return filters + `<div class="cards">${list.map(k => {
    const ts = tList.filter(t => t.kundeId === k.id);
    const open = ts.reduce((n,t)=>n+todosFor(t).length,0);
    const next = ts.filter(t => t.datum > today && t.status !== "abgesagt").sort((a,b)=>a.datum.localeCompare(b.datum))[0];
    return `<button type="button" class="kcard" data-kunde="${esc(k.id)}">
      <h3>${esc(k.name)}</h3>
      <div class="meta">${k.ansprechpartner?`<span>${esc(k.ansprechpartner)}</span>`:""}${k.telefon?`<span class="mono">${esc(k.telefon)}</span>`:""}${k.email?`<span>${esc(k.email)}</span>`:""}${k.ort?`<span>${esc(k.ort)}</span>`:""}</div>
      <div class="foot"><span class="chip c-geplant">${ts.length} Termin${ts.length===1?"":"e"}</span>${open?`<span class="chip c-offen">${open} ToDo${open===1?"":"s"} offen</span>`:`<span class="chip c-erledigt">nichts offen</span>`}${next?`<span class="chip c-geplant">nächster: ${fmtDate(next.datum)}</span>`:""}</div>
    </button>`;}).join("")}</div>`;
}

function bindView(){
  const v = $("#view");
  v.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { ui.todoFilter = ui.todoFilter === b.dataset.filter ? null : b.dataset.filter; render(); });
  v.querySelectorAll("[data-done]").forEach(b => b.onclick = e => { e.stopPropagation(); quickDone(b.dataset.done, b.dataset.k, b); });
  v.querySelectorAll("[data-termin]").forEach(el => {
    el.onclick = () => openTermin(el.dataset.termin);
    el.onkeydown = e => { if(e.key === "Enter" && el.tagName === "TR") openTermin(el.dataset.termin); };
  });
  v.querySelectorAll("[data-kunde]").forEach(el => el.onclick = () => openKunde(el.dataset.kunde));
  const keepFocus = (id, key) => { const el = $("#"+id); if(!el) return; el.oninput = () => { ui[key] = el.value; const p = el.selectionStart; render(); const n = $("#"+id); n.focus(); try{ n.setSelectionRange(p,p); }catch(e){} }; };
  keepFocus("fq","q"); keepFocus("fkq","kq");
  const fk = $("#fk"); if(fk) fk.onchange = () => { ui.kunde = fk.value; render(); };
  const fs = $("#fs"); if(fs) fs.onchange = () => { ui.status = fs.value; render(); };
}

/* ---------- Schreiben ---------- */
function applyKunde(row){ kunden.set(row.id, rowToKunde(row)); }
function applyTermin(row){ termine.set(row.id, rowToTermin(row)); }

async function quickDone(id, k, btn){
  const t = termine.get(id); if(!t || !canWrite()) return;
  btn.disabled = true;
  const patch = {};
  if(k === "zahlung") patch.bezahlt_am = todayISO();
  else {
    const col = {bericht:"bericht", bescheinigung:"besch", rechnung:"rechnung"}[k];
    patch[col+"_status"] = "erledigt";
    if(!t[k]?.datum) patch[col+"_datum"] = todayISO();
  }
  if(t.status === "geplant" && t.datum <= todayISO()) patch.status = "durchgefuehrt";
  const {data, error} = await sb.from("termine").update(patch).eq("id", id).select();
  if(error){ toast(errText(error)); btn.disabled = false; return; }
  if(data?.[0]) applyTermin(data[0]);
  saveSnapshot(); render();
  toast(`${ITEMS[k]} als erledigt markiert`);
}

// Speichern mit Konfliktprüfung: schlägt fehl, wenn der Datensatz inzwischen auf einem anderen Gerät geändert wurde.
async function saveRow(table, id, row, stamp, force){
  if(!id){
    const {data, error} = await sb.from(table).insert(row).select();
    return {error, row: data?.[0]};
  }
  let q = sb.from(table).update(row).eq("id", id);
  if(stamp && !force) q = q.eq("geaendert_am", stamp);
  const {data, error} = await q.select();
  if(error) return {error};
  if(!data || !data.length) return {conflict:true};
  return {row: data[0]};
}

function showConflict(onForce, onReload){
  const box = $("#conflictBox"); if(!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="note bad conflict"><b>Dieser Datensatz wurde inzwischen auf einem anderen Gerät geändert.</b>
    <span>Sie können Ihre Eingaben trotzdem speichern (die andere Änderung wird überschrieben) oder die aktuelle Fassung laden (Ihre Eingaben gehen verloren).</span>
    <div class="row"><button class="btn small danger" type="button" id="cfForce">Meine Fassung speichern</button><button class="btn small" type="button" id="cfReload">Aktuelle Fassung laden</button></div></div>`;
  $("#cfForce").onclick = onForce; $("#cfReload").onclick = onReload;
  box.scrollIntoView({block:"nearest"});
}

/* ---------- Dialoge ---------- */
function closeModal(){ $("#modalRoot").innerHTML = ""; openDialog = null; document.removeEventListener("keydown", escClose); }
function escClose(e){ if(e.key === "Escape") closeModal(); }
function showModal(html){
  $("#modalRoot").innerHTML = `<div class="overlay" id="ov"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#ov").addEventListener("mousedown", e => { if(e.target.id === "ov") closeModal(); });
  $("#modalRoot").querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  document.addEventListener("keydown", escClose);
  if(window.matchMedia("(hover:hover)").matches){ const first = $("#modalRoot").querySelector("input,select,textarea"); if(first) first.focus(); }
}
const field = (id,label,val,type="text",attrs="",wide=false) => `<div class="field ${wide?"wide":""}"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val??"")}" ${attrs} ${canWrite()?"":"disabled"}></div>`;
const seg = (k, st) => `<span class="seg" data-seg="${k}">${[["offen","offen"],["erledigt","erledigt"],["entfaellt","entfällt"]].map(([v,l]) => `<button type="button" data-v="${v}" aria-pressed="${st===v}" ${canWrite()?"":"disabled"}>${l}</button>`).join("")}</span>`;

function notifyRemoteChange(type, id){
  if(openDialog && openDialog.type === type && openDialog.id === id){
    const n = $("#remoteNote"); if(n) n.hidden = false;
  }
}

function openTermin(id, presetKunde){
  const isNew = !id;
  if(isNew && !kunden.size){ toast("Bitte zuerst einen Kunden anlegen"); openKunde(null); return; }
  const t = isNew ? {kundeId: presetKunde || ui.kunde || "", datum: todayISO(), status:"geplant", teilnehmer:"",
      bericht:{st:"offen"}, bescheinigung:{st:"offen", anzahl:""}, rechnung:{st:"offen", betrag:""}} : termine.get(id);
  if(!t) return;
  openDialog = {type:"termin", id, stamp: t.stamp};
  const kOpts = [...kunden.values()].sort((a,b)=>a.name.localeCompare(b.name,"de")).map(k => `<option value="${esc(k.id)}" ${t.kundeId===k.id?"selected":""}>${esc(k.name)}</option>`).join("");
  const dis = canWrite() ? "" : "disabled";
  showModal(`
    <div class="modal-h"><h2>${isNew?"Neuer Termin":"Termin bearbeiten"}</h2><button class="x" type="button" data-close aria-label="Schließen">×</button></div>
    <form id="tf" class="modal-b" onsubmit="return false">
      <div class="note" id="remoteNote" hidden>Dieser Termin wurde gerade auf einem anderen Gerät geändert. Beim Speichern werden Sie gefragt, welche Fassung gilt.</div>
      <div id="conflictBox" hidden></div>
      <div class="grid">
        <div class="field wide"><label for="t_kunde">Kunde</label><select id="t_kunde" required ${dis}><option value="">Kunde wählen …</option>${kOpts}</select></div>
        ${field("t_datum","Datum",t.datum,"date","required")}
        ${field("t_uhrzeit","Uhrzeit",t.uhrzeit,"time")}
        ${field("t_ort","Ort",t.ort)}
        ${field("t_tn","Teilnehmer",t.teilnehmer,"number",'min="0" inputmode="numeric"')}
        <div class="field wide"><label for="t_art">Schulungsart</label><input id="t_art" list="arten" value="${esc(t.schulungsart||"")}" placeholder="Auswählen oder frei eingeben" ${dis}><datalist id="arten">${SCHULUNGSARTEN.map(a=>`<option value="${esc(a)}">`).join("")}</datalist></div>
        <div class="field"><label for="t_status">Terminstatus</label><select id="t_status" ${dis}>${[["geplant","geplant"],["durchgefuehrt","durchgeführt"],["abgesagt","abgesagt"]].map(([v,l])=>`<option value="${v}" ${t.status===v?"selected":""}>${l}</option>`).join("")}</select></div>
      </div>
      <fieldset><legend>Bericht ${seg("bericht", stOf(t,"bericht"))}</legend>
        <div class="grid">${field("b_datum","Bericht erstellt / versandt am",t.bericht?.datum,"date")}${field("b_info","Notiz zum Bericht",t.bericht?.info,"text","",true)}</div>
      </fieldset>
      <fieldset><legend>Schulungsbescheinigungen ${seg("bescheinigung", stOf(t,"bescheinigung"))}</legend>
        <div class="grid">${field("s_datum","Ausgestellt / versandt am",t.bescheinigung?.datum,"date")}${field("s_anz","Anzahl",t.bescheinigung?.anzahl,"number",'min="0" inputmode="numeric"')}${field("s_info","Notiz (z. B. Bescheinigungs-Nr.)",t.bescheinigung?.info)}</div>
      </fieldset>
      <fieldset><legend>Rechnungslegung ${seg("rechnung", stOf(t,"rechnung"))}</legend>
        <div class="grid">${field("r_datum","Rechnungsdatum",t.rechnung?.datum,"date")}${field("r_nr","Rechnungs-Nr.",t.rechnung?.nummer)}${field("r_betrag","Betrag netto (€)",t.rechnung?.betrag,"text",'inputmode="decimal" placeholder="0,00"')}${field("r_bez","Bezahlt am",t.rechnung?.bezahltAm,"date")}</div>
      </fieldset>
      <div class="field wide"><label for="t_notiz">Notizen</label><textarea id="t_notiz" ${dis}>${esc(t.notizen||"")}</textarea></div>
    </form>
    <div class="modal-f">
      ${!isNew && canWrite() ? `<button class="btn danger" type="button" id="t_del">Termin löschen</button>` : ""}
      <div class="r"><button class="btn" type="button" data-close>${canWrite()?"Abbrechen":"Schließen"}</button>${canWrite()?`<button class="btn primary" type="button" id="t_save">Speichern</button>`:""}</div>
    </div>`);

  const segState = {bericht: stOf(t,"bericht"), bescheinigung: stOf(t,"bescheinigung"), rechnung: stOf(t,"rechnung")};
  const setSeg = (k,v) => { segState[k] = v; document.querySelectorAll(`[data-seg="${k}"] button`).forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v)); };
  document.querySelectorAll("[data-seg]").forEach(s => s.querySelectorAll("button").forEach(b => b.onclick = () => setSeg(s.dataset.seg, b.dataset.v)));
  [["b_datum","bericht"],["s_datum","bescheinigung"],["r_datum","rechnung"]].forEach(([f,k]) => { const el = $("#"+f); el.addEventListener("change", () => { if(el.value && segState[k] === "offen") setSeg(k,"erledigt"); }); });

  const del = $("#t_del");
  if(del) del.onclick = async () => {
    if(!del.dataset.armed){ del.dataset.armed = "1"; del.textContent = "Wirklich löschen?"; return; }
    const {error} = await sb.from("termine").delete().eq("id", id);
    if(error){ toast(errText(error)); return; }
    termine.delete(id); saveSnapshot(); render(); closeModal(); toast("Termin gelöscht");
  };
  const sv = $("#t_save");
  if(sv) sv.onclick = async (ev, force=false) => {
    const kid = $("#t_kunde").value, datum = $("#t_datum").value;
    if(!kid){ toast("Bitte einen Kunden wählen"); $("#t_kunde").focus(); return; }
    if(!datum){ toast("Bitte ein Datum eingeben"); $("#t_datum").focus(); return; }
    const betrag = $("#r_betrag").value.trim();
    if(betrag && nnum(betrag) === null){ toast("Bitte den Betrag als Zahl eingeben, z. B. 950,00"); $("#r_betrag").focus(); return; }
    const model = {
      kundeId: kid, datum, uhrzeit: $("#t_uhrzeit").value, ort: $("#t_ort").value.trim(),
      teilnehmer: $("#t_tn").value, schulungsart: $("#t_art").value.trim(), status: $("#t_status").value,
      notizen: $("#t_notiz").value.trim(),
      bericht: {st: segState.bericht, datum: $("#b_datum").value, info: $("#b_info").value.trim()},
      bescheinigung: {st: segState.bescheinigung, datum: $("#s_datum").value, anzahl: $("#s_anz").value, info: $("#s_info").value.trim()},
      rechnung: {st: segState.rechnung, datum: $("#r_datum").value, nummer: $("#r_nr").value.trim(), betrag, bezahltAm: $("#r_bez").value}
    };
    sv.disabled = true;
    const res = await saveRow("termine", id, terminToRow(model), openDialog?.stamp, force);
    sv.disabled = false;
    if(res.error){ toast(errText(res.error)); return; }
    if(res.conflict){ showConflict(() => sv.onclick(null, true), () => { closeModal(); openTermin(id); }); return; }
    applyTermin(res.row); saveSnapshot(); render(); closeModal();
    toast(isNew ? "Termin angelegt" : "Termin gespeichert");
  };
}

function openKunde(id){
  const isNew = !id;
  const k = isNew ? {} : kunden.get(id);
  if(!k) return;
  openDialog = {type:"kunde", id, stamp: k.stamp};
  const ts = isNew ? [] : [...termine.values()].filter(t => t.kundeId === id).sort((a,b)=>(b.datum||"").localeCompare(a.datum||""));
  const dis = canWrite() ? "" : "disabled";
  showModal(`
    <div class="modal-h"><h2>${isNew?"Neuer Kunde":esc(k.name)}</h2><button class="x" type="button" data-close aria-label="Schließen">×</button></div>
    <div class="modal-b">
      <div class="note" id="remoteNote" hidden>Dieser Kunde wurde gerade auf einem anderen Gerät geändert.</div>
      <div id="conflictBox" hidden></div>
      <div class="grid">
        ${field("k_name","Firma / Name",k.name,"text","required",true)}
        ${field("k_ap","Ansprechpartner",k.ansprechpartner)}
        ${field("k_tel","Telefon",k.telefon,"tel")}
        ${field("k_mail","E-Mail",k.email,"email")}
        ${field("k_kdnr","Kunden-Nr.",k.kundennr)}
        ${field("k_str","Straße",k.strasse)}
        ${field("k_ort","PLZ / Ort",k.ort)}
        <div class="field wide"><label for="k_notiz">Notizen</label><textarea id="k_notiz" ${dis}>${esc(k.notizen||"")}</textarea></div>
      </div>
      ${isNew ? "" : `<div><div class="sec-h" style="margin-top:4px"><h3>Termine (${ts.length})</h3>${canWrite()?`<button class="btn small" type="button" id="k_newt">+ Termin für diesen Kunden</button>`:""}</div>
        ${ts.length ? `<div class="klist">${ts.map(t => { const td = todosFor(t); return `<div class="trow" data-kt="${esc(t.id)}">
          <div class="when">${fmtDate(t.datum)}</div>
          <div class="what"><b>${esc(t.schulungsart||"Termin")}</b><br><span>${esc(t.ort||"")}</span></div>
          <div class="todos">${td.length ? td.map(x=>`<span class="chip ${isOver(t)?"c-over":"c-offen"}">${ITEMS[x]}</span>`).join("") : terminStatusChip(t)}</div></div>`;}).join("")}</div>`
          : `<div class="empty">Für diesen Kunden sind noch keine Termine eingetragen.</div>`}</div>`}
    </div>
    <div class="modal-f">
      ${!isNew && canWrite() ? `<button class="btn danger" type="button" id="k_del">Kunde löschen</button>` : ""}
      <div class="r"><button class="btn" type="button" data-close>${canWrite()?"Abbrechen":"Schließen"}</button>${canWrite()?`<button class="btn primary" type="button" id="k_save">Speichern</button>`:""}</div>
    </div>`);
  document.querySelectorAll("[data-kt]").forEach(el => el.onclick = () => openTermin(el.dataset.kt));
  const nt = $("#k_newt"); if(nt) nt.onclick = () => openTermin(null, id);
  const del = $("#k_del");
  if(del) del.onclick = async () => {
    if(ts.length){ toast(`Kunde hat noch ${ts.length} Termin(e). Bitte diese zuerst löschen.`); return; }
    if(!del.dataset.armed){ del.dataset.armed = "1"; del.textContent = "Wirklich löschen?"; return; }
    const {error} = await sb.from("kunden").delete().eq("id", id);
    if(error){ toast(errText(error)); return; }
    kunden.delete(id); saveSnapshot(); render(); closeModal(); toast("Kunde gelöscht");
  };
  const sv = $("#k_save");
  if(sv) sv.onclick = async (ev, force=false) => {
    const name = $("#k_name").value.trim();
    if(!name){ toast("Bitte einen Namen eingeben"); $("#k_name").focus(); return; }
    const model = {name, ansprechpartner: $("#k_ap").value.trim(), telefon: $("#k_tel").value.trim(), email: $("#k_mail").value.trim(),
      kundennr: $("#k_kdnr").value.trim(), strasse: $("#k_str").value.trim(), ort: $("#k_ort").value.trim(), notizen: $("#k_notiz").value.trim()};
    sv.disabled = true;
    const res = await saveRow("kunden", id, kundeToRow(model), openDialog?.stamp, force);
    sv.disabled = false;
    if(res.error){ toast(errText(res.error)); return; }
    if(res.conflict){ showConflict(() => sv.onclick(null, true), () => { closeModal(); openKunde(id); }); return; }
    applyKunde(res.row); saveSnapshot(); render(); closeModal();
    toast(isNew ? "Kunde angelegt" : "Kunde gespeichert");
  };
}

$("#btnNewTermin").onclick = () => openTermin(null);
$("#btnNewKunde").onclick = () => openKunde(null);

/* ---------- CSV-Export (Excel, Semikolon, UTF-8) ---------- */
$("#btnExport").onclick = async () => {
  const cols = ["Datum","Uhrzeit","Kunde","Kunden-Nr.","Ort","Schulungsart","Teilnehmer","Terminstatus","Bericht","Bericht Datum","Bescheinigungen","Bescheinigungen Datum","Anzahl","Rechnung","Rechnungsdatum","Rechnungs-Nr.","Betrag","Bezahlt am","Offene ToDos","Notizen"];
  const q = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const rows = [...termine.values()].sort((a,b)=>(a.datum||"").localeCompare(b.datum||"")).map(t => [
    fmtDate(t.datum), t.uhrzeit, kName(t.kundeId), kunden.get(t.kundeId)?.kundennr, t.ort, t.schulungsart, t.teilnehmer, t.status,
    stOf(t,"bericht"), t.bericht?.datum?fmtDate(t.bericht.datum):"", stOf(t,"bescheinigung"), t.bescheinigung?.datum?fmtDate(t.bescheinigung.datum):"", t.bescheinigung?.anzahl,
    stOf(t,"rechnung"), t.rechnung?.datum?fmtDate(t.rechnung.datum):"", t.rechnung?.nummer, t.rechnung?.betrag!==""?String(t.rechnung.betrag).replace(".",","):"", t.rechnung?.bezahltAm?fmtDate(t.rechnung.bezahltAm):"",
    todosFor(t).map(k=>ITEMS[k]).join(", "), t.notizen
  ].map(q).join(";"));
  const csv = "﻿" + [cols.map(q).join(";"), ...rows].join("\r\n");
  const name = `Schulungstermine_${todayISO()}.csv`;
  const file = new File([csv], name, {type:"text/csv"});
  if(navigator.canShare && navigator.canShare({files:[file]}) && /iPhone|iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document){
    try { await navigator.share({files:[file], title:name}); return; } catch(e){ if(e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

/* ---------- Laden & Echtzeit ---------- */
async function fetchAll(table){
  const out = []; const size = 1000;
  for(let from = 0; ; from += size){
    const {data, error} = await sb.from(table).select("*").order("id").range(from, from + size - 1);
    if(error) throw error;
    out.push(...data);
    if(data.length < size) break;
  }
  return out;
}

async function loadAll(){
  try {
    const [ks, ts] = await Promise.all([fetchAll("kunden"), fetchAll("termine")]);
    kunden = new Map(ks.map(r => [r.id, rowToKunde(r)]));
    termine = new Map(ts.map(r => [r.id, rowToTermin(r)]));
    loaded = true; offlineMode = false;
    saveSnapshot(); setStatus("");
    render();
    return true;
  } catch(e){
    const at = loadSnapshot();
    if(at){
      loaded = true; offlineMode = true; setLive("off");
      setStatus(`Keine Verbindung zur Datenbank. Sie sehen die Lesekopie vom ${new Date(at).toLocaleString("de-DE")}. Änderungen sind wieder möglich, sobald eine Verbindung besteht.`);
    } else {
      setStatus("Keine Verbindung zur Datenbank. Bitte Internetverbindung prüfen.", true);
    }
    render();
    return false;
  }
}

function subscribe(){
  if(channel) sb.removeChannel(channel);
  channel = sb.channel("kdb-sync")
    .on("postgres_changes", {event:"*", schema:"public", table:"kunden"}, p => {
      if(p.eventType === "DELETE") kunden.delete(p.old.id); else applyKunde(p.new);
      notifyRemoteChange("kunde", p.new?.id || p.old?.id);
      saveSnapshot(); render();
    })
    .on("postgres_changes", {event:"*", schema:"public", table:"termine"}, p => {
      if(p.eventType === "DELETE") termine.delete(p.old.id); else applyTermin(p.new);
      const rid = p.new?.id || p.old?.id;
      if(!(openDialog && openDialog.type === "termin" && openDialog.id === rid && p.new?.geaendert_am === openDialog.stamp)) notifyRemoteChange("termin", rid);
      saveSnapshot(); render();
    })
    .subscribe(status => {
      if(status === "SUBSCRIBED"){ if(liveState !== "live"){ setLive("live"); if(loaded && offlineMode) loadAll(); } }
      else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED"){ setLive(navigator.onLine ? "wait" : "off"); }
    });
}

// Wenn die App aus dem Hintergrund zurückkommt (typisch iPhone/iPad), alles frisch laden.
let hiddenAt = 0;
document.addEventListener("visibilitychange", async () => {
  if(document.hidden){ hiddenAt = Date.now(); return; }
  if(session && Date.now() - hiddenAt > 20000){ await loadAll(); subscribe(); }
});
window.addEventListener("online", async () => { if(session){ setLive("wait"); await loadAll(); subscribe(); } });
window.addEventListener("offline", () => { if(session) setLive("off"); });

/* ---------- Anmeldung ---------- */
async function startApp(){
  show("app");
  $("#userMail").textContent = session.user?.email || "";
  setLive("wait");
  setView(location.hash.slice(1) || "todos", false);
  await loadAll();
  subscribe();
}

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#loginBtn"); btn.disabled = true;
  const email = $("#li_mail").value.trim(), password = $("#li_pw").value;
  const {error} = await sb.auth.signInWithPassword({email, password});
  btn.disabled = false;
  if(error){
    $("#loginMsg").textContent = /invalid/i.test(error.message) ? "E-Mail oder Passwort ist falsch." : "Anmeldung fehlgeschlagen: " + error.message;
    $("#loginMsg").style.color = "var(--bad)";
  }
});
$("#forgotBtn").onclick = async () => {
  const email = $("#li_mail").value.trim();
  if(!email){ $("#loginMsg").textContent = "Bitte zuerst Ihre E-Mail-Adresse eintragen."; $("#li_mail").focus(); return; }
  const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
  $("#loginMsg").style.color = "";
  $("#loginMsg").textContent = error ? "Senden fehlgeschlagen: " + error.message : "Falls die Adresse bekannt ist, wurde ein Link zum Zurücksetzen gesendet.";
};
$("#newpwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const {error} = await sb.auth.updateUser({password: $("#np_pw").value});
  if(error){ toast("Passwort konnte nicht gespeichert werden: " + error.message); return; }
  toast("Neues Passwort gespeichert");
  history.replaceState(null, "", location.pathname + "#todos");
  startApp();
});
$("#logoutBtn").onclick = async () => {
  try { localStorage.removeItem(SNAP_KEY); } catch(e){}
  if(channel){ sb.removeChannel(channel); channel = null; }
  await sb.auth.signOut();
  kunden.clear(); termine.clear(); loaded = false;
};

$("#setupForm").addEventListener("submit", e => {
  e.preventDefault();
  try { localStorage.setItem(CFG_KEY, JSON.stringify({supabaseUrl: $("#su_url").value.trim(), supabaseAnonKey: $("#su_key").value.trim()})); } catch(err){}
  location.reload();
});

function getConfig(){
  const c = window.APP_CONFIG || {};
  if(c.supabaseUrl && c.supabaseAnonKey) return c;
  try { const s = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); if(s?.supabaseUrl && s?.supabaseAnonKey) return s; } catch(e){}
  return null;
}

function boot(){
  const cfg = getConfig();
  if(!cfg){ show("setup"); return; }
  if(!window.supabase?.createClient){ show("login"); $("#loginMsg").textContent = "Programmbibliothek fehlt (vendor/supabase.js)."; return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  let started = false;
  sb.auth.onAuthStateChange((event, s) => {
    session = s;
    if(event === "PASSWORD_RECOVERY"){ show("newpw"); return; }
    if(!s){ started = false; show("login"); return; }
    if(event === "TOKEN_REFRESHED" && channel){ return; }
    if(!started && $("#newpw").hidden){ started = true; setTimeout(startApp, 0); }
  });
  // Ohne Netz und mit gespeicherter Anmeldung: Lesekopie zeigen
  setTimeout(() => { if(!session && !navigator.onLine && loadSnapshot()){ show("app"); loaded = true; offlineMode = true; setLive("off");
    setStatus("Offline: Sie sehen die zuletzt gespeicherte Lesekopie."); setView(location.hash.slice(1) || "todos", false); } }, 1500);
}

if("serviceWorker" in navigator && location.protocol === "https:"){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
boot();
})();
