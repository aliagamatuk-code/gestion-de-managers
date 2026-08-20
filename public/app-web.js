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
// Calendarios "compartidos" (reciben citas de clientes de distintas
// zonas). Solo en clientes que vinieron de uno de estos calendarios
// se puede usar el boton de "Cambiar de manager" - en los demas
// clientes no aplica, porque su manager ya quedo bien asignado desde
// el principio.
const CALENDARIOS_REASIGNABLES = [
    "38mQym1YLkX4RdLT0Gmc", // Water Quality Assessment
    "A5AyPCIXAZoOQsBnBj3K", // Water Quality Assessment RP
  ];
const LOCK_KEY = "gestion-managers-device-lock";
// Guarda el codigo secreto del link personal de un manager en este
// dispositivo, para que no tenga que volver a tocar el link cada vez
// que abre la app (aunque el link siga siendo lo que le da acceso).
const MGR_TOKEN_KEY = "gestion-managers-token";

let STATE = null;          // {managers:[], clients:[]}
let CURRENT_USER = null;   // {type:'admin'} or {type:'manager', name:'...', token:'...'}
let openCards = new Set();

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
    // Si quien guarda es un manager (entro por su link personal), le
    // mandamos al servidor su codigo secreto junto con el cambio. El
    // servidor usa ese codigo para saber quien es y que SI puede tocar.
    const payload = (CURRENT_USER && CURRENT_USER.type === "manager")
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

/* ===================== INIT ===================== */
async function init(){
  // Si el link trae "?m=CODIGO", esta persona entro por el link
  // personal de un manager. Guardamos ese codigo en el dispositivo
  // (para que no tenga que reabrir el link cada vez) y limpiamos la
  // URL visible, por prolijidad.
  const params = new URLSearchParams(location.search);
  const urlToken = params.get('m') || '';
  if(urlToken){
    saveManagerToken(urlToken);
    history.replaceState({}, '', location.pathname);
  }
  // Si este dispositivo ya estaba configurado como el de Omar (admin)
  // y no se acaba de tocar un link nuevo, no lo cambiamos a manager
  // por accidente aunque alguna vez haya quedado guardado un token viejo.
  const existingLock = loadLock();
  const managerToken = urlToken || (existingLock && existingLock.type === "admin" ? "" : loadManagerToken());

  if(managerToken){
    const shared = await loadShared(managerToken);
    if(!shared || shared.error || shared.role !== "manager"){
      document.getElementById("root").innerHTML =
        '<div class="lockwrap"><h1>Este link ya no funciona</h1><p>Pídele a Omar que te envíe tu link actualizado.</p></div>';
      return;
    }
    STATE = { managers: [{name: shared.managerName, token: managerToken}], clients: shared.clients || [] };
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
    app.appendChild(renderAdminToolbar());
    app.appendChild(renderSummary());
    STATE.managers.forEach(m => app.appendChild(renderManagerCard(m.name, true, m.token)));
  } else {
    app.appendChild(renderManagerToolbar());
    app.appendChild(renderManagerCard(CURRENT_USER.name, false, null));
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
  ${token ? '<button class="miniBtn" data-x="link" title="Copiar link personal" style="margin-right:4px;">🔗</button>' : ''}
  ${token ? '<button class="miniBtn" data-x="revoke" title="Generar link nuevo (corta el acceso al anterior)" style="margin-right:4px;">🔁</button>' : ''}
  ${collapsible ? '<div class="chev">▾</div>' : ''}
  `;
  if(token){
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
  const isAdmin = CURRENT_USER.type === "admin";
  const vencido = isVencidoPendiente(c);
  const el = document.createElement("div");
  el.className = "clientcard" + (vencido ? " vencido" : "");
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
  // El boton de "Cambiar de manager" solo aparece si este cliente vino
    // de uno de los calendarios compartidos (Water Quality Assessment o
    // su version RP). En los demas clientes no se muestra.
    if(c.calendarId && CALENDARIOS_REASIGNABLES.includes(c.calendarId)){
          const chgBtn = document.createElement("button");
          chgBtn.className = "miniBtn";
    chgBtn.textContent = "🔀 Cambiar de manager";
          chgBtn.onclick = () => openChangeManagerModal(c);
          actions.appendChild(chgBtn);
    }
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
                  c.manager = nombreManager;
                  const res = await saveClientRemote(c, ['nombre','manager']);
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
    const saveBtn = body.querySelector("#cfSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    if(existing){
      Object.assign(existing, data);
      const res = await saveClientRemote(existing);
      showBadge(res.ok);
      close(); render();
    } else {
      const newClient = { manager: managerName, estado:"Pendiente", fechaPago:"", pagoFecha:"", pagoMonto:"", pagoForma:"", observaciones:"", revisar:false, ...data };
      const res = await saveClientRemote(newClient);
      showBadge(res.ok);
      if(res.ok && res.data && res.data.client){
        STATE.clients.push(res.data.client);
      }
      close(); render();
    }
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
      const toSave = [];
      parsed.forEach(p => {
        if(!p.nombre) return;
        const dupe = findDuplicate(p.nombre, p.telefono, null);
        if(dupe){ skipped.push(p.nombre); return; }
        toSave.push({
          manager: managerName, estado:"Pendiente", fechaPago:"", pagoFecha:"", pagoMonto:"", pagoForma:"", observaciones:"", revisar:false,
          nombre: p.nombre || "", telefono: p.telefono || "", direccion: p.direccion || "",
          fechaCita: p.fechaCita || "", idioma: p.idioma || "", notas: p.notas || ""
        });
      });
      const results = await Promise.all(toSave.map(nc => saveClientRemote(nc)));
      results.forEach(res => {
        if(res.ok && res.data && res.data.client){
          STATE.clients.push(res.data.client);
          added++;
        }
      });
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
  <button class="toolbtn" id="tbRefresh">🔄 Actualizar ahora</button>
  <button class="toolbtn" id="tbAddMgr">➕ Agregar manager</button>
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
  box.querySelector("#tbExport").onclick = exportMyExcel;
  return box;
}

// Copia al portapapeles el link personal de un manager, para que Omar
// se lo mande por WhatsApp/mensaje directo. Con navegadores viejos o
// sin permiso de portapapeles, muestra el link en una ventanita para
// copiarlo a mano.
function copyManagerLink(token, name){
  const link = location.origin + "/?m=" + token;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(
      () => showToast("Link de " + name + " copiado ✓"),
      () => window.prompt("Copia este link y envíaselo a " + name + ":", link)
    );
  } else {
    window.prompt("Copia este link y envíaselo a " + name + ":", link);
  }
}

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
  "Fecha de pago","Día de pago","Monto pagado","Forma de pago","Observaciones"];

function buildClientSheet(clients){
  const rows = [EXCEL_HEADERS];
  clients.forEach((c,i) => rows.push([
    i+1, c.manager, c.nombre, c.telefono, c.direccion, c.fechaCita, c.idioma, c.notas, c.estado,
    c.fechaPago ? formatDate(c.fechaPago) : "",
    c.pagoFecha ? formatDate(c.pagoFecha) : "",
    c.pagoMonto || "",
    c.pagoForma || "",
    c.observaciones || ""
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
