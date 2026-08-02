import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
getManagers,
getAllClients,
getClient,
saveClient,
deleteClient,
addManagerIfMissing,
deleteManagerAndClients,
findDuplicate,
newId,
} from "./_store-helpers.mts";

const MAX_BACKUPS = 30;

function store() {
return getStore("gestion-managers");
}

function json(body: any, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: { "content-type": "application/json" },
});
}

export default async (req: Request, context: Context) => {
const url = new URL(req.url);
const path = url.pathname;
const method = req.method;

try {
if (path === "/api/data") {
if (method === "GET") {
const managers = await getManagers();
const clients = await getAllClients();
return json({ managers, clients });
}
// Ya no se usa POST /api/data para guardar cambios sueltos (eso
// ahora pasa por /api/client y /api/manager, uno por uno, para
// que dos guardados nunca se borren entre si). Solo se deja para
// avisar si algo viejo todavia le intenta pegar aqui.
if (method === "POST") {
return json({ error: "use_client_or_manager_endpoints" }, 400);
}
}

if (path === "/api/client") {
if (method === "POST") {
const body = await req.json();
const nombre = (body.nombre || "").toString().trim();
if (!nombre) return json({ error: "missing_nombre" }, 400);
const manager = (body.manager || "").toString().trim();
if (!manager) return json({ error: "missing_manager" }, 400);

let client: any;
if (body.id) {
const existing = await getClient(body.id);
if (!existing) return json({ error: "not_found" }, 404);
client = { ...existing, ...body };
} else {
if (!body.skipDuplicateCheck) {
const existingClients = await getAllClients();
const dupe = findDuplicate(existingClients, nombre, body.telefono, null);
if (dupe) {
return json({ ok: true, created: false, duplicate: true, client: dupe });
}
}
client = {
id: newId(),
manager,
nombre,
telefono: (body.telefono || "").toString().trim(),
direccion: (body.direccion || "").toString().trim(),
fechaCita: (body.fechaCita || "").toString().trim(),
idioma: (body.idioma || "").toString().trim(),
notas: (body.notas || "").toString().trim(),
estado: body.estado || "Pendiente",
fechaPago: body.fechaPago || "",
revisar: !!body.revisar,
};
}
await addManagerIfMissing(client.manager);
await saveClient(client);
return json({ ok: true, client });
}
if (method === "DELETE") {
const id = url.searchParams.get("id") || "";
if (!id) return json({ error: "missing_id" }, 400);
await deleteClient(id);
return json({ ok: true });
}
}

if (path === "/api/manager") {
if (method === "POST") {
const body = await req.json();
const name = (body.name || "").toString().trim();
if (!name) return json({ error: "missing_name" }, 400);
await addManagerIfMissing(name);
return json({ ok: true });
}
if (method === "DELETE") {
const name = url.searchParams.get("name") || "";
if (!name) return json({ error: "missing_name" }, 400);
const removedCount = await deleteManagerAndClients(name);
return json({ ok: true, removedCount });
}
}

if (path === "/api/backups") {
const s = store();
if (method === "GET") {
const idx = (await s.get("backup-index", { type: "json" })) || [];
return json(idx);
}
if (method === "POST") {
const body = await req.json().catch(() => ({}));
const managers = await getManagers();
const clients = await getAllClients();
const state = { managers, clients };
const stamp = new Date().toISOString();
const id = "backup:" + stamp;
await s.setJSON(id, state);
let idx: any[] = (await s.get("backup-index", { type: "json" })) || [];
idx.unshift({
id,
stamp,
manual: !!body.manual,
count: clients.length,
});
while (idx.length > MAX_BACKUPS) {
const old = idx.pop();
await s.delete(old.id);
}
await s.setJSON("backup-index", idx);
return json({ ok: true, id });
}
}

if (path === "/api/backups/restore" && method === "POST") {
const s = store();
const { id } = await req.json();
if (!id) return json({ error: "missing_id" }, 400);
const backupData: any = await s.get(id, { type: "json" });
if (!backupData) return json({ error: "not_found" }, 404);

// Un restore SI reemplaza todo a proposito (accion explicita del
// administrador, no un guardado normal). Borramos los clientes
// actuales y escribimos los del respaldo, uno por uno.
const currentClients = await getAllClients();
for (const c of currentClients) {
await s.delete("client:" + c.id);
}
const managers = Array.isArray(backupData.managers) ? backupData.managers : [];
const clients = Array.isArray(backupData.clients) ? backupData.clients : [];
await s.setJSON("managers", managers);
for (const c of clients) {
if (c && c.id) await s.setJSON("client:" + c.id, c);
}
return json({ managers, clients });
}

if (path === "/api/parse" && method === "POST") {
const { text } = await req.json();
if (!text || !text.trim()) return json({ error: "empty_text" }, 400);

const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
if (!apiKey) {
return json(
{ error: "missing_api_key", message: "Falta configurar ANTHROPIC_API_KEY en las variables de entorno del sitio." },
500
);
}

const systemPrompt =
'Extraes datos de clientes de texto en espanol (mensajes de WhatsApp, listas de citas, etc). Responde UNICAMENTE con un array JSON valido, sin texto adicional, sin markdown, sin backticks. Cada elemento debe tener EXACTAMENTE estos campos (usa "" si no hay dato): nombre, telefono, direccion, fechaCita, idioma, notas. "idioma" es el idioma preferido del cliente si se menciona. "fechaCita" es la fecha/hora de la cita tal como aparece en el texto. "notas" son observaciones adicionales relevantes. Puede haber uno o varios clientes en el texto.';

const r = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"content-type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
},
body: JSON.stringify({
model: "claude-sonnet-5",
max_tokens: 2000,
system: systemPrompt,
messages: [{ role: "user", content: text }],
}),
});

if (!r.ok) {
const errText = await r.text();
return json({ error: "anthropic_api_error", status: r.status, detail: errText.slice(0, 500) }, 502);
}

const data = await r.json();
const textBlocks = (data.content || [])
.filter((b: any) => b.type === "text")
.map((b: any) => b.text)
.join("\n");
const clean = textBlocks.replace(/```json|```/g, "").trim();

let parsed;
try {
parsed = JSON.parse(clean);
} catch (e) {
return json({ error: "parse_failed", raw: textBlocks.slice(0, 500) }, 500);
}
return json(Array.isArray(parsed) ? parsed : [parsed]);
}

return json({ error: "not_found" }, 404);
} catch (e: any) {
return json({ error: "server_error", message: e.message }, 500);
}
};

export const config: Config = {
path: ["/api/data", "/api/client", "/api/manager", "/api/backups", "/api/backups/restore", "/api/parse"],
};
