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

export type ManagerRecord = { name: string; token: string };

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
managers[idx] = { name: managers[idx].name, token: genToken() };
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
