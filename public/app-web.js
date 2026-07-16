/* ===================== CONFIG ===================== */
const ESTADOS = ["Activo","Pendiente","Reprogramado","No se vendió","Vendido pendiente de pago","Pagado"];
const ESTADO_COLOR = {
  "Activo":"var(--st-activo)",
  "Pendiente":"var(--st-pendiente)",
  "Reprogramado":"var(--st-reprogramado)",
  "No se vendió":"var(--st-novendio)",
  "Vendido pendiente de pago":"var(--st-vendidopend)",
  "Pagado":"var(--st-pagado)"
};
const LOCK_KEY = "gestion-managers-device-lock";

let STATE = null;          // {managers:[], clients:[]}
let CURRENT_USER = null;   // {type:'admin'} or {type:'manager', name:'...'}
let openCards = new Set();
let saveTimer = null;

/* ===================== STORAGE HELPERS (real backend via /api) ===================== */
async function loadShared(){
  try{
    const r = await fetch('/api/data');
    if(!r.ok) return null;
    return await r.json();
  }catch(e){ return null; }
}
async function saveShared(state){
  try{
    const r = await fetch('/api/data', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify(state)
    });
    return r.ok;
  }catch(e){ return false; }
}
function loadLock(){
  try{
    const v = localStorage.getItem(LOCK_KEY);
    return v ? JSON.parse(v) : null;
  }catch(e){ return null; }
}
function saveLock(val){
  try{ localStorage.setItem(LOCK_KEY, JSON.stringify(val)); }catch(e){}
}
function clearLock(){
  try{ localStorage.removeItem(LOCK_KEY); }catch(e){}
}

function todayStr(){
  const d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

async function getBackupIndex(){
  try{
    const r = await fetch('/api/backups');
    if(!r.ok) return [];
    return await r.json();
  }catch(e){ return []; }
}
async function makeBackup(manual){
  try{
    const r = await fetch('/api/backups', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({manual: !!manual})
    });
    return r.ok;
  }catch(e){ return false; }
}
async function maybeAutoBackup(){
  const idx = await getBackupIndex();
  const already = idx.some(b => !b.manual && b.stamp.slice(0,10) === todayStr());
  if(!already){ await makeBackup(false); }
}
async function restoreBackup(id){
  try{
    const r = await fetch('/api/backups/restore', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({id})
    });
    if(!r.ok) return false;
    STATE = await r.json();
    return true;
  }catch(e){ return false; }
}

/* ===================== SAVE (debounced) ===================== */
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}
async function doSave(){
  const ok = await saveShared(STATE);
  showBadge(ok);
}
function showBadge(ok){
  const b = document.getElementById("savebadge");
  b.textContent = ok ? "Guardado ✓" : "Error al guardar, reintentando…";
  b.className = "savebadge show" + (ok ? "" : " err");
  setTimeout(()=>{ b.className = "savebadge"; }, 1600);
  if(!ok) scheduleSave();
}

/* ===================== NORMALIZATION / DUPLICATES ===================== */
function normName(n){ return (n||"").toString().trim().toLowerCase().replace(/\s+/g," "); }
function normPhone(p){ return (p||"").toString().replace(/\D/g,"").slice(-10); }
function findDuplicate(nombre, telefono, excludeId){
  const nn = normName(nombre), np = normPhone(telefono);
  return STATE.clients.find(c => c.id !== excludeId && normName(c.nombre)===nn && (np && normPhone(c.telefono)===np));
}
function newId(){
  return "c" + Date.now() + Math.floor(Math.random()*1000);
}

/* ===================== INIT ===================== */
async function init(){
  const shared = await loadShared();
  if(!shared){
    document.getElementById("root").innerHTML =
      '<div class="lockwrap"><h1>No se pudo conectar</h1><p>No se pudo cargar el servidor de datos. Revisa tu conexión y recarga la página.</p></div>';
    return;
  }
  STATE = shared;
  if(!STATE.managers) STATE.managers = [];
  if(!STATE.clients) STATE.clients = [];

  await maybeAutoBackup();

  const lock = await loadLock();
  if(lock && lock.type === "admin"){ CURRENT_USER = {type:"admin"}; }
  else if(lock && lock.type === "manager" && STATE.managers.includes(lock.name)){
    CURRENT_USER = {type:"manager", name: lock.name};
  }
  render();
}

/* ===================== RENDER ROOT ===================== */
function render(){
  const root = document.getElementById("root");
  if(!CURRENT_USER){ root.innerHTML = ""; root.appendChild(renderLock()); return; }
  root.innerHTML = "";
  root.appendChild(renderHeader());
  const app = document.createElement("div");
  app.className = "app";
  if(CURRENT_USER.type === "admin"){
    app.appendChild(renderAdminToolbar());
    app.appendChild(renderSummary());
    STATE.managers.forEach(m => app.appendChild(renderManagerCard(m, true)));
  } else {
    app.appendChild(renderManagerCard(CURRENT_USER.name, false));
  }
  root.appendChild(app);
}

/* ===================== LOCK SCREEN ===================== */
function renderLock(){
  const wrap = document.createElement("div");
  wrap.className = "lockwrap";
  wrap.innerHTML = `
    <h1>Gestión de Managers</h1>
    <p>Quantica360 — selecciona tu nombre para continuar</p>
  `;
  const grid = document.createElement("div");
  grid.className = "namegrid";

  const adminBtn = document.createElement("button");
  adminBtn.className = "namebtn admin";
  adminBtn.textContent = "👑 Omar (Admin — ve todo)";
  adminBtn.onclick = async () => {
    await saveLock({type:"admin"});
    CURRENT_USER = {type:"admin"};
    render();
  };
  grid.appendChild(adminBtn);

  STATE.managers.forEach(m => {
    const b = document.createElement("button");
    b.className = "namebtn";
    b.textContent = m;
    b.onclick = async () => {
      await saveLock({type:"manager", name:m});
      CURRENT_USER = {type:"manager", name:m};
      render();
    };
    grid.appendChild(b);
  });
  wrap.appendChild(grid);
  const note = document.createElement("p");
  note.style.marginTop = "22px";
  note.style.fontSize = "11.5px";
  note.textContent = "Este dispositivo recordará tu selección. Si te equivocaste, pide al administrador que lo reinicie desde el menú.";
  wrap.appendChild(note);
  return wrap;
}

/* ===================== HEADER ===================== */
function renderHeader(){
  const h = document.createElement("header");
  h.className = "top";
  const who = CURRENT_USER.type === "admin" ? "Admin — Omar" : CURRENT_USER.name;
  h.innerHTML = `
    <div class="brand"><b>Gestión de Managers</b><span>${who}</span></div>
  `;
  const btn = document.createElement("button");
  btn.className = "iconbtn";
  btn.textContent = "⋮ Menú";
  btn.onclick = openMenuModal;
  h.appendChild(btn);
  return h;
}

function openMenuModal(){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>Menú</h3>
    <div class="modalbtns" style="flex-direction:column;">
      ${CURRENT_USER.type==="admin" ? '<button class="btnok" id="mnuExport">⬇️ Exportar Excel</button>' : ''}
      ${CURRENT_USER.type==="admin" ? '<button class="btnok" id="mnuBackup" style="background:var(--teal-dark);">🗄️ Respaldos</button>' : ''}
      <button class="btncancel" id="mnuInstall">📲 Instrucciones para instalar como app</button>
      <button class="btndanger" id="mnuLogout">🔒 Cambiar de usuario</button>
    </div>
  `;
  const close = showModal(body);
  if(CURRENT_USER.type==="admin"){
    body.querySelector("#mnuExport").onclick = () => { close(); exportExcel(); };
    body.querySelector("#mnuBackup").onclick = () => { close(); openBackupModal(); };
  }
  body.querySelector("#mnuInstall").onclick = () => { close(); openInstallModal(); };
  body.querySelector("#mnuLogout").onclick = () => { close(); confirmLogout(); };
}

function confirmLogout(){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>¿Cambiar de usuario?</h3>
    <p style="font-size:13px;color:var(--muted);">Esto va a olvidar quién eres en este dispositivo. Vas a tener que volver a seleccionar tu nombre. Los datos no se borran.</p>
    <div class="modalbtns">
      <button class="btncancel" id="cLNo">Cancelar</button>
      <button class="btndanger" id="cLYes">Sí, cambiar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#cLNo").onclick = close;
  body.querySelector("#cLYes").onclick = async () => {
    await clearLock();
    CURRENT_USER = null;
    close();
    render();
  };
}

/* ===================== MODAL HELPER ===================== */
function showModal(innerNode){
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.appendChild(innerNode);
  overlay.appendChild(modal);
  overlay.onclick = (e) => { if(e.target === overlay) close(); };
  document.body.appendChild(overlay);
  function close(){ overlay.remove(); }
  return close;
}

/* ===================== SUMMARY (ADMIN) ===================== */
function renderSummary(){
  const box = document.createElement("div");
  box.className = "summarybox";
  const counts = {}; ESTADOS.forEach(e => counts[e]=0);
  STATE.clients.forEach(c => { if(counts[c.estado]===undefined) counts[c.estado]=0; counts[c.estado]++; });
  const total = STATE.clients.length || 1;
  let rows = "";
  ESTADOS.forEach(e => {
    const n = counts[e] || 0;
    const pct = Math.round((n/total)*100);
    rows += `<div class="sumrow"><div class="lbl">${e}</div>
      <div class="bar"><i style="width:${pct}%;background:${ESTADO_COLOR[e]}"></i></div>
      <div class="val">${n} (${pct}%)</div></div>`;
  });
  box.innerHTML = `<h3>Reporte general — ${STATE.clients.length} clientes en ${STATE.managers.length} managers</h3>${rows}`;
  return box;
}

/* ===================== DONUT (mini, css conic-gradient) ===================== */
function donutStyle(clients){
  const counts = {}; ESTADOS.forEach(e=>counts[e]=0);
  clients.forEach(c => { if(counts[c.estado]===undefined) counts[c.estado]=0; counts[c.estado]++; });
  const total = clients.length;
  if(total===0) return "background:var(--line);";
  let acc = 0; const parts = [];
  ESTADOS.forEach(e => {
    const n = counts[e];
    if(n<=0) return;
    const start = (acc/total)*360; acc += n;
    const end = (acc/total)*360;
    parts.push(`${cssColor(ESTADO_COLOR[e])} ${start}deg ${end}deg`);
  });
  return `background:conic-gradient(${parts.join(",")});`;
}
function cssColor(varStr){
  // varStr like "var(--st-activo)" -> resolve to actual hex for conic-gradient (some browsers need literal)
  const map = {
    "var(--st-activo)":"#2E6FC4","var(--st-pendiente)":"#8A8F98","var(--st-reprogramado)":"#7B4FC9",
    "var(--st-novendio)":"#C4472B","var(--st-vendidopend)":"#D98B1F","var(--st-pagado)":"#1E8A5A"
  };
  return map[varStr] || "#ccc";
}

/* ===================== MANAGER CARD ===================== */
function renderManagerCard(managerName, collapsible){
  const clients = STATE.clients.filter(c => c.manager === managerName);
  const card = document.createElement("div");
  card.className = "mgrcard" + (openCards.has(managerName) || !collapsible ? " open" : "");

  const head = document.createElement("div");
  head.className = "mgrhead";
  head.innerHTML = `
    <div class="donut" style="${donutStyle(clients)}"></div>
    <div class="info"><b>${managerName}</b><span>${clients.length} cliente${clients.length===1?"":"s"}</span></div>
    ${collapsible ? '<div class="chev">▾</div>' : ''}
  `;
  if(collapsible){
    head.onclick = () => {
      if(openCards.has(managerName)) openCards.delete(managerName);
      else openCards.add(managerName);
      render();
    };
  }
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "mgrbody";

  const btnrow = document.createElement("div");
  btnrow.className = "cardbtns";
  btnrow.innerHTML = `
    <button class="actionbtn primary" data-act="ai">🤖 Pegar y cargar con IA</button>
    <button class="actionbtn" data-act="manual">➕ Agregar cliente</button>
  `;
  btnrow.querySelector('[data-act="ai"]').onclick = () => openAiPasteModal(managerName);
  btnrow.querySelector('[data-act="manual"]').onclick = () => openClientForm(managerName, null);
  body.appendChild(btnrow);

  const list = document.createElement("div");
  list.className = "clientlist";
  list.style.marginTop = "12px";
  if(clients.length === 0){
    list.innerHTML = `<div class="emptynote">Sin clientes todavía.</div>`;
  } else {
    clients.forEach(c => list.appendChild(renderClientCard(c)));
  }
  body.appendChild(list);
  card.appendChild(body);
  return card;
}

/* ===================== CLIENT CARD ===================== */
function renderClientCard(c){
  const el = document.createElement("div");
  el.className = "clientcard";
  const telHref = c.telefono ? `tel:${c.telefono.replace(/[^0-9+]/g,"")}` : "#";
  el.innerHTML = `
    <div class="cname">${c.nombre}</div>
    <div class="cmeta">
      ${c.telefono ? `📞 <a href="${telHref}">${c.telefono}</a><br>` : ""}
      ${c.direccion ? `📍 ${c.direccion}<br>` : ""}
      ${c.fechaCita ? `🗓️ ${c.fechaCita}<br>` : ""}
      ${c.idioma ? `🗣️ Idioma: ${c.idioma}<br>` : ""}
      ${c.notas ? `📝 ${c.notas}` : ""}
    </div>
    ${c.revisar ? '<div class="revisarflag">⚠️ Revisar: estado heredado del sistema anterior</div>' : ""}
  `;
  const srow = document.createElement("div");
  srow.className = "statusrow";
  ESTADOS.forEach(e => {
    const pill = document.createElement("button");
    pill.className = "statuspill" + (c.estado===e ? " active":"");
    pill.textContent = e;
    if(c.estado===e) pill.style.background = ESTADO_COLOR[e];
    pill.onclick = () => {
      c.estado = e;
      c.revisar = false;
      scheduleSave();
      render();
    };
    srow.appendChild(pill);
  });
  el.appendChild(srow);

  const payWrap = document.createElement("div");
  if(c.fechaPago){
    payWrap.innerHTML = `<span class="paydateset">💰 Fecha de pago: ${formatDate(c.fechaPago)}
      <button data-x="clr">✕</button></span>`;
    payWrap.querySelector('[data-x="clr"]').onclick = () => {
      c.fechaPago = "";
      scheduleSave();
      render();
    };
  } else {
    const b = document.createElement("button");
    b.className = "paydatebtn";
    b.textContent = "📅 Fecha de pago";
    b.onclick = () => openPayDateModal(c);
    payWrap.appendChild(b);
  }
  el.appendChild(payWrap);

  const actions = document.createElement("div");
  actions.className = "cactions";
  const editBtn = document.createElement("button");
  editBtn.className = "miniBtn";
  editBtn.textContent = "✏️ Editar";
  editBtn.onclick = () => openClientForm(c.manager, c);
  const delBtn = document.createElement("button");
  delBtn.className = "miniBtn";
  delBtn.textContent = "🗑️ Eliminar";
  delBtn.onclick = () => confirmDeleteClient(c);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  el.appendChild(actions);

  return el;
}
function formatDate(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function openPayDateModal(c){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>Fecha de pago — ${c.nombre}</h3>
    <label>Selecciona la fecha</label>
    <input type="date" id="payInput" value="${c.fechaPago || ""}">
    <div class="modalbtns">
      <button class="btncancel" id="payCancel">Cancelar</button>
      <button class="btnok" id="paySave">Guardar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#payCancel").onclick = close;
  body.querySelector("#paySave").onclick = () => {
    const v = body.querySelector("#payInput").value;
    if(v){ c.fechaPago = v; scheduleSave(); }
    close(); render();
  };
}

function confirmDeleteClient(c){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>¿Eliminar cliente?</h3>
    <p style="font-size:13px;color:var(--muted);">${c.nombre} se va a eliminar permanentemente.</p>
    <div class="modalbtns">
      <button class="btncancel" id="dNo">Cancelar</button>
      <button class="btndanger" id="dYes">Eliminar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#dNo").onclick = close;
  body.querySelector("#dYes").onclick = () => {
    STATE.clients = STATE.clients.filter(x => x.id !== c.id);
    scheduleSave();
    close(); render();
  };
}

/* ===================== CLIENT FORM (manual add/edit) ===================== */
function openClientForm(managerName, existing){
  const body = document.createElement("div");
  body.className = "modalhead";
  body.innerHTML = `
    <button class="closeX" id="cfX">✕</button>
    <h3>${existing ? "Editar cliente" : "Agregar cliente"} — ${managerName}</h3>
    <label>Nombre completo</label>
    <input type="text" id="cfNombre" value="${existing ? esc(existing.nombre) : ""}">
    <label>Teléfono</label>
    <input type="tel" id="cfTelefono" value="${existing ? esc(existing.telefono) : ""}">
    <label>Dirección</label>
    <input type="text" id="cfDireccion" value="${existing ? esc(existing.direccion) : ""}">
    <label>Fecha de asignación / cita</label>
    <input type="text" id="cfFecha" placeholder="ej. 20/7/2026, 14:00" value="${existing ? esc(existing.fechaCita) : ""}">
    <label>Idioma preferido</label>
    <input type="text" id="cfIdioma" placeholder="Español / Inglés" value="${existing ? esc(existing.idioma) : ""}">
    <label>Observaciones / notas</label>
    <textarea id="cfNotas">${existing ? esc(existing.notas) : ""}</textarea>
    <div id="cfDupe"></div>
    <div class="modalbtns">
      <button class="btncancel" id="cfCancel">Cancelar</button>
      <button class="btnok" id="cfSave">Guardar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#cfX").onclick = close;
  body.querySelector("#cfCancel").onclick = close;
  body.querySelector("#cfSave").onclick = () => {
    const nombre = body.querySelector("#cfNombre").value.trim();
    const telefono = body.querySelector("#cfTelefono").value.trim();
    if(!nombre){ body.querySelector("#cfNombre").focus(); return; }
    const dupe = findDuplicate(nombre, telefono, existing ? existing.id : null);
    if(dupe && !body.dataset.confirmedDupe){
      body.querySelector("#cfDupe").innerHTML = `<div class="dupewarn">⚠️ Ya existe un cliente similar: <b>${esc(dupe.nombre)}</b> (${esc(dupe.manager)}). Toca "Guardar" otra vez para guardar de todas formas.</div>`;
      body.dataset.confirmedDupe = "1";
      return;
    }
    const data = {
      nombre, telefono,
      direccion: body.querySelector("#cfDireccion").value.trim(),
      fechaCita: body.querySelector("#cfFecha").value.trim(),
      idioma: body.querySelector("#cfIdioma").value.trim(),
      notas: body.querySelector("#cfNotas").value.trim(),
    };
    if(existing){
      Object.assign(existing, data);
    } else {
      STATE.clients.push({
        id: newId(), manager: managerName, estado:"Pendiente", fechaPago:"", revisar:false, ...data
      });
    }
    scheduleSave();
    close(); render();
  };
}
function esc(s){ return (s||"").toString().replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

/* ===================== AI BULK PASTE ===================== */
function openAiPasteModal(managerName){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>🤖 Pegar y cargar con IA — ${managerName}</h3>
    <label>Pega el bloque de texto con los datos de los clientes</label>
    <textarea id="aiText" placeholder="Pega aquí el mensaje de WhatsApp, la lista de citas, etc."></textarea>
    <div class="helptext">La IA va a identificar nombre, teléfono, dirección, fecha e idioma automáticamente. Los duplicados se omiten solos.</div>
    <div id="aiStatus"></div>
    <div class="modalbtns">
      <button class="btncancel" id="aiCancel">Cancelar</button>
      <button class="btnok" id="aiGo">Cargar con IA</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#aiCancel").onclick = close;
  body.querySelector("#aiGo").onclick = async () => {
    const text = body.querySelector("#aiText").value.trim();
    if(!text) return;
    const statusEl = body.querySelector("#aiStatus");
    const goBtn = body.querySelector("#aiGo");
    goBtn.disabled = true;
    statusEl.innerHTML = `<div class="helptext"><span class="spin"></span> Analizando con IA…</div>`;
    try{
      const parsed = await parseClientsWithAI(text);
      if(!parsed || parsed.length===0){
        statusEl.innerHTML = `<div class="dupewarn">No se pudo identificar ningún cliente en ese texto. Intenta con el formulario manual.</div>`;
        goBtn.disabled = false;
        return;
      }
      let added = 0, skipped = [];
      parsed.forEach(p => {
        if(!p.nombre) return;
        const dupe = findDuplicate(p.nombre, p.telefono, null);
        if(dupe){ skipped.push(p.nombre); return; }
        STATE.clients.push({
          id: newId(), manager: managerName, estado:"Pendiente", fechaPago:"", revisar:false,
          nombre: p.nombre || "", telefono: p.telefono || "", direccion: p.direccion || "",
          fechaCita: p.fechaCita || "", idioma: p.idioma || "", notas: p.notas || ""
        });
        added++;
      });
      scheduleSave();
      let msg = `<div class="helptext">✅ ${added} cliente(s) agregado(s).`;
      if(skipped.length) msg += ` Omitidos por duplicado: ${skipped.join(", ")}.`;
      msg += `</div>`;
      statusEl.innerHTML = msg;
      setTimeout(()=>{ close(); render(); }, 1400);
    }catch(e){
      const msg = e.code === "missing_api_key"
        ? "Falta configurar la clave de IA en el servidor (ANTHROPIC_API_KEY). Avísale al administrador."
        : "Error al procesar con IA. Intenta de nuevo o usa el formulario manual.";
      statusEl.innerHTML = `<div class="dupewarn">${msg}</div>`;
      goBtn.disabled = false;
    }
  };
}

async function parseClientsWithAI(text){
  const response = await fetch("/api/parse", {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({text})
  });
  const data = await response.json();
  if(!response.ok){
    const err = new Error(data.message || data.error || "Error de IA");
    err.code = data.error;
    throw err;
  }
  return Array.isArray(data) ? data : [data];
}

/* ===================== ADMIN TOOLBAR ===================== */
function renderAdminToolbar(){
  const box = document.createElement("div");
  box.className = "toolbar";
  box.innerHTML = `
    <button class="toolbtn" id="tbAddMgr">➕ Agregar manager</button>
    <button class="toolbtn" id="tbExport">⬇️ Exportar Excel</button>
    <button class="toolbtn" id="tbBackup">🗄️ Respaldos</button>
  `;
  box.querySelector("#tbAddMgr").onclick = openAddManagerModal;
  box.querySelector("#tbExport").onclick = exportExcel;
  box.querySelector("#tbBackup").onclick = openBackupModal;
  return box;
}

function openAddManagerModal(){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>Agregar manager</h3>
    <label>Nombre del manager</label>
    <input type="text" id="mgrName" placeholder="Nombre completo">
    <div class="modalbtns">
      <button class="btncancel" id="amCancel">Cancelar</button>
      <button class="btnok" id="amSave">Agregar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#amCancel").onclick = close;
  body.querySelector("#amSave").onclick = () => {
    const name = body.querySelector("#mgrName").value.trim();
    if(!name) return;
    if(STATE.managers.includes(name)){ alert("Ese manager ya existe."); return; }
    STATE.managers.push(name);
    scheduleSave();
    close(); render();
  };
}

/* ===================== BACKUP MODAL ===================== */
async function openBackupModal(){
  const body = document.createElement("div");
  body.innerHTML = `<h3>Respaldos</h3><div id="bkList">Cargando…</div>
    <div class="modalbtns"><button class="btnok" id="bkMake">Crear respaldo manual ahora</button></div>`;
  const close = showModal(body);
  async function refresh(){
    const idx = await getBackupIndex();
    const list = body.querySelector("#bkList");
    if(idx.length===0){ list.innerHTML = `<div class="helptext">Sin respaldos todavía.</div>`; return; }
    list.innerHTML = idx.map(b => {
      const d = new Date(b.stamp);
      const label = d.toLocaleString("es", {dateStyle:"medium", timeStyle:"short"});
      return `<div class="backuprow"><span>${label} ${b.manual?"(manual)":"(auto)"} · ${b.count} clientes</span>
        <button data-id="${b.id}">Restaurar</button></div>`;
    }).join("");
    list.querySelectorAll("button[data-id]").forEach(btn => {
      btn.onclick = () => confirmRestore(btn.dataset.id, close);
    });
  }
  body.querySelector("#bkMake").onclick = async () => {
    await makeBackup(true);
    refresh();
  };
  refresh();
}

function confirmRestore(id, closeParent){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>¿Restaurar este respaldo?</h3>
    <p style="font-size:13px;color:var(--muted);">Esto va a reemplazar TODOS los datos actuales por los del respaldo. No se puede deshacer.</p>
    <div class="modalbtns">
      <button class="btncancel" id="rNo">Cancelar</button>
      <button class="btndanger" id="rYes">Sí, restaurar</button>
    </div>
  `;
  const close = showModal(body);
  body.querySelector("#rNo").onclick = close;
  body.querySelector("#rYes").onclick = async () => {
    const ok = await restoreBackup(id);
    close();
    if(closeParent) closeParent();
    render();
    showBadge(ok);
  };
}

/* ===================== INSTALL INSTRUCTIONS ===================== */
function openInstallModal(){
  const body = document.createElement("div");
  body.innerHTML = `
    <h3>📲 Instalar como app</h3>
    <div class="installsteps">
      Esta app ya vive en su propio link fijo — no depende de Claude ni de publicar nada.<br><br>
      <b>En Android (Chrome):</b><br>
      Toca los <b>tres puntos (⋮)</b> arriba a la derecha → <b>Agregar a pantalla de inicio</b>.<br><br>
      <b>En iPhone (Safari):</b><br>
      Toca el ícono de <b>Compartir</b> (cuadro con flecha) → <b>Agregar a pantalla de inicio</b>.<br><br>
      El ícono va a quedar fijo y va a abrir la app directamente, sin pasar por el navegador.
    </div>
    <div class="modalbtns"><button class="btnok" id="instClose">Entendido</button></div>
  `;
  const close = showModal(body);
  body.querySelector("#instClose").onclick = close;
}

/* ===================== EXCEL EXPORT ===================== */
function exportExcel(){
  const wb = XLSX.utils.book_new();
  const headers = ["#","Manager","Nombre","Teléfono","Dirección","Fecha Cita","Idioma","Notas","Estado","Fecha de pago"];

  function sheetFor(clients){
    const rows = [headers];
    clients.forEach((c,i) => rows.push([i+1, c.manager, c.nombre, c.telefono, c.direccion, c.fechaCita, c.idioma, c.notas, c.estado, c.fechaPago ? formatDate(c.fechaPago) : ""]));
    return XLSX.utils.aoa_to_sheet(rows);
  }

  XLSX.utils.book_append_sheet(wb, sheetFor(STATE.clients), "Todos los clientes");

  // Resumen
  const resumenRows = [["Manager", ...ESTADOS, "Total"]];
  STATE.managers.forEach(m => {
    const clients = STATE.clients.filter(c=>c.manager===m);
    const row = [m];
    ESTADOS.forEach(e => row.push(clients.filter(c=>c.estado===e).length));
    row.push(clients.length);
    resumenRows.push(row);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumenRows), "Resumen");

  STATE.managers.forEach(m => {
    const clients = STATE.clients.filter(c=>c.manager===m);
    const safe = m.slice(0,31);
    XLSX.utils.book_append_sheet(wb, sheetFor(clients), safe);
  });

  const stamp = todayStr();
  XLSX.writeFile(wb, `managers_${stamp}.xlsx`);
}

/* ===================== START ===================== */
init();
