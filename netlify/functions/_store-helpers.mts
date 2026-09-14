// Funciones compartidas para leer y escribir datos de forma segura.
// Cada cliente se guarda en su PROPIA llave (client:<id>) en vez de
// un solo archivo gigante con todos los clientes juntos. Asi, cuando
// alguien guarda un cambio (el panel de Omar, o una cita nueva por
// Webhook) nunca puede borrar sin querer lo que otra persona acaba
// de guardar al mismo tiempo.
//
// Ademas se usa consistencia FUERTE (consistency: 'strong') para que
// un cliente nuevo aparezca de inmediato en la lista, en vez de tardar
// hasta 60 segundos (comportamiento por defecto de Netlify Blobs).

import { getStore } from "@netlify/blobs";
import SEED from "./seed-data.mts";

export function store() {
return getStore("gestion-managers", { consistency: "strong" });
}

const MIGRATION_KEY = "migrated-to-v2";

// Se asegura de que los datos viejos (guardados juntos en la llave
// "state") ya esten repartidos en llaves individuales. Se corre una
// sola vez: despues de la primera vez queda marcado con MIGRATION_KEY
// y nunca se vuelve a ejecutar, aunque despues se borren todos los
// clientes.
export async function ensureMigrated() {
const s = store();
const already = await s.get(MIGRATION_KEY);
if (already) return;

const old: any = (await s.get("state", { type: "json" })) || SEED;
const managers = Array.isArray(old.managers) ? old.managers : [];
const clients = Array.isArray(old.clients) ? old.clients : [];

await s.setJSON("managers", managers);
for (const c of clients) {
if (c && c.id) {
await s.setJSON("client:" + c.id, c);
}
}
await s.set(MIGRATION_KEY, "1");
}

// Genera un codigo secreto para el link personal de un manager.
// No es adivinable: son 20 caracteres al azar (letras y numeros).
export function genToken(): string {
const raw = (globalThis as any).crypto?.randomUUID?.() || String(Date.now()) + Math.random();
return raw.toString().replace(/-/g, "").slice(0, 20);
}

const MIGRATION_KEY_TOKENS = "migrated-to-v3-manager-tokens";

// Convierte la lista de managers, que antes eran solo texto
// (["Carlos Rosario", ...]), a objetos con su propio codigo secreto
// (link personal): [{name:"Carlos Rosario", token:"..."}, ...].
// Igual que la otra migracion, corre UNA sola vez.
export async function ensureManagerTokens() {
const s = store();
const already = await s.get(MIGRATION_KEY_TOKENS);
if (already) return;

const raw: any = await s.get("managers", { type: "json" });
const list = Array.isArray(raw) ? raw : [];
const upgraded = list
.map((m: any) => {
if (typeof m === "string") return { name: m, token: genToken() };
if (m && typeof m === "object" && m.name) {
return { name: m.name, token: m.token || genToken() };
}
return null;
})
.filter(Boolean);

await s.setJSON("managers", upgraded);
await s.set(MIGRATION_KEY_TOKENS, "1");
}

export type SubgestorRecord = { id: string; nombre: string; telefono: string; token: string };
export type ManagerRecord = { name: string; token: string; subgestores?: SubgestorRecord[] };

// Cambia el nombre de un manager que ya existe (por ejemplo, si otra
// persona toma su lugar, o para corregir un nombre mal escrito).
// Mantiene el MISMO link personal (token): quien ya tenia ese link
// guardado sigue entrando igual, solo que ahora ve el nombre nuevo.
// Ademas reasigna automaticamente TODOS los clientes que tenia ese
// manager al nombre nuevo, asi que no se pierde ningun dato ni cliente
// en el cambio. Si ya existe otro manager con el nombre nuevo, no se
// permite el cambio (para no mezclar sin querer a dos managers
// distintos en uno solo).
export async function renameManager(
oldName: string,
newName: string
): Promise<
| { ok: true; manager: ManagerRecord; updatedClients: number }
| { ok: false; error: string }
> {
await ensureMigrated();
await ensureManagerTokens();
const s = store();
const managers = await getManagers();
const idx = managers.findIndex((m) => m.name === oldName);
if (idx === -1) return { ok: false, error: "not_found" };
const clash = managers.some(
(m, i) => i !== idx && normName(m.name) === normName(newName)
);
if (clash) return { ok: false, error: "name_taken" };

managers[idx] = { ...managers[idx], name: newName };
await s.setJSON("managers", managers);

const clients = await getAllClients();
let updatedClients = 0;
for (const c of clients) {
if (c.manager === oldName) {
c.manager = newName;
await s.setJSON("client:" + c.id, c);
updatedClients++;
}
}
return { ok: true, manager: managers[idx], updatedClients };
}

export async function getManagers(): Promise<ManagerRecord[]> {
await ensureMigrated();
await ensureManagerTokens();
const s = store();
const managers = await s.get("managers", { type: "json" });
return Array.isArray(managers) ? managers : [];
}

export async function addManagerIfMissing(name: string) {
await ensureMigrated();
await ensureManagerTokens();
const s = store();
const managers = await getManagers();
const exists = managers.some((m) => normName(m.name) === normName(name));
if (!exists && name) {
managers.push({ name, token: genToken() });
await s.setJSON("managers", managers);
}
}

// Genera un codigo secreto NUEVO para un manager que ya existe. El
// link viejo (con el codigo anterior) deja de servir en el momento,
// aunque el manager y sus clientes no se tocan para nada. Sirve para
// "cortarle el acceso" a un link que se perdio o se compartio de mas,
// sin tener que borrar al manager ni sus clientes.
export async function regenerateManagerToken(name: string): Promise<ManagerRecord | null> {
await ensureMigrated();
await ensureManagerTokens();
const s = store();
const managers = await getManagers();
const idx = managers.findIndex((m) => m.name === name);
if (idx === -1) return null;
managers[idx] = { ...managers[idx], token: genToken() };
await s.setJSON("managers", managers);
return managers[idx];
}

// Busca a que manager le pertenece un codigo secreto (link). Si no
// existe ningun manager con ese codigo, devuelve null (link invalido).
export async function findManagerByToken(token: string): Promise<ManagerRecord | null> {
if (!token) return null;
const managers = await getManagers();
return managers.find((m) => m.token === token) || null;
}

// ---- Sub-gestores ----
// Cada manager puede tener su propia lista de "sub-gestores" (gente a la que
// le puede derivar citas puntuales). Viven dentro del mismo registro del
// manager (misma key "managers"), igual que el manager mismo tiene su
// nombre + token ahi. Un sub-gestor accede con SU PROPIO token secreto,
// generado igual que el del manager (genToken()), pero solo ve y edita los
// clientes que tiene asignados (client.subgestorId === su id).

export function genSubgestorId(): string {
  return "sg" + Date.now() + Math.floor(Math.random() * 1000);
}

export async function addSubgestor(
  managerName: string,
  nombre: string,
  telefono: string
): Promise<{ ok: true; subgestor: SubgestorRecord } | { ok: false; error: string }> {
  await ensureMigrated();
  await ensureManagerTokens();
  const s = store();
  const managers = await getManagers();
  const idx = managers.findIndex((m) => m.name === managerName);
  if (idx === -1) return { ok: false, error: "not_found" };
  const subgestor: SubgestorRecord = { id: genSubgestorId(), nombre, telefono, token: genToken() };
  const list = managers[idx].subgestores || [];
  list.push(subgestor);
  managers[idx] = { ...managers[idx], subgestores: list };
  await s.setJSON("managers", managers);
  return { ok: true, subgestor };
}

export async function updateSubgestor(
  managerName: string,
  subgestorId: string,
  data: { nombre?: string; telefono?: string }
): Promise<{ ok: true; subgestor: SubgestorRecord } | { ok: false; error: string }> {
  await ensureMigrated();
  await ensureManagerTokens();
  const s = store();
  const managers = await getManagers();
  const idx = managers.findIndex((m) => m.name === managerName);
  if (idx === -1) return { ok: false, error: "not_found" };
  const list = managers[idx].subgestores || [];
  const sgIdx = list.findIndex((sg) => sg.id === subgestorId);
  if (sgIdx === -1) return { ok: false, error: "not_found" };
  list[sgIdx] = {
    ...list[sgIdx],
    nombre: data.nombre !== undefined ? data.nombre : list[sgIdx].nombre,
    telefono: data.telefono !== undefined ? data.telefono : list[sgIdx].telefono,
  };
  managers[idx] = { ...managers[idx], subgestores: list };
  await s.setJSON("managers", managers);
  return { ok: true, subgestor: list[sgIdx] };
}

// Saca al sub-gestor de la lista de su manager. NO toca los clientes que
// tuviera asignados — eso lo hace quien llama (ver el DELETE de
// /api/subgestor en api.mts, que libera a esos clientes despues de
// borrar aqui) para que la limpieza de citas quede a cargo de quien
// conoce el motivo del borrado.
export async function deleteSubgestor(
  managerName: string,
  subgestorId: string
): Promise<boolean> {
  await ensureMigrated();
  await ensureManagerTokens();
  const s = store();
  const managers = await getManagers();
  const idx = managers.findIndex((m) => m.name === managerName);
  if (idx === -1) return false;
  const list = managers[idx].subgestores || [];
  const filtered = list.filter((sg) => sg.id !== subgestorId);
  if (filtered.length === list.length) return false;
  managers[idx] = { ...managers[idx], subgestores: filtered };
  await s.setJSON("managers", managers);
  return true;
}

// Busca a que manager y sub-gestor le pertenece un codigo secreto de
// sub-gestor. Es el equivalente de findManagerByToken, un nivel mas abajo.
export async function findManagerAndSubgestorByToken(
  token: string
): Promise<{ manager: ManagerRecord; subgestor: SubgestorRecord } | null> {
  if (!token) return null;
  const managers = await getManagers();
  for (const m of managers) {
    const sg = (m.subgestores || []).find((s) => s.token === token);
    if (sg) return { manager: m, subgestor: sg };
  }
  return null;
}

export async function findSubgestorById(
  managerName: string,
  subgestorId: string
): Promise<SubgestorRecord | null> {
  const managers = await getManagers();
  const mgr = managers.find((m) => m.name === managerName);
  if (!mgr) return null;
  return (mgr.subgestores || []).find((sg) => sg.id === subgestorId) || null;
}

export async function deleteManagerAndClients(name: string) {
await ensureMigrated();
await ensureManagerTokens();
const s = store();
const managers = await getManagers();
const filtered = managers.filter((m) => m.name !== name);
await s.setJSON("managers", filtered);
const clients = await getAllClients();
const toDelete = clients.filter((c: any) => c.manager === name);
for (const c of toDelete) {
await s.delete("client:" + c.id);
}
return toDelete.length;
}

export async function getAllClients(): Promise<any[]> {
await ensureMigrated();
const s = store();
const { blobs } = await s.list({ prefix: "client:" });
const clients = await Promise.all(
blobs.map((b: any) => s.get(b.key, { type: "json" }))
);
return clients.filter(Boolean);
}

export async function getClient(id: string): Promise<any> {
await ensureMigrated();
const s = store();
return await s.get("client:" + id, { type: "json" });
}

export async function saveClient(client: any) {
await ensureMigrated();
const s = store();
await s.setJSON("client:" + client.id, client);
return client;
}

export async function deleteClient(id: string) {
await ensureMigrated();
const s = store();
await s.delete("client:" + id);
}

export function normName(n: any) {
return (n || "")
.toString()
.trim()
.toLowerCase()
.normalize("NFD")
.replace(/[̀-ͯ]/g, "")
.replace(/\s+/g, " ");
}

export function normPhone(p: any) {
return (p || "").toString().replace(/\D/g, "").slice(-10);
}

export function normDireccion(d: any) {
return (d || "")
.toString()
.trim()
.toLowerCase()
.normalize("NFD")
.replace(/[̀-ͯ]/g, "")
.replace(/\s+/g, " ");
}

export function newId() {
return "c" + Date.now() + Math.floor(Math.random() * 1000);
}

export function findDuplicate(clients: any[], nombre: any, telefono: any, excludeId: any) {
const nn = normName(nombre);
const np = normPhone(telefono);
return clients.find(
(c: any) =>
c.id !== excludeId &&
normName(c.nombre) === nn &&
np &&
normPhone(c.telefono) === np
);
}

// Duplicado "amplio": alcanza con que UNO solo de los tres datos
// coincida (nombre, telefono O direccion) para considerarlo duplicado.
// Esto es MAS estricto que findDuplicate (que exige nombre Y telefono
// juntos). Se usa unicamente cuando el ADMINISTRADOR agrega o edita un
// cliente a mano (formulario manual o "Pegar y cargar con IA"), para
// que Omar nunca pueda cargar sin querer el mismo cliente dos veces.
// Las citas que llegan solas por el Webhook de GoHighLevel (ver
// appointment.mts) siguen usando findDuplicate, la version mas
// estricta: asi no se pierde una cita real solo porque compartio
// telefono o direccion con otro cliente distinto (por ejemplo, dos
// integrantes de la misma familia).
export function findDuplicateAmplio(
clients: any[],
nombre: any,
telefono: any,
direccion: any,
excludeId: any
) {
const nn = normName(nombre);
const np = normPhone(telefono);
const nd = normDireccion(direccion);
return clients.find(
(c: any) =>
c.id !== excludeId &&
((nn && normName(c.nombre) === nn) ||
(np && normPhone(c.telefono) === np) ||
(nd && normDireccion(c.direccion) === nd))
);
}
