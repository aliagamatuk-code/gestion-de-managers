// Funciones compartidas para leer y escribir datos de forma segura.
// Cada cliente se guarda en su PROPIA llave (client:<id>) en vez de
// un solo archivo gigante con todos los clientes juntos. Asi, cuando
// alguien guarda un cambio (el panel de Omar, o una cita nueva por
// Webhook) nunca puede borrar sin querer lo que otra persona acaba
// de guardar al mismo tiempo.

import { getStore } from "@netlify/blobs";
import SEED from "./seed-data.mts";

export function store() {
  return getStore("gestion-managers");
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

export async function getManagers(): Promise<string[]> {
await ensureMigrated();
const s = store();
const managers = await s.get("managers", { type: "json" });
return Array.isArray(managers) ? managers : [];
}

export async function addManagerIfMissing(name: string) {
await ensureMigrated();
const s = store();
const managers = await getManagers();
const exists = managers.some((m: string) => normName(m) === normName(name));
if (!exists && name) {
managers.push(name);
await s.setJSON("managers", managers);
}
}

export async function deleteManagerAndClients(name: string) {
await ensureMigrated();
const s = store();
const managers = await getManagers();
const filtered = managers.filter((m: string) => m !== name);
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
