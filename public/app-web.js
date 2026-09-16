/* ===================== CONFIG ===================== */
const ESTADOS = ["Activo","Pendiente","Reprogramado","No atendió","No se vendió","Vendido pendiente de pago","Pagado"];
const ESTADO_COLOR = {
  "Activo":"var(--st-activo)",
  "Pendiente":"var(--st-pendiente)",
  "Reprogramado":"var(--st-reprogramado)",
  "No atendió":"var(--st-noatendio)",
  "No se vendió":"var(--st-novendio)",
  "Vendido pendiente de pago":"var(--st-vendidopend)",
  "Pagado":"var(--st-pagado)"
};
// Estados que significan "todavia no se actualizo nada despues de la
// cita" (los dos valores por defecto: uno para citas que llegan solas
// por Webhook, otro para clientes agregados a mano). Un cliente en uno
// de estos estados, cuya fecha de cita ya paso, se considera "vencido
// y pendiente de completar informacion de gestion".
const ESTADOS_PENDIENTES_GESTION = ["Activo","Pendiente"];
// Paleta fija para el Calendario General / Mi horario: cada manager recibe
// SIEMPRE el mismo color (segun su posicion en STATE.managers), para poder
// distinguir de un vistazo a que manager pertenece cada bloque de cita.
const MANAGER_PALETTE = [
  "#2E6FC4","#C4472B","#1E8A5A","#7B4FC9","#D98B1F","#0E7C86","#8D6346",
  "#C2185B","#455A64","#6D4C41","#00897B","#5E35B1","#EF6C00","#3949AB"
];
// Rango visible de la franja de horario (8:00am a 9:00pm) y duracion fija
// asumida por cita (no hay campo de duracion en los datos).
const CAL_START_MIN = 8*60;
const CAL_END_MIN = 21*60;
const CAL_BLOCK_MIN = 60;
const LOCK_KEY = "gestion-managers-device-lock";
// Guarda el codigo secreto del link personal de un manager en este
// dispositivo, para que no tenga que volver a tocar el link cada vez
// que abre la app (aunque el link siga siendo lo que le da acceso).
const MGR_TOKEN_KEY = "gestion-managers-token";
// Igual que MGR_TOKEN_KEY, pero para el link personal de un sub-gestor
// (segundo nivel de acceso, ve solo lo que su manager le derivo).
const SUBGESTOR_TOKEN_KEY = "gestion-managers-subgestor-token";
const VEINTICUATRO_HORAS_MS = 24*60*60*1000;

let STATE = null;          // {managers:[], clients:[]}
let CURRENT_USER = null;   // {type:'admin'} or {type:'manager', name:'...', token:'...'}
let openCards = new Set();
let calendarOpen = false;  // si se esta mostrando "Calendario General" (admin) / "Mi horario" (manager)
let calendarStart = null;  // "yyyy-mm-dd" del primer dia visible de la ventana de 3 dias

/* ===================== STORAGE HELPERS (real backend via /api) ===================== */
async function loadShared(token){
  try{
    const url = token ? ('/api/data?token=' + encodeURIComponent(token)) : '/api/data';
    // cache:'no-store' obliga al navegador a pedir SIEMPRE los datos
    // reales al servidor, nunca una copia guardada en el celular/PC.
    const r = await fetch(url, { cache: 'no-store' });
    const data = await r.json().catch(()=>null);
    if(!r.ok) return data || { error: "network" };
    return data;
  }catch(e){ return null; }
}

function saveManagerToken(t){ try{ localStorage.setItem(MGR_TOKEN_KEY, t); }catch(e){} }
function loadManagerToken(){ try{ return localStorage.getItem(MGR_TOKEN_KEY) || ""; }catch(e){ return ""; } }
function saveSubgestorToken(t){ try{ localStorage.setItem(SUBGESTOR_TOKEN_KEY, t); }catch(e){} }
function loadSubgestorToken(){ try{ return localStorage.getItem(SUBGESTOR_TOKEN_KEY) || ""; }catch(e){ return ""; } }

// Cada cambio se guarda de inmediato, uno por uno (un cliente, o un
// manager), en vez de reescribir toda la lista junta. Asi, si Omar y
// una cita nueva por Webhook guardan casi al mismo tiempo, nunca se
// borran entre si.
async function saveClientRemote(client, fields){
  try{
    // Si "fields" viene con una lista de nombres de campo (ej.
    // ['estado','revisar']), solo mandamos esos campos + el id, en vez
    // de la ficha completa del cliente. Esto evita que, si alguien
    // tiene la pantalla abierta desde hace rato (por ejemplo un
    // manager y su secretaria compartiendo el mismo link), un guardado
    // "viejo" borre por accidente un cambio mas reciente que hizo otra
    // persona en un campo distinto. Si no se pasa "fields", se manda
    // la ficha completa (se usa para crear o editar un cliente entero,
    // algo que solo hace el administrador).
    let base;
    if(fields){
      base = { id: client.id };
      fields.forEach(f => { base[f] = client[f]; });
    } else {
      base = { ...client };
    }
    // Si quien guarda es un manager o un sub-gestor (entro por su link
    // personal), le mandamos al servidor su codigo secreto junto con el
    // cambio. El servidor usa ese codigo para saber quien es y que SI
    // puede tocar.
    const payload = (CURRENT_USER && (CURRENT_USER.type === "manager" || CURRENT_USER.type === "subgestor"))
      ? { ...base, token: CURRENT_USER.token }
      : base;
    const r = await fetch('/api/client', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(()=>({}));
    return {ok:r.ok, data};
  }catch(e){ return {ok:false, data:{}}; }
}
async function deleteClientRemote(id){
  try{
    const r = await fetch('/api/client?id='+encodeURIComponent(id), {method:'DELETE'});
    return r.ok;
  }catch(e){ return false; }
}
async function addManagerRemote(name){
  try{
    const r = await fetch('/api/manager', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({name})
    });
    return r.ok;
  }catch(e){ return false; }
}
async function deleteManagerRemote(name){
  try{
    const r = await fetch('/api/manager?name='+encodeURIComponent(name), {method:'DELETE'});
    return r.ok;
  }catch(e){ return false; }
}

/* ===================== SUB-GESTORES (remote) ===================== */
// Si quien pide el cambio es un manager (entro por su link personal), el
// servidor usa su token para saber a que manager pertenece el sub-gestor
// (no confia en managerName si viene un token). Si es el administrador
// (sin token), hay que mandar managerName explicito.
function subgestorAuthPayload(managerName){
  return (CURRENT_USER && CURRENT_USER.type === "manager")
    ? { token: CURRENT_USER.token }
    : { managerName };
}
async function addSubgestorRemote(managerName, nombre, telefono){
  try{
    const body = { ...subgestorAuthPayload(managerName), nombre, telefono };
    const r = await fetch('/api/subgestor', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await r.json().catch(()=>({}));
    return {ok:r.ok, data};
  }catch(e){ return {ok:false, data:{}}; }
}
async function updateSubgestorRemote(managerName, id, nombre, telefono){
  try{
    const body = { ...subgestorAuthPayload(managerName), id, nombre, telefono };
    const r = await fetch('/api/subgestor', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await r.json().catch(()=>({}));
    return {ok:r.ok, data};
  }catch(e){ return {ok:false, data:{}}; }
}
async function deleteSubgestorRemote(managerName, id){
  try{
    const auth = subgestorAuthPayload(managerName);
    const qs = new URLSearchParams({ ...auth, id }).toString();
    const r = await fetch('/api/subgestor?'+qs, {method:'DELETE'});
    return r.ok;
  }catch(e){ return false; }
}
async function derivarRemote(clientId, subgestorId){
  try{
    const body = { clientId, subgestorId };
    if(CURRENT_USER && CURRENT_USER.type === "manager") body.token = CURRENT_USER.token;
    const r = await fetch('/api/derivar', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await r.json().catch(()=>({}));
    return {ok:r.ok, data};
  }catch(e){ return {ok:false, data:{}}; }
}
async function liberarRemote(clientId){
  try{
    const body = { clientId };
    if(CURRENT_USER && CURRENT_USER.type === "manager") body.token = CURRENT_USER.token;
    const r = await fetch('/api/liberar', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await r.json().catch(()=>({}));
    return {ok:r.ok, data};
  }catch(e){ return {ok:false, data:{}}; }
}
// Vuelve a pedir al servidor los datos de la vista actual (admin o
// manager) despues de un cambio en sub-gestores/derivaciones, para que la
// pantalla quede sincronizada con lo que realmente quedo guardado.
async function refreshCurrentView(){
  if(CURRENT_USER.type === "admin"){
    const fresh = await loadShared();
    if(fresh && !fresh.error){
      STATE = fresh;
      if(!STATE.managers) STATE.managers = [];
      if(!STATE.clients) STATE.clients = [];
    }
  } else if(CURRENT_USER.type === "manager"){
    const fresh = await loadShared(CURRENT_USER.token);
    if(fresh && !fresh.error && fresh.role === "manager"){
      STATE.managers = [{ name: fresh.managerName, token: CURRENT_USER.token, subgestores: fresh.subgestores || [] }];
      STATE.clients = fresh.clients || [];
    }
  }
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

/* ===================== AVISO DE GUARDADO ===================== */
function saveClientAndBadge(client, fields){
  saveClientRemote(client, fields).then(res => showBadge(res.ok));
}
function deleteClientAndBadge(id){
  deleteClientRemote(id).then(ok => showBadge(ok));
}
function addManagerAndBadge(name){
  addManagerRemote(name).then(ok => showBadge(ok));
}
function deleteManagerAndBadge(name){
  deleteManagerRemote(name).then(ok => showBadge(ok));
}
function showBadge(ok){
  showToast(ok ? "Guardado ✓" : "Error al guardar", !ok);
}
function showToast(msg, isErr){
  const b = document.getElementById("savebadge");
  b.textContent = msg;
  b.className = "savebadge show" + (isErr ? " err" : "");
  setTimeout(()=>{ b.className = "savebadge"; }, 1800);
}

function newId(){
  return "c" + Date.now() + Math.floor(Math.random()*1000);
}

/* ===================== CITAS VENCIDAS SIN ACTUALIZAR ===================== */
// Interpreta el texto de fechaCita (normalmente "13/6/2026, 10:00:00",
// el mismo formato que manda GoHighLevel y que se usa al agregar un
// cliente a mano). Si no se puede entender el texto, devuelve null en
// vez de arriesgarse a adivinar mal una fecha.
function parseFechaCita(str){
  if(!str) return null;
  const s = str.toString().trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const [, d, mo, y, h, mi, se] = m;
    const dt = new Date(Number(y), Number(mo)-1, Number(d), Number(h), Number(mi), Number(se||0));
    return isNaN(dt.getTime()) ? null : dt;
  }
  // Formato de respaldo (por si algun dia llega una fecha en formato ISO).
  const dt2 = new Date(s);
  return isNaN(dt2.getTime()) ? null : dt2;
}
// Un cliente cuenta como "vencido y pendiente de completar informacion
// de gestion" cuando: (1) su estado sigue en Activo o Pendiente (nadie
// toco nada despues de que se agendo la cita), y (2) la fecha de esa
// cita ya paso. Si no se pudo leer la fecha, no se marca (mejor no
// avisar de mas que arriesgarse a marcar algo que no corresponde).
function isVencidoPendiente(c){
  if(!ESTADOS_PENDIENTES_GESTION.includes(c.estado)) return false;
  const dt = parseFechaCita(c.fechaCita);
  if(!dt) return false;
  return dt.getTime() < Date.now();
}

/* ===================== DERIVACIONES SIN RESULTADO (+24h) ===================== */
// Un cliente derivado a un sub-gestor cuenta como "alerta" cuando pasaron
// mas de 24h desde que se derivo (c.derivadoEn) y todavia no se registro
// ningun resultado (cambio de estado) DESPUES de esa derivacion. Si se
// registro un resultado antes de esa derivacion (de un ciclo anterior) no
// cuenta: por eso se compara resultadoRegistradoEn contra derivadoEn.
function isDerivacionVencida(c){
  if(!c.subgestorId || !c.derivadoEn) return false;
  if(Date.now() - c.derivadoEn < VEINTICUATRO_HORAS_MS) return false;
  return !c.resultadoRegistradoEn || c.resultadoRegistradoEn < c.derivadoEn;
}

/* ===================== INIT ===================== */
async function init(){
  // Si el link trae "?m=CODIGO", esta persona entro por el link
  // personal de un manager. Guardamos ese codigo en el dispositivo
  // (para que no tenga que reabrir el link cada vez) y limpiamos la
  // URL visible, por prolijidad.
  const params = new URLSearchParams(location.search);
  const urlToken = params.get('m') || '';
  const urlSubgestorToken = params.get('sg') || '';
  if(urlToken){
    saveManagerToken(urlToken);
    history.replaceState({}, '', location.pathname);
  }
  if(urlSubgestorToken){
    saveSubgestorToken(urlSubgestorToken);
    history.replaceState({}, '', location.pathname);
  }
  // Si este dispositivo ya estaba configurado como el de Omar (admin)
  // y no se acaba de tocar un link nuevo, no lo cambiamos a manager (ni
  // a sub-gestor) por accidente aunque alguna vez haya quedado guardado
  // un token viejo.
  const existingLock = loadLock();
  const noPisarAdmin = existingLock && existingLock.type === "admin";
  const managerToken = urlToken || (noPisarAdmin ? "" : loadManagerToken());
  const subgestorToken = urlSubgestorToken || (noPisarAdmin ? "" : loadSubgestorToken());

  if(subgestorToken){
    const shared = await loadShared(subgestorToken);
    if(!shared || shared.error || shared.role !== "subgestor"){
      document.getElementById("root").innerHTML =
        '<div class="lockwrap"><h1>Este link ya no funciona</h1><p>Pídele a tu manager que te envíe tu link actualizado.</p></div>';
      return;
    }
    STATE = { managers: [], clients: shared.clients || [] };
    CURRENT_USER = { type: "subgestor", name: shared.subgestorName, managerName: shared.managerName, token: subgestorToken };
    render();
    return;
  }

  if(managerToken){
    const shared = await loadShared(managerToken);
    if(!shared || shared.error || shared.role !== "manager"){
      document.getElementById("root").innerHTML =
        '<div class="lockwrap"><h1>Este link ya no funciona</h1><p>Pídele a Omar que te envíe tu link actualizado.</p></div>';
      return;
    }
    STATE = { managers: [{name: shared.managerName, token: managerToken, subgestores: shared.subgestores || []}], clients: shared.clients || [] };
    CURRENT_USER = { type: "manager", name: shared.managerName, token: managerToken };
    render();
    // Cada vez que el manager abre su link, si tiene clientes con la
    // cita ya vencida y sin actualizar, se lo avisamos con un mensaje.
    const vencidos = STATE.clients.filter(isVencidoPendiente).length;
    if(vencidos > 0) showPendingUpdateModal(vencidos);
    return;
  }

  // ---- Entrada normal (sin link de manager): pantalla de Admin ----
  const shared = await loadShared();
  if(!shared || shared.error){
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
    if(calendarOpen){
      app.appendChild(renderCalendarioGeneral());
    } else {
      app.appendChild(renderAdminToolbar());
      app.appendChild(renderSummary());
      STATE.managers.forEach(m => app.appendChild(renderManagerCard(m.name, true, m.token)));
    }
  } else if(CURRENT_USER.type === "manager"){
    if(calendarOpen){
      app.appendChild(renderMiHorario());
    } else {
      app.appendChild(renderManagerToolbar());
      app.appendChild(renderCitasHoy(STATE.clients));
      app.appendChild(renderManagerCard(CURRENT_USER.name, false, null));
    }
  } else {
    app.appendChild(renderSubgestorToolbar());
    app.appendChild(renderSubgestorClientList());
  }
  root.appendChild(app);
}

/* ===================== LOCK SCREEN ===================== */
// Ojo: aqui SOLO aparece la entrada del administrador. Los managers
// ya no eligen su nombre de una lista (eso dejaba ver los nombres de
// todos y cualquiera podia entrar como cualquiera). Ahora cada manager
// entra unicamente con su propio link secreto (?m=codigo), que Omar
// le manda por privado. Sin ese link, no hay forma de ver datos de
// ningun manager desde esta pantalla.
function renderLock(){
  const wrap = document.createElement("div");
  wrap.className = "lockwrap";
  wrap.innerHTML = `
  <h1>Gestión de Managers</h1>
  <p>Quantica360</p>
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
  wrap.appendChild(grid);
  const note = document.createElement("p");
  note.style.marginTop = "22px";
  note.style.fontSize = "11.5px";
  note.textContent = "¿Eres manager? Usa el link personal que te mandó Omar — esta pantalla es solo para el administrador.";
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
  const isAdmin = CURRENT_USER.type === "admin";
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>Menú</h3>
  <div class="modalbtns" style="flex-direction:column;">
  ${isAdmin ? '<button class="btnok" id="mnuExport">⬇️ Exportar Excel</button>' : '<button class="btnok" id="mnuExport">⬇️ Exportar mi Excel</button>'}
  ${isAdmin ? '<button class="btnok" id="mnuBackup" style="background:var(--teal-dark);">🗄️ Respaldos</button>' : ''}
  <button class="btncancel" id="mnuInstall">📲 Instrucciones para instalar como app</button>
  ${isAdmin ? '<button class="btndanger" id="mnuLogout">🔒 Cambiar de usuario</button>' : ''}
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#mnuExport").onclick = () => { close(); isAdmin ? exportExcel() : exportMyExcel(); };
  if(isAdmin){
    body.querySelector("#mnuBackup").onclick = () => { close(); openBackupModal(); };
    body.querySelector("#mnuLogout").onclick = () => { close(); confirmLogout(); };
  }
  body.querySelector("#mnuInstall").onclick = () => { close(); openInstallModal(); };
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

/* ===================== AVISO DE CITAS VENCIDAS SIN ACTUALIZAR ===================== */
function showPendingUpdateModal(count){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>⚠️ Actualiza tu información</h3>
  <p style="font-size:14.5px;">Debes actualizar información de <b>${count}</b> cliente${count===1?"":"s"}.</p>
  <p style="font-size:12.5px;color:var(--muted);">Son clientes cuya cita ya pasó y todavía figuran como "Activo" o "Pendiente". Están marcados en rojo en tu lista, más abajo.</p>
  <div class="modalbtns"><button class="btnok" id="pendOk">Entendido</button></div>
  `;
  const close = showModal(body);
  body.querySelector("#pendOk").onclick = close;
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
  const map = {
    "var(--st-activo)":"#2E6FC4","var(--st-pendiente)":"#8A8F98","var(--st-reprogramado)":"#7B4FC9",
    "var(--st-noatendio)":"#8D6346",
    "var(--st-novendio)":"#C4472B","var(--st-vendidopend)":"#D98B1F","var(--st-pagado)":"#1E8A5A"
  };
  return map[varStr] || "#ccc";
}

/* ===================== MANAGER CARD ===================== */
function deleteManager(managerName){
  const count = STATE.clients.filter(c => c.manager === managerName).length;
  const aviso = count > 0
  ? `El manager "${managerName}" tiene ${count} cliente${count===1?"":"s"}. Si lo eliminas, esos clientes también se van a borrar. ¿Seguro que quieres continuar?`
    : `¿Eliminar al manager "${managerName}"? No tiene clientes cargados.`;
  if(!confirm(aviso)) return;
  if(count > 0 && !confirm(`Última confirmación: se van a borrar ${count} cliente${count===1?"":"s"} de "${managerName}" para siempre. ¿Continuar?`)) return;
  STATE.managers = STATE.managers.filter(m => m.name !== managerName);
  STATE.clients = STATE.clients.filter(c => c.manager !== managerName);
  openCards.delete(managerName);
  deleteManagerAndBadge(managerName);
  render();
}

function renderManagerCard(managerName, collapsible, token){
  // Orden de la lista: el cliente cuya cita se AGENDO mas recientemente
  // (campo creadoEn) va arriba, sin importar para que fecha sea esa
  // cita. Asi se puede confirmar de un vistazo que una reserva nueva
  // esta entrando bien por la automatizacion. Los clientes que existian
  // antes de este cambio no tienen creadoEn: quedan despues de
  // cualquier cliente nuevo, en el mismo orden en que ya estaban.
  const clients = STATE.clients
    .filter(c => c.manager === managerName)
    .sort((a,b) => (b.creadoEn||0) - (a.creadoEn||0));
  const card = document.createElement("div");
  card.className = "mgrcard" + (openCards.has(managerName) || !collapsible ? " open" : "");

const head = document.createElement("div");
  head.className = "mgrhead";
  head.innerHTML = `
  <div class="donut" style="${donutStyle(clients)}"></div>
  <div class="info"><b>${managerName}</b><span>${clients.length} cliente${clients.length===1?"":"s"}</span></div>
  ${token ? '<button class="miniBtn" data-x="rename" title="Renombrar manager" style="margin-right:4px;">✏️</button>' : ''}
  ${token ? '<button class="miniBtn" data-x="link" title="Copiar link personal" style="margin-right:4px;">🔗</button>' : ''}
  ${token ? '<button class="miniBtn" data-x="revoke" title="Generar link nuevo (corta el acceso al anterior)" style="margin-right:4px;">🔁</button>' : ''}
  ${collapsible ? '<div class="chev">▾</div>' : ''}
  `;
  if(token){
    head.querySelector('[data-x="rename"]').onclick = (ev) => {
      ev.stopPropagation();
      openRenameManagerModal(managerName);
    };
    head.querySelector('[data-x="link"]').onclick = (ev) => {
      ev.stopPropagation();
      copyManagerLink(token, managerName);
    };
    head.querySelector('[data-x="revoke"]').onclick = (ev) => {
      ev.stopPropagation();
      regenerateManagerLink(managerName);
    };
  }
  if(collapsible){
    head.onclick = async () => {
      if(openCards.has(managerName)){
        openCards.delete(managerName);
        render();
      } else {
        openCards.add(managerName);
        // Antes de mostrar la lista de este manager, traemos los
        // datos mas recientes del servidor (nunca una copia vieja
        // guardada en el dispositivo).
        const fresh = await loadShared();
        if(fresh && !fresh.error){
          STATE = fresh;
          if(!STATE.managers) STATE.managers = [];
          if(!STATE.clients) STATE.clients = [];
        }
        render();
      }
    };
  }
  card.appendChild(head);

const body = document.createElement("div");
  body.className = "mgrbody";

// El botón de agregar/pegar con IA y de eliminar manager son SOLO
// del administrador. Un manager que entra por su link personal solo
// puede gestionar (estado, pago, observaciones) los clientes que Omar
// ya le asignó — no puede agregar clientes nuevos ni borrar managers.
if(CURRENT_USER.type === "admin"){
  const btnrow = document.createElement("div");
  btnrow.className = "cardbtns";
  btnrow.innerHTML = `
  <button class="actionbtn primary" data-act="ai">🤖 Pegar y cargar con IA</button>
  <button class="actionbtn" data-act="manual">➕ Agregar cliente</button>
  <button class="actionbtn" data-act="delmgr" style="color:#c0504d">🗑️ Eliminar manager</button>
  `;
  btnrow.querySelector('[data-act="ai"]').onclick = () => openAiPasteModal(managerName);
  btnrow.querySelector('[data-act="manual"]').onclick = () => openClientForm(managerName, null);
  btnrow.querySelector('[data-act="delmgr"]').onclick = () => deleteManager(managerName);
  body.appendChild(btnrow);
}

// Sub-gestores: los administra el administrador o el propio manager
// dueño de esa cartera. Un sub-gestor nunca ve esta tarjeta (entra por
// su propio link, ver renderSubgestorClientList).
if(CURRENT_USER.type === "admin" || CURRENT_USER.type === "manager"){
  const mgrRecord = STATE.managers.find(m => m.name === managerName);
  const subgestores = (mgrRecord && mgrRecord.subgestores) || [];
  body.appendChild(renderSubgestoresSection(managerName, subgestores));
}

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

/* ===================== SUB-GESTORES (UI) ===================== */
function renderSubgestoresSection(managerName, subgestores){
  const box = document.createElement("div");
  box.className = "sgsection";
  const head = document.createElement("div");
  head.className = "sghead";
  head.innerHTML = `<b>🧑‍💼 Sub-gestores</b><span>${subgestores.length}</span>`;
  const addBtn = document.createElement("button");
  addBtn.className = "miniBtn";
  addBtn.textContent = "➕ Agregar";
  addBtn.onclick = () => openSubgestorForm(managerName, null);
  head.appendChild(addBtn);
  box.appendChild(head);

  if(subgestores.length === 0){
    const empty = document.createElement("div");
    empty.className = "emptynote";
    empty.textContent = "Sin sub-gestores todavía.";
    box.appendChild(empty);
    return box;
  }
  subgestores.forEach(sg => {
    const row = document.createElement("div");
    row.className = "sgrow";
    const info = document.createElement("span");
    info.textContent = sg.nombre + (sg.telefono ? " · " + sg.telefono : "");
    row.appendChild(info);
    const btns = document.createElement("span");
    const linkBtn = document.createElement("button");
    linkBtn.className = "miniBtn"; linkBtn.title = "Copiar link personal"; linkBtn.textContent = "🔗";
    linkBtn.onclick = () => copySubgestorLink(sg.token, sg.nombre);
    const editBtn = document.createElement("button");
    editBtn.className = "miniBtn"; editBtn.title = "Editar"; editBtn.textContent = "✏️";
    editBtn.onclick = () => openSubgestorForm(managerName, sg);
    const delBtn = document.createElement("button");
    delBtn.className = "miniBtn"; delBtn.title = "Eliminar"; delBtn.textContent = "🗑️";
    delBtn.onclick = () => confirmDeleteSubgestor(managerName, sg);
    btns.appendChild(linkBtn); btns.appendChild(editBtn); btns.appendChild(delBtn);
    row.appendChild(btns);
    box.appendChild(row);
  });
  return box;
}

function openSubgestorForm(managerName, existing){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>${existing ? "✏️ Editar sub-gestor" : "➕ Agregar sub-gestor"} — ${esc(managerName)}</h3>
  <label>Nombre</label>
  <input type="text" id="sgNombre" value="${existing ? esc(existing.nombre) : ""}">
  <label>Teléfono</label>
  <input type="tel" id="sgTelefono" value="${existing ? esc(existing.telefono) : ""}">
  <div id="sgErr"></div>
  <div class="modalbtns">
  <button class="btncancel" id="sgCancel">Cancelar</button>
  <button class="btnok" id="sgSave">Guardar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#sgCancel").onclick = close;
  body.querySelector("#sgSave").onclick = async () => {
    const nombre = body.querySelector("#sgNombre").value.trim();
    if(!nombre){ body.querySelector("#sgNombre").focus(); return; }
    const telefono = body.querySelector("#sgTelefono").value.trim();
    const saveBtn = body.querySelector("#sgSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    const res = existing
      ? await updateSubgestorRemote(managerName, existing.id, nombre, telefono)
      : await addSubgestorRemote(managerName, nombre, telefono);
    if(!res.ok){
      body.querySelector("#sgErr").innerHTML = `<div class="dupewarn">⚠️ No se pudo guardar. Intenta de nuevo.</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar";
      return;
    }
    await refreshCurrentView();
    showBadge(true);
    close(); render();
  };
}

function confirmDeleteSubgestor(managerName, sg){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>¿Eliminar sub-gestor?</h3>
  <p style="font-size:13px;color:var(--muted);">${esc(sg.nombre)} se va a eliminar. Si tenía citas derivadas, quedan liberadas (sin sub-gestor) automáticamente para que el manager las pueda reasignar.</p>
  <div class="modalbtns">
  <button class="btncancel" id="dsgNo">Cancelar</button>
  <button class="btndanger" id="dsgYes">Eliminar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#dsgNo").onclick = close;
  body.querySelector("#dsgYes").onclick = async () => {
    const ok = await deleteSubgestorRemote(managerName, sg.id);
    if(!ok){ showToast("No se pudo eliminar", true); close(); return; }
    await refreshCurrentView();
    showBadge(true);
    close(); render();
  };
}

/* ===================== DERIVAR / LIBERAR ===================== */
function openDerivarModal(c){
  const mgrRecord = STATE.managers.find(m => m.name === c.manager);
  const subgestores = (mgrRecord && mgrRecord.subgestores) || [];
  const body = document.createElement("div");
  if(subgestores.length === 0){
    body.innerHTML = `
    <h3>↪️ Derivar — ${esc(c.nombre)}</h3>
    <p style="font-size:12.5px;color:var(--muted);">Este manager todavía no tiene sub-gestores cargados. Agregá uno primero desde la sección "Sub-gestores" de arriba.</p>
    <div class="modalbtns"><button class="btncancel" id="derClose">Cerrar</button></div>
    `;
    const close = showModal(body);
    body.querySelector("#derClose").onclick = close;
    return;
  }
  body.innerHTML = `
  <h3>↪️ Derivar — ${esc(c.nombre)}</h3>
  <p style="font-size:12.5px;color:var(--muted);">Elegí a qué sub-gestor derivar esta cita:</p>
  <div id="sgPickList" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;"></div>
  <div class="modalbtns"><button class="btncancel" id="derCancel">Cancelar</button></div>
  `;
  const close = showModal(body);
  body.querySelector("#derCancel").onclick = close;
  const list = body.querySelector("#sgPickList");
  subgestores.forEach(sg => {
    const btn = document.createElement("button");
    btn.className = "namebtn";
    btn.textContent = sg.nombre + (sg.telefono ? ` — ${sg.telefono}` : "");
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Guardando…";
      const res = await derivarRemote(c.id, sg.id);
      if(!res.ok){
        showToast((res.data && res.data.message) || "No se pudo derivar", true);
        btn.disabled = false;
        btn.textContent = sg.nombre;
        return;
      }
      c.subgestorId = sg.id;
      c.subgestorNombre = sg.nombre;
      c.derivadoEn = Date.now();
      c.resultadoRegistradoEn = 0;
      showBadge(true);
      close(); render();
    };
    list.appendChild(btn);
  });
}

function confirmLiberar(c){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>¿Liberar esta cita?</h3>
  <p style="font-size:13px;color:var(--muted);">${esc(c.nombre)} queda sin sub-gestor asignado. Vas a poder derivarla de nuevo después.</p>
  <div class="modalbtns">
  <button class="btncancel" id="libNo">Cancelar</button>
  <button class="btnok" id="libYes">Sí, liberar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#libNo").onclick = close;
  body.querySelector("#libYes").onclick = async () => {
    const res = await liberarRemote(c.id);
    if(!res.ok){ showToast("No se pudo liberar", true); close(); return; }
    c.subgestorId = "";
    c.subgestorNombre = "";
    c.derivadoEn = 0;
    c.resultadoRegistradoEn = 0;
    showBadge(true);
    close(); render();
  };
}

/* ===================== CITAS DE HOY (vista del manager) ===================== */
// Una cita "es de hoy" cuando su fechaCita cae en el dia calendario de
// hoy (comparando fecha local, no hora). Si no se pudo leer la fecha,
// no cuenta como de hoy (mismo criterio que isVencidoPendiente).
function esCitaHoy(c){
  const dt = parseFechaCita(c.fechaCita);
  if(!dt) return false;
  const hoy = todayStr();
  const ds = dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
  return ds === hoy;
}

function renderCitasHoy(clients){
  const citas = clients
    .filter(esCitaHoy)
    .sort((a,b) => parseFechaCita(a.fechaCita) - parseFechaCita(b.fechaCita));

  const box = document.createElement("div");
  box.className = "summarybox";
  if(citas.length === 0){
    box.innerHTML = `<h3>📅 Citas de hoy</h3><div class="emptynote">Sin citas agendadas para hoy.</div>`;
    return box;
  }
  let rows = "";
  citas.forEach(c => {
    const dt = parseFechaCita(c.fechaCita);
    const hora = dt ? dt.toLocaleTimeString("es", {hour:"2-digit", minute:"2-digit"}) : "";
    const asignado = c.subgestorId ? `Sub-gestor: ${esc(c.subgestorNombre||"")}` : "Sin asignar";
    const alerta = isDerivacionVencida(c) ? ' <span class="derivflag">🟠 +24h sin resultado</span>' : "";
    rows += `<div class="citahoyrow${c.subgestorId?"":" sinasignar"}"><b>${esc(hora)}</b> — ${esc(c.nombre)} <span class="cmeta">(${asignado})</span>${alerta}</div>`;
  });
  box.innerHTML = `<h3>📅 Citas de hoy (${citas.length})</h3>${rows}`;
  return box;
}

/* ===================== CALENDARIO GENERAL / MI HORARIO ===================== */
// Color fijo por manager: siempre el mismo, segun su posicion dentro de
// STATE.managers (los managers nuevos se agregan al final de la lista, asi
// que el color de uno ya existente nunca cambia). Un manager que entra por
// su propio link solo tiene su propio registro en STATE.managers (posicion
// 0), asi que ve su franja con el primer color de la paleta: no importa,
// porque en su vista nunca hay otro manager con el que compararlo.
function managerColor(name){
  const idx = STATE.managers.findIndex(m => m.name === name);
  return MANAGER_PALETTE[(idx >= 0 ? idx : 0) % MANAGER_PALETTE.length];
}

// La direccion es texto libre (viene de contact.full_address de GHL, ej.
// "123 Main St, Reading, PA 19601"). No existe un campo "ciudad" separado,
// asi que se toma el segundo segmento separado por comas. Si no hay
// suficientes comas para confiar en el resultado, se muestra la direccion
// completa en vez de arriesgarse a mostrar algo que no es la ciudad.
function cityFromDireccion(direccion){
  if(!direccion) return "";
  const parts = direccion.toString().split(",").map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : direccion;
}

function addDaysStr(dateStr, n){
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + n);
  return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
}
function buildDayWindow(startStr, n){
  const days = [];
  for(let i=0;i<n;i++) days.push(addDaysStr(startStr, i));
  return days;
}
function dayLabel(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  return dt.toLocaleDateString("es", {weekday:"short", day:"numeric", month:"short"});
}
function minutesOfDay(dt){ return dt.getHours()*60 + dt.getMinutes(); }

// Slots fijos de 30 minutos entre CAL_START_MIN y CAL_END_MIN (8:00 a
// 21:00 -> 27 filas), usados SOLO por la lista de "Mi horario" del manager.
function buildTimeSlots(){
  const slots = [];
  for(let m = CAL_START_MIN; m <= CAL_END_MIN; m += 30) slots.push(m);
  return slots;
}
// A que slot de 30min pertenece una cita: se redondea hacia abajo al slot
// en el que cae (ej. 9:45 -> fila de las 9:30). Una cita antes de las 8am o
// despues de las 9pm se "pega" al primer/ultimo slot en vez de perderse.
function slotForMinutes(mins){
  const clamped = Math.max(CAL_START_MIN, Math.min(CAL_END_MIN, mins));
  return Math.floor((clamped - CAL_START_MIN) / 30) * 30 + CAL_START_MIN;
}
function formatSlotLabel(mins){
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 < 12 ? "am" : "pm";
  let h12 = h24 % 12;
  if(h12 === 0) h12 = 12;
  return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
}

// Citas de un manager en un dia especifico, ya parseadas y ordenadas por
// hora. "source" es la lista de clientes donde buscar (STATE.clients: para
// el admin trae a todo el mundo, para un manager el backend ya se lo filtro
// a solo los suyos, asi que no hace falta filtrar de nuevo aqui).
function clientsForManagerDay(managerName, dayStr, source){
  return source
    .filter(c => c.manager === managerName)
    .map(c => ({ c, dt: parseFechaCita(c.fechaCita) }))
    .filter(x => x.dt)
    .filter(x => {
      const ds = x.dt.getFullYear()+"-"+String(x.dt.getMonth()+1).padStart(2,"0")+"-"+String(x.dt.getDate()).padStart(2,"0");
      return ds === dayStr;
    })
    .sort((a,b) => a.dt - b.dt);
}

// Calcula, para un grupo de citas de un mismo manager+dia (ya ordenadas por
// hora), en que "columna" angosta va cada una cuando se solapan con otras
// (misma hora o rango de 60min cruzado), para dibujarlas lado a lado en vez
// de apiladas. Devuelve un array paralelo a "items" con {colIndex, colCount}.
function layoutOverlaps(items){
  const n = items.length;
  const result = items.map(() => ({colIndex:0, colCount:1}));
  if(n === 0) return result;
  const starts = items.map(x => x.dt.getTime());
  const ends = starts.map(s => s + CAL_BLOCK_MIN*60000);

  function assignCluster(from, to){
    const colEndTimes = [];
    for(let i=from;i<to;i++){
      let col = colEndTimes.findIndex(e => e <= starts[i]);
      if(col === -1){ col = colEndTimes.length; colEndTimes.push(ends[i]); }
      else { colEndTimes[col] = ends[i]; }
      result[i].colIndex = col;
    }
    const colCount = colEndTimes.length;
    for(let i=from;i<to;i++) result[i].colCount = colCount;
  }

  let clusterStart = 0;
  let clusterMaxEnd = ends[0];
  for(let i=1;i<=n;i++){
    if(i === n || starts[i] >= clusterMaxEnd){
      assignCluster(clusterStart, i);
      if(i < n){ clusterStart = i; clusterMaxEnd = ends[i]; }
    } else {
      clusterMaxEnd = Math.max(clusterMaxEnd, ends[i]);
    }
  }
  return result;
}

// Abre la ficha completa del cliente (la misma tarjeta que se usa en la
// lista normal, con los mismos permisos segun el rol) dentro de un modal,
// para poder gestionarla sin salir de la vista de calendario.
function openClientDetailModal(c){
  const body = document.createElement("div");
  body.className = "modalhead";
  const closeBtn = document.createElement("button");
  closeBtn.className = "closeX";
  closeBtn.textContent = "✕";
  body.appendChild(closeBtn);
  body.appendChild(renderClientCard(c));
  const close = showModal(body);
  closeBtn.onclick = close;
}

// Componente compartido: dibuja la franja de horario (3 dias visibles,
// "Ver siguientes" desliza la ventana de a 3) para la lista de managers que
// se le pase. Con un solo nombre (vista del manager) dibuja una sola fila.
function renderCalendarStrip(title, managerNames){
  const wrap = document.createElement("div");
  wrap.className = "calendarWrap";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar calToolbar";
  const backBtn = document.createElement("button");
  backBtn.className = "toolbtn";
  backBtn.textContent = "⬅ Volver";
  backBtn.onclick = () => { calendarOpen = false; render(); };
  const nextBtn = document.createElement("button");
  nextBtn.className = "toolbtn";
  nextBtn.textContent = "Ver siguientes ▶";
  nextBtn.onclick = () => { calendarStart = addDaysStr(calendarStart, 3); render(); };
  toolbar.appendChild(backBtn);
  toolbar.appendChild(nextBtn);
  wrap.appendChild(toolbar);

  const h = document.createElement("h3");
  h.style.cssText = "margin:0 0 10px;font-size:14px;";
  h.textContent = title;
  wrap.appendChild(h);

  const days = buildDayWindow(calendarStart, 3);

  const gridOuter = document.createElement("div");
  gridOuter.className = "calGridOuter";
  const grid = document.createElement("div");
  grid.className = "calGrid";
  grid.style.gridTemplateColumns = "110px repeat(" + days.length + ", minmax(105px,1fr))";

  const corner = document.createElement("div");
  corner.className = "calCorner";
  grid.appendChild(corner);
  days.forEach(d => {
    const dh = document.createElement("div");
    dh.className = "calDayHead";
    dh.textContent = dayLabel(d);
    grid.appendChild(dh);
  });

  managerNames.forEach(name => {
    const nameCell = document.createElement("div");
    nameCell.className = "calMgrName";
    nameCell.innerHTML = `<span class="calSwatch" style="background:${managerColor(name)}"></span>${esc(name)}`;
    grid.appendChild(nameCell);

    days.forEach(dayStr => {
      const cell = document.createElement("div");
      cell.className = "calCell";
      const items = clientsForManagerDay(name, dayStr, STATE.clients);
      const layout = layoutOverlaps(items);
      items.forEach((it, i) => {
        const {colIndex, colCount} = layout[i];
        const mins = minutesOfDay(it.dt);
        const topPct = ((mins - CAL_START_MIN) / (CAL_END_MIN - CAL_START_MIN)) * 100;
        const heightPct = (CAL_BLOCK_MIN / (CAL_END_MIN - CAL_START_MIN)) * 100;
        const block = document.createElement("div");
        block.className = "calBlock";
        block.style.top = topPct + "%";
        block.style.height = heightPct + "%";
        block.style.left = (colIndex * 100 / colCount) + "%";
        block.style.width = (100 / colCount) + "%";
        block.style.background = managerColor(name);
        block.innerHTML = `${esc(it.c.nombre)}<span class="calCity">${esc(cityFromDireccion(it.c.direccion))}</span>`;
        block.onclick = () => openClientDetailModal(it.c);
        cell.appendChild(block);
      });
      grid.appendChild(cell);
    });
  });

  gridOuter.appendChild(grid);
  wrap.appendChild(gridOuter);
  return wrap;
}

// Vista del administrador: una fila por CADA manager (las citas derivadas a
// un sub-gestor, o reasignadas a otro manager, aparecen solas bajo el
// nombre del manager dueño ACTUAL, porque client.manager ya refleja eso).
function renderCalendarioGeneral(){
  if(!calendarStart) calendarStart = todayStr();
  const names = STATE.managers.map(m => m.name).sort((a,b) => a.localeCompare(b));
  return renderCalendarStrip("📅 Calendario General de Managers", names);
}

// Vista del manager (entra por su link personal): lista tipo hoja de
// calculo, una fila fija por cada media hora de 8:00 a 21:00 (con huecos
// vacios visibles), en vez del formato de barras del Calendario General.
// STATE.clients ya viene filtrado por el backend a solo sus propios
// clientes, asi que nunca puede ver la agenda de otro manager desde aqui.
function renderMiHorario(){
  return renderMiHorarioLista();
}

function renderMiHorarioLista(){
  if(!calendarStart) calendarStart = todayStr();
  const wrap = document.createElement("div");
  wrap.className = "calendarWrap";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar calToolbar";
  const backBtn = document.createElement("button");
  backBtn.className = "toolbtn";
  backBtn.textContent = "⬅ Volver";
  backBtn.onclick = () => { calendarOpen = false; render(); };
  const nextBtn = document.createElement("button");
  nextBtn.className = "toolbtn";
  nextBtn.textContent = "Ver siguientes ▶";
  nextBtn.onclick = () => { calendarStart = addDaysStr(calendarStart, 3); render(); };
  toolbar.appendChild(backBtn);
  toolbar.appendChild(nextBtn);
  wrap.appendChild(toolbar);

  const h = document.createElement("h3");
  h.style.cssText = "margin:0 0 10px;font-size:14px;";
  h.textContent = "📅 Mi horario — " + CURRENT_USER.name;
  wrap.appendChild(h);

  const days = buildDayWindow(calendarStart, 3);
  const slots = buildTimeSlots();

  const cols = document.createElement("div");
  cols.className = "miHorarioCols";

  days.forEach(dayStr => {
    const items = clientsForManagerDay(CURRENT_USER.name, dayStr, STATE.clients);
    const bySlot = new Map();
    items.forEach(it => {
      const slot = slotForMinutes(minutesOfDay(it.dt));
      if(!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(it);
    });

    const col = document.createElement("div");
    col.className = "miHorarioCol";
    const colHead = document.createElement("div");
    colHead.className = "miHorarioColHead";
    colHead.textContent = dayLabel(dayStr);
    col.appendChild(colHead);

    slots.forEach(slotMin => {
      const row = document.createElement("div");
      row.className = "miHorarioSlot";
      const timeEl = document.createElement("span");
      timeEl.className = "miHorarioTime";
      timeEl.textContent = formatSlotLabel(slotMin);
      row.appendChild(timeEl);

      const entryWrap = document.createElement("div");
      entryWrap.className = "miHorarioEntries";
      const entries = bySlot.get(slotMin) || [];
      entries.forEach(it => {
        const entry = document.createElement("div");
        entry.className = "miHorarioEntry";
        entry.innerHTML = `${esc(it.c.nombre)}<span class="miHorarioCity">${esc(cityFromDireccion(it.c.direccion))}</span>`;
        entry.onclick = () => openClientDetailModal(it.c);
        entryWrap.appendChild(entry);
      });
      row.appendChild(entryWrap);
      col.appendChild(row);
    });

    cols.appendChild(col);
  });

  wrap.appendChild(cols);
  return wrap;
}

/* ===================== CLIENT CARD ===================== */
function renderClientCard(c){
  const isAdmin = CURRENT_USER.type === "admin";
  const isManager = CURRENT_USER.type === "manager";
  const isSubgestor = CURRENT_USER.type === "subgestor";
  const vencido = isVencidoPendiente(c);
  const derivVencida = isDerivacionVencida(c);
  const el = document.createElement("div");
  el.className = "clientcard" + (vencido ? " vencido" : "") + (derivVencida ? " alertaderiv" : "");
  const telHref = c.telefono ? `tel:${c.telefono.replace(/[^0-9+]/g,"")}` : "#";
  el.innerHTML = `
  <div class="cname">${esc(c.nombre)}</div>
  <div class="cmeta">
  ${c.telefono ? `📞 <a href="${telHref}">${esc(c.telefono)}</a><br>` : ""}
  ${c.direccion ? `📍 ${esc(c.direccion)}<br>` : ""}
  ${c.fechaCita ? `🗓️ ${esc(c.fechaCita)}<br>` : ""}
  ${c.idioma ? `🗣️ Idioma: ${esc(c.idioma)}<br>` : ""}
  ${c.notas ? `📝 ${esc(c.notas)}` : ""}
  </div>
  ${vencido ? '<div class="vencidoflag">🔴 Cita vencida sin actualizar</div>' : ""}
  ${derivVencida ? '<div class="derivflag">🟠 Derivada hace más de 24h sin resultado</div>' : ""}
  ${c.revisar ? '<div class="revisarflag">⚠️ Revisar: estado heredado del sistema anterior</div>' : ""}
  `;

// Quién tiene esta cita: solo lo ve/edita el admin o el manager (el
// sub-gestor ya sabe que la tiene, no necesita verlo en su propia
// pantalla). Muestra si esta sin asignar (para poder derivarla) o a
// que sub-gestor esta asignada (con boton para liberarla).
if(isAdmin || isManager){
  const asigWrap = document.createElement("div");
  asigWrap.className = "asigwrap";
  if(c.subgestorId){
    const badge = document.createElement("span");
    badge.className = "asignadoflag";
    badge.textContent = "👤 Asignado a: " + (c.subgestorNombre || "");
    asigWrap.appendChild(badge);
    const libBtn = document.createElement("button");
    libBtn.className = "miniBtn";
    libBtn.textContent = "🔓 Liberar";
    libBtn.onclick = () => confirmLiberar(c);
    asigWrap.appendChild(libBtn);
  } else {
    const badge = document.createElement("span");
    badge.className = "sinasignarflag";
    badge.textContent = "⚪ Sin asignar";
    asigWrap.appendChild(badge);
    const derBtn = document.createElement("button");
    derBtn.className = "miniBtn";
    derBtn.textContent = "↪️ Derivar";
    derBtn.onclick = () => openDerivarModal(c);
    asigWrap.appendChild(derBtn);
  }
  el.appendChild(asigWrap);
}

const srow = document.createElement("div");
  srow.className = "statusrow";
  ESTADOS.forEach(e => {
    const pill = document.createElement("button");
    pill.className = "statuspill" + (c.estado===e ? " active":"");
    pill.textContent = e;
    if(c.estado===e) pill.style.background = ESTADO_COLOR[e];
    pill.onclick = () => {
      // "Pagado" es especial: no se guarda directo, primero hay que
      // llenar día, monto y forma de pago en una ventana obligatoria.
      if(e === "Pagado"){ openPagoModal(c); return; }
      c.estado = e;
      c.revisar = false;
      saveClientAndBadge(c, ['estado','revisar']);
      render();
    };
    srow.appendChild(pill);
  });
  el.appendChild(srow);

// Resumen de los datos del pago, si ya se marcó como Pagado. El
// botón de lápiz deja corregir un dato sin tener que desmarcar el
// estado (por ejemplo, si se equivocaron en el monto).
if(c.estado === "Pagado"){
  const pagoInfo = document.createElement("div");
  pagoInfo.innerHTML = `<span class="paydateset">💰 $${esc(String(c.pagoMonto||""))} · ${c.pagoFecha ? formatDate(c.pagoFecha) : "?"} · ${esc(c.pagoForma||"")}
  <button data-x="editpago">✏️</button></span>`;
  pagoInfo.querySelector('[data-x="editpago"]').onclick = () => openPagoModal(c);
  el.appendChild(pagoInfo);
}

const payWrap = document.createElement("div");
  if(c.fechaPago){
    payWrap.innerHTML = `<span class="paydateset">📅 Fecha de pago: ${formatDate(c.fechaPago)}
    <button data-x="clr">✕</button></span>`;
    payWrap.querySelector('[data-x="clr"]').onclick = () => {
      c.fechaPago = "";
      saveClientAndBadge(c, ['fechaPago']);
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

// Observaciones: campo libre, siempre visible, disponible tanto para
// el administrador como para el manager (no cuenta como "editar
// cliente" — es parte del resultado de gestión).
const obsWrap = document.createElement("div");
  const obsBtn = document.createElement("button");
  obsBtn.className = "miniBtn";
  obsBtn.textContent = c.observaciones ? "📝 Observaciones ✓" : "📝 Observaciones";
  obsBtn.onclick = () => openObservacionesModal(c);
  obsWrap.appendChild(obsBtn);
  obsWrap.style.marginTop = "8px";
  el.appendChild(obsWrap);
  if(c.observaciones){
    const obsPreview = document.createElement("div");
    obsPreview.className = "cmeta";
    obsPreview.style.marginTop = "4px";
    obsPreview.textContent = "📝 " + c.observaciones;
    el.appendChild(obsPreview);
  }

// Editar y Eliminar son SOLO del administrador. Un manager puede
// gestionar (estado, pago, observaciones) pero no puede cambiar los
// datos base del cliente ni borrarlo.
if(isAdmin){
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
  // El boton de "Cambiar de manager" aparece en todos los clientes,
  // solo para el administrador (esta dentro del bloque isAdmin). Deja
  // reasignar cualquier cliente a otro manager en cualquier momento.
  const chgBtn = document.createElement("button");
  chgBtn.className = "miniBtn";
  chgBtn.textContent = "🔀 Cambiar de manager";
  chgBtn.onclick = () => openChangeManagerModal(c);
  actions.appendChild(chgBtn);
  el.appendChild(actions);
}

// El sub-gestor puede editar la ficha completa (nombre, telefono,
// direccion, idioma, notas) del cliente que tiene asignado, pero no
// puede eliminarlo ni cambiarlo de manager.
if(isSubgestor){
  const actions = document.createElement("div");
  actions.className = "cactions";
  const editBtn = document.createElement("button");
  editBtn.className = "miniBtn";
  editBtn.textContent = "✏️ Editar datos";
  editBtn.onclick = () => openSubgestorEditForm(c);
  actions.appendChild(editBtn);
  el.appendChild(actions);
}

return el;
}

/* ===================== VENTANA DE PAGADO (obligatoria) ===================== */
function openPagoModal(c){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>💰 Marcar como Pagado — ${esc(c.nombre)}</h3>
  <p style="font-size:12.5px;color:var(--muted);">Estos 3 datos son obligatorios para poder guardar el pago.</p>
  <label>Día del pago</label>
  <input type="date" id="pgFecha" value="${esc(c.pagoFecha || todayStr())}">
  <label>Monto pagado (USD)</label>
  <input type="number" id="pgMonto" min="0" step="0.01" placeholder="ej. 150" value="${esc(String(c.pagoMonto||""))}">
  <label>Forma de pago</label>
  <select id="pgForma">
  <option value="">Selecciona...</option>
  <option value="A través de la compañía" ${c.pagoForma==="A través de la compañía"?"selected":""}>A través de la compañía</option>
  <option value="Zelle" ${c.pagoForma==="Zelle"?"selected":""}>Zelle</option>
  </select>
  <div id="pgErr"></div>
  <div class="modalbtns">
  <button class="btncancel" id="pgCancel">Cancelar</button>
  <button class="btnok" id="pgSave">Guardar pago</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#pgCancel").onclick = close;
  body.querySelector("#pgSave").onclick = async () => {
    const fecha = body.querySelector("#pgFecha").value;
    const monto = body.querySelector("#pgMonto").value;
    const forma = body.querySelector("#pgForma").value;
    if(!fecha || !monto || Number(monto) <= 0 || !forma){
      body.querySelector("#pgErr").innerHTML =
        `<div class="dupewarn">⚠️ Completa día, monto y forma de pago para poder guardar.</div>`;
      return;
    }
    const saveBtn = body.querySelector("#pgSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    c.estado = "Pagado";
    c.pagoFecha = fecha;
    c.pagoMonto = Number(monto);
    c.pagoForma = forma;
    c.revisar = false;
    const res = await saveClientRemote(c, ['estado','pagoFecha','pagoMonto','pagoForma','revisar']);
    if(!res.ok){
      body.querySelector("#pgErr").innerHTML =
        `<div class="dupewarn">⚠️ No se pudo guardar. Intenta de nuevo.</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar pago";
      return;
    }
    showBadge(true);
    close(); render();
  };
}

/* ===================== OBSERVACIONES (libre, siempre visible) ===================== */
function openObservacionesModal(c){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>📝 Observaciones — ${esc(c.nombre)}</h3>
  <label>Texto libre</label>
  <textarea id="obsText" rows="5">${esc(c.observaciones)}</textarea>
  <div class="modalbtns">
  <button class="btncancel" id="obsCancel">Cancelar</button>
  <button class="btnok" id="obsSave">Guardar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#obsCancel").onclick = close;
  body.querySelector("#obsSave").onclick = async () => {
    const saveBtn = body.querySelector("#obsSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    c.observaciones = body.querySelector("#obsText").value.trim();
    const res = await saveClientRemote(c, ['observaciones']);
    showBadge(res.ok);
    close(); render();
  };
}
/* ===================== CAMBIAR DE MANAGER (solo calendarios compartidos) ===================== */
function openChangeManagerModal(c){
    const body = document.createElement("div");
    const opciones = STATE.managers
          .map(m => m.name)
          .filter(n => n !== c.manager)
          .sort((a,b)=>a.localeCompare(b));
    body.innerHTML = `
      <h3>🔀 Cambiar de manager — ${esc(c.nombre)}</h3>
        <p style="font-size:12.5px;color:var(--muted);">Manager actual: <b>${esc(c.manager)}</b>. Elige el nuevo manager:</p>
          <div id="mgrPickList" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;"></div>
            <div class="modalbtns">
              <button class="btncancel" id="chgCancel">Cancelar</button>
                </div>
                  `;
    const close = showModal(body);
    body.querySelector("#chgCancel").onclick = close;
    const list = body.querySelector("#mgrPickList");
    opciones.forEach(nombreManager => {
          const btn = document.createElement("button");
          btn.className = "namebtn";
          btn.textContent = nombreManager;
          btn.onclick = async () => {
                  btn.disabled = true;
                  btn.textContent = "Guardando…";
                  // Si esta cita estaba derivada a un sub-gestor del manager
                  // ANTERIOR, hay que liberarla: un sub-gestor pertenece a un
                  // solo manager, asi que no puede quedar viendo un cliente
                  // que ya paso a otro manager distinto.
                  const teniaSubgestor = !!c.subgestorId;
                  c.manager = nombreManager;
            c.creadoEn = Date.now();
                  const res = await saveClientRemote(c, ['nombre','manager','creadoEn']);
                  if(res.ok && teniaSubgestor){
                    await liberarRemote(c.id);
                    c.subgestorId = "";
                    c.subgestorNombre = "";
                    c.derivadoEn = 0;
                    c.resultadoRegistradoEn = 0;
                  }
                  showBadge(res.ok);
                  close();
                  render();
          };
          list.appendChild(btn);
    });
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
    if(v){ c.fechaPago = v; saveClientAndBadge(c, ['fechaPago']); }
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
    deleteClientAndBadge(c.id);
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
  body.querySelector("#cfSave").onclick = async () => {
    const nombre = body.querySelector("#cfNombre").value.trim();
    if(!nombre){ body.querySelector("#cfNombre").focus(); return; }
    const data = {
      nombre,
      telefono: body.querySelector("#cfTelefono").value.trim(),
      direccion: body.querySelector("#cfDireccion").value.trim(),
      fechaCita: body.querySelector("#cfFecha").value.trim(),
      idioma: body.querySelector("#cfIdioma").value.trim(),
      notas: body.querySelector("#cfNotas").value.trim(),
    };
    const saveBtn = body.querySelector("#cfSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    const dupeBox = body.querySelector("#cfDupe");
    dupeBox.innerHTML = "";
    // El servidor es quien decide si es duplicado (mira TODOS los
    // clientes, no solo los que ya estan cargados en esta pantalla), y
    // NO deja guardar si lo es: no hay boton para "guardar de todas
    // formas". Por eso mandamos directo a guardar y recien ahi miramos
    // si vino un error de duplicado.
    const payload = existing
      ? { ...existing, ...data }
      : { manager: managerName, estado:"Pendiente", fechaPago:"", pagoFecha:"", pagoMonto:"", pagoForma:"", observaciones:"", revisar:false, ...data };
    const res = await saveClientRemote(payload);
    if(!res.ok){
      if(res.data && res.data.error === "duplicate_client"){
        dupeBox.innerHTML = `<div class="dupewarn">🚫 No se puede, cliente duplicado en el manager ${esc(res.data.managerName || "")}.</div>`;
      } else {
        dupeBox.innerHTML = `<div class="dupewarn">⚠️ No se pudo guardar. Intenta de nuevo.</div>`;
      }
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar";
      return;
    }
    showBadge(true);
    if(existing){
      Object.assign(existing, data);
    } else if(res.data && res.data.client){
      STATE.clients.push(res.data.client);
    }
    close(); render();
  };
}
function esc(s){ return (s||"").toString().replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

/* ===================== EDITAR DATOS (sub-gestor) ===================== */
// Version reducida de openClientForm para el sub-gestor: puede editar
// nombre/telefono/direccion/idioma/notas del cliente que tiene asignado,
// pero no ve ni puede tocar el manager (eso queda fijo).
function openSubgestorEditForm(c){
  const body = document.createElement("div");
  body.className = "modalhead";
  body.innerHTML = `
  <button class="closeX" id="sgfX">✕</button>
  <h3>Editar datos — ${esc(c.nombre)}</h3>
  <label>Nombre completo</label>
  <input type="text" id="sgfNombre" value="${esc(c.nombre)}">
  <label>Teléfono</label>
  <input type="tel" id="sgfTelefono" value="${esc(c.telefono)}">
  <label>Dirección</label>
  <input type="text" id="sgfDireccion" value="${esc(c.direccion)}">
  <label>Idioma preferido</label>
  <input type="text" id="sgfIdioma" placeholder="Español / Inglés" value="${esc(c.idioma)}">
  <label>Notas</label>
  <textarea id="sgfNotas">${esc(c.notas)}</textarea>
  <div id="sgfDupe"></div>
  <div class="modalbtns">
  <button class="btncancel" id="sgfCancel">Cancelar</button>
  <button class="btnok" id="sgfSave">Guardar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#sgfX").onclick = close;
  body.querySelector("#sgfCancel").onclick = close;
  body.querySelector("#sgfSave").onclick = async () => {
    const nombre = body.querySelector("#sgfNombre").value.trim();
    if(!nombre){ body.querySelector("#sgfNombre").focus(); return; }
    const data = {
      id: c.id,
      nombre,
      telefono: body.querySelector("#sgfTelefono").value.trim(),
      direccion: body.querySelector("#sgfDireccion").value.trim(),
      idioma: body.querySelector("#sgfIdioma").value.trim(),
      notas: body.querySelector("#sgfNotas").value.trim(),
    };
    const saveBtn = body.querySelector("#sgfSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    const dupeBox = body.querySelector("#sgfDupe");
    dupeBox.innerHTML = "";
    const res = await saveClientRemote(data);
    if(!res.ok){
      if(res.data && res.data.error === "duplicate_client"){
        dupeBox.innerHTML = `<div class="dupewarn">🚫 No se puede, cliente duplicado en el manager ${esc(res.data.managerName || "")}.</div>`;
      } else {
        dupeBox.innerHTML = `<div class="dupewarn">⚠️ No se pudo guardar. Intenta de nuevo.</div>`;
      }
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar";
      return;
    }
    showBadge(true);
    Object.assign(c, data);
    close(); render();
  };
}

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
      const candidatos = parsed.filter(p => p.nombre).map(p => ({
        manager: managerName, estado:"Pendiente", fechaPago:"", pagoFecha:"", pagoMonto:"", pagoForma:"", observaciones:"", revisar:false,
        nombre: p.nombre || "", telefono: p.telefono || "", direccion: p.direccion || "",
        fechaCita: p.fechaCita || "", idioma: p.idioma || "", notas: p.notas || ""
      }));
      let added = 0;
      const skipped = [];
      // Se guardan de a uno, no todos a la vez: asi, si dos clientes
      // del mismo texto pegado son en realidad la misma persona, el
      // servidor ya tiene guardado al primero cuando revisa al
      // segundo, y tambien lo detecta como duplicado.
      for(const nc of candidatos){
        const res = await saveClientRemote(nc);
        if(res.ok && res.data && res.data.client){
          STATE.clients.push(res.data.client);
          added++;
        } else if(res.data && res.data.error === "duplicate_client"){
          skipped.push(`${nc.nombre} (ya está con ${res.data.managerName})`);
        } else {
          skipped.push(`${nc.nombre} (no se pudo guardar)`);
        }
      }
      let msg = `<div class="helptext">✅ ${added} cliente(s) agregado(s).`;
      if(skipped.length) msg += ` Omitidos por duplicado: ${skipped.join("; ")}.`;
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
  <button class="toolbtn" id="tbRefresh">🔄 Actualizar ahora</button>
  <button class="toolbtn" id="tbAddMgr">➕ Agregar manager</button>
  <button class="toolbtn" id="tbCalendar">📅 Calendario General</button>
  <button class="toolbtn" id="tbExport">⬇️ Exportar Excel</button>
  <button class="toolbtn" id="tbBackup">🗄️ Respaldos</button>
  `;
  box.querySelector("#tbRefresh").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.textContent = "🔄 Actualizando…";
    btn.disabled = true;
    const fresh = await loadShared();
    if(fresh && !fresh.error){
      STATE = fresh;
      if(!STATE.managers) STATE.managers = [];
      if(!STATE.clients) STATE.clients = [];
    }
    render();
  };
  box.querySelector("#tbAddMgr").onclick = openAddManagerModal;
  box.querySelector("#tbCalendar").onclick = () => {
    calendarOpen = true;
    if(!calendarStart) calendarStart = todayStr();
    render();
  };
  box.querySelector("#tbExport").onclick = exportExcel;
  box.querySelector("#tbBackup").onclick = openBackupModal;
  return box;
}

/* ===================== TOOLBAR DEL MANAGER ===================== */
function renderManagerToolbar(){
  const box = document.createElement("div");
  box.className = "toolbar";
  box.innerHTML = `
  <button class="toolbtn" id="tbRefresh">🔄 Actualizar ahora</button>
  <button class="toolbtn" id="tbCalendar">📅 Mi horario</button>
  <button class="toolbtn" id="tbExport">⬇️ Exportar mi Excel</button>
  `;
  box.querySelector("#tbRefresh").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.textContent = "🔄 Actualizando…";
    btn.disabled = true;
    const fresh = await loadShared(CURRENT_USER.token);
    if(fresh && !fresh.error && fresh.role === "manager"){
      STATE.clients = fresh.clients || [];
    }
    render();
  };
  box.querySelector("#tbCalendar").onclick = () => {
    calendarOpen = true;
    if(!calendarStart) calendarStart = todayStr();
    render();
  };
  box.querySelector("#tbExport").onclick = exportMyExcel;
  return box;
}

/* ===================== TOOLBAR Y LISTA DEL SUB-GESTOR ===================== */
function renderSubgestorToolbar(){
  const box = document.createElement("div");
  box.className = "toolbar";
  box.innerHTML = `
  <button class="toolbtn" id="tbRefresh">🔄 Actualizar ahora</button>
  <button class="toolbtn" id="tbExport">⬇️ Exportar mi Excel</button>
  `;
  box.querySelector("#tbRefresh").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.textContent = "🔄 Actualizando…";
    btn.disabled = true;
    const fresh = await loadShared(CURRENT_USER.token);
    if(fresh && !fresh.error && fresh.role === "subgestor"){
      STATE.clients = fresh.clients || [];
    }
    render();
  };
  box.querySelector("#tbExport").onclick = exportMyExcel;
  return box;
}

function renderSubgestorClientList(){
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.style.fontSize = "14px";
  title.style.margin = "0 0 10px";
  title.textContent = `Mis clientes asignados (${STATE.clients.length})`;
  wrap.appendChild(title);
  const list = document.createElement("div");
  list.className = "clientlist";
  if(STATE.clients.length === 0){
    list.innerHTML = `<div class="emptynote">Todavía no tenés clientes asignados.</div>`;
  } else {
    // Las citas de HOY van primero, en orden por hora (la mas temprana
    // arriba), separadas con su propio titulo para que queden bien
    // destacadas. El resto del historial queda despues, con su propio
    // titulo, en el orden en que ya venia.
    const deHoy = STATE.clients.filter(esCitaHoy).sort((a,b) => parseFechaCita(a.fechaCita) - parseFechaCita(b.fechaCita));
    const resto = STATE.clients.filter(c => !esCitaHoy(c));
    if(deHoy.length > 0){
      const hoyTitle = document.createElement("div");
      hoyTitle.className = "listsubtitle";
      hoyTitle.textContent = `📅 Hoy (${deHoy.length})`;
      list.appendChild(hoyTitle);
      deHoy.forEach(c => list.appendChild(renderClientCard(c)));
    }
    if(resto.length > 0){
      if(deHoy.length > 0){
        const restoTitle = document.createElement("div");
        restoTitle.className = "listsubtitle";
        restoTitle.textContent = "Historial";
        list.appendChild(restoTitle);
      }
      resto.forEach(c => list.appendChild(renderClientCard(c)));
    }
  }
  wrap.appendChild(list);
  return wrap;
}

// Copia al portapapeles el link personal de un manager, para que Omar
// se lo mande por WhatsApp/mensaje directo. Con navegadores viejos o
// sin permiso de portapapeles, muestra el link en una ventanita para
// copiarlo a mano.
function copyRoleLink(token, name, param){
  const link = location.origin + "/?" + param + "=" + token;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(
      () => showToast("Link de " + name + " copiado ✓"),
      () => window.prompt("Copia este link y envíaselo a " + name + ":", link)
    );
  } else {
    window.prompt("Copia este link y envíaselo a " + name + ":", link);
  }
}
function copyManagerLink(token, name){ copyRoleLink(token, name, "m"); }
function copySubgestorLink(token, name){ copyRoleLink(token, name, "sg"); }

// Corta el acceso al link viejo de un manager y genera uno nuevo. El
// manager y sus clientes NO se tocan — solo cambia el codigo secreto.
// Si esa persona tenia el link guardado, va a dejar de funcionarle de
// inmediato y va a necesitar que le mandes el link nuevo.
async function regenerateManagerLink(name){
  const ok = confirm(
    `¿Generar un link nuevo para "${name}"?\n\nEl link anterior deja de funcionar AL INSTANTE. Si ${name} ya lo tenía guardado en su celular, no va a poder entrar hasta que le mandes el link nuevo.`
  );
  if(!ok) return;
  try{
    const r = await fetch('/api/manager', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({name, regenerateToken:true})
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok || !data.ok){ showToast("No se pudo generar el link nuevo", true); return; }
    const fresh = await loadShared();
    if(fresh && !fresh.error){
      STATE = fresh;
      if(!STATE.managers) STATE.managers = [];
      if(!STATE.clients) STATE.clients = [];
    }
    render();
    if(data.manager && data.manager.token){
      copyManagerLink(data.manager.token, name);
    }
  }catch(e){
    showToast("No se pudo generar el link nuevo", true);
  }
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
  body.querySelector("#amSave").onclick = async () => {
    const name = body.querySelector("#mgrName").value.trim();
    if(!name) return;
    if(STATE.managers.some(m => m.name === name)){ alert("Ese manager ya existe."); return; }
    const saveBtn = body.querySelector("#amSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Agregando…";
    const ok = await addManagerRemote(name);
    // Volvemos a pedir todo al servidor: asi conseguimos el codigo
    // secreto (link) que el servidor acaba de generar para este
    // manager nuevo, en vez de adivinarlo en la pantalla.
    const fresh = ok ? await loadShared() : null;
    if(fresh && !fresh.error){
      STATE = fresh;
      if(!STATE.managers) STATE.managers = [];
      if(!STATE.clients) STATE.clients = [];
    }
    showBadge(!!ok);
    close(); render();
  };
}

/* ===================== RENOMBRAR MANAGER ===================== */
// Cambia el nombre de un manager sin perder ningun dato: mantiene el
// mismo link personal (token) y reasigna automaticamente a TODOS sus
// clientes al nombre nuevo. El servidor es quien hace el cambio real;
// aca solo se le pide y se refresca la pantalla con lo que confirme.
function openRenameManagerModal(oldName){
  const body = document.createElement("div");
  body.innerHTML = `
  <h3>✏️ Renombrar manager</h3>
  <p style="font-size:12.5px;color:var(--muted);">Esto cambia el nombre en todos los clientes de <b>${esc(oldName)}</b> y mantiene su mismo link personal. No se pierde ningún dato ni cliente.</p>
  <label>Nombre nuevo</label>
  <input type="text" id="rnName" value="${esc(oldName)}">
  <div id="rnErr"></div>
  <div class="modalbtns">
  <button class="btncancel" id="rnCancel">Cancelar</button>
  <button class="btnok" id="rnSave">Guardar</button>
  </div>
  `;
  const close = showModal(body);
  body.querySelector("#rnCancel").onclick = close;
  const input = body.querySelector("#rnName");
  input.focus();
  input.select();
  body.querySelector("#rnSave").onclick = async () => {
    const newName = input.value.trim();
    if(!newName){ input.focus(); return; }
    if(newName === oldName){ close(); return; }
    const saveBtn = body.querySelector("#rnSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    const errBox = body.querySelector("#rnErr");
    errBox.innerHTML = "";
    try{
      const r = await fetch('/api/manager', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({name: oldName, renameTo: newName})
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok || !data.ok){
        errBox.innerHTML = `<div class="dupewarn">⚠️ ${esc(data.message || "No se pudo renombrar. Puede que ya exista otro manager con ese nombre.")}</div>`;
        saveBtn.disabled = false;
        saveBtn.textContent = "Guardar";
        return;
      }
      if(openCards.has(oldName)){ openCards.delete(oldName); openCards.add(newName); }
      const fresh = await loadShared();
      if(fresh && !fresh.error){
        STATE = fresh;
        if(!STATE.managers) STATE.managers = [];
        if(!STATE.clients) STATE.clients = [];
      }
      showToast(`Renombrado ✓ (${data.updatedClients} cliente${data.updatedClients===1?"":"s"} actualizados)`);
      close(); render();
    }catch(e){
      errBox.innerHTML = `<div class="dupewarn">⚠️ No se pudo guardar. Intenta de nuevo.</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar";
    }
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
const EXCEL_HEADERS = ["#","Manager","Nombre","Teléfono","Dirección","Fecha Cita","Idioma","Notas","Estado",
  "Fecha de pago","Día de pago","Monto pagado","Forma de pago","Observaciones",
  "Sub-gestor asignado","Derivado el"];

function buildClientSheet(clients){
  const rows = [EXCEL_HEADERS];
  clients.forEach((c,i) => rows.push([
    i+1, c.manager, c.nombre, c.telefono, c.direccion, c.fechaCita, c.idioma, c.notas, c.estado,
    c.fechaPago ? formatDate(c.fechaPago) : "",
    c.pagoFecha ? formatDate(c.pagoFecha) : "",
    c.pagoMonto || "",
    c.pagoForma || "",
    c.observaciones || "",
    c.subgestorNombre || "",
    c.derivadoEn ? new Date(c.derivadoEn).toLocaleString("es") : ""
  ]));
  return XLSX.utils.aoa_to_sheet(rows);
}

function exportExcel(){
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildClientSheet(STATE.clients), "Todos los clientes");

const resumenRows = [["Manager", ...ESTADOS, "Total"]];
  STATE.managers.forEach(m => {
    const clients = STATE.clients.filter(c=>c.manager===m.name);
    const row = [m.name];
    ESTADOS.forEach(e => row.push(clients.filter(c=>c.estado===e).length));
    row.push(clients.length);
    resumenRows.push(row);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumenRows), "Resumen");

STATE.managers.forEach(m => {
  const clients = STATE.clients.filter(c=>c.manager===m.name);
  const safe = m.name.slice(0,31);
  XLSX.utils.book_append_sheet(wb, buildClientSheet(clients), safe);
});

const stamp = todayStr();
  XLSX.writeFile(wb, `managers_${stamp}.xlsx`);
}

// Export para un manager individual: solo sus propios clientes, con
// las mismas columnas (incluyendo pago y observaciones).
function exportMyExcel(){
  const wb = XLSX.utils.book_new();
  const safeSheet = (CURRENT_USER.name || "Mis clientes").slice(0,31);
  XLSX.utils.book_append_sheet(wb, buildClientSheet(STATE.clients), safeSheet);
  const stamp = todayStr();
  const safeName = (CURRENT_USER.name || "manager").replace(/[^a-z0-9]+/gi, "_");
  XLSX.writeFile(wb, `${safeName}_${stamp}.xlsx`);
}

/* ===================== AUTO-REFRESH AL VOLVER A LA APP =====================
   Si Omar (o un manager) deja la app en segundo plano y vuelve
   despues, esto trae los datos mas recientes automaticamente, sin
   tener que cerrar y volver a abrir la pagina. Si hay un formulario
   o modal abierto en ese momento, no se toca nada para no perder lo
   que se estaba escribiendo. */
document.addEventListener("visibilitychange", async () => {
  if(document.visibilityState !== "visible") return;
  if(!CURRENT_USER) return;
  if(document.querySelector(".overlay")) return; // hay un modal abierto, no interrumpir
  if(CURRENT_USER.type === "manager"){
    const fresh = await loadShared(CURRENT_USER.token);
    if(fresh && !fresh.error && fresh.role === "manager"){
      STATE.clients = fresh.clients || [];
      render();
    }
    return;
  }
  if(CURRENT_USER.type === "subgestor"){
    const fresh = await loadShared(CURRENT_USER.token);
    if(fresh && !fresh.error && fresh.role === "subgestor"){
      STATE.clients = fresh.clients || [];
      render();
    }
    return;
  }
  const fresh = await loadShared();
  if(fresh && !fresh.error){
    STATE = fresh;
    if(!STATE.managers) STATE.managers = [];
    if(!STATE.clients) STATE.clients = [];
    render();
  }
});

/* ===================== START ===================== */
init();
