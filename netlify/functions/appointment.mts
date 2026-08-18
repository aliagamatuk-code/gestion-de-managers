import type { Context, Config } from "@netlify/functions";
import {
getAllClients,
getManagers,
saveClient,
addManagerIfMissing,
findDuplicate,
newId,
normName,
} from "./_store-helpers.mts";

function json(body: any, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: {
"content-type": "application/json",
"cache-control": "no-store, no-cache, must-revalidate, max-age=0",
},
});
}

const LAUNCHER_API = "https://calendarios-managers-quantica360.netlify.app/api/managers";

function calendarIdFromUrl(u: string): string {
if (!u) return "";
const parts = u.split("/").filter(Boolean);
return parts[parts.length - 1] || "";
}

async function managerFromCalendarId(calendarId: string): Promise<string> {
if (!calendarId) return "";
try {
const r = await fetch(LAUNCHER_API);
if (!r.ok) return "";
const list = (await r.json()) as { name: string; url: string }[];
const match = list.find((m) => calendarIdFromUrl(m.url) === calendarId);
return match ? match.name : "";
} catch {
return "";
}
}

export default async (req: Request, context: Context) => {
if (req.method !== "POST") {
return json({ error: "method_not_allowed" }, 405);
}

const url = new URL(req.url);
const expected = "Q360-Citas-8f2k91";
const providedQuery = url.searchParams.get("token") || "";
const providedHeader = req.headers.get("x-webhook-token") || "";
const provided = providedQuery || providedHeader;
if (provided !== expected) {
return json({ error: "unauthorized" }, 401);
}

let body: any;
try {
body = await req.json();
} catch {
return json({ error: "invalid_json" }, 400);
}

const customData = body.customData || {};
const calendarIdRaw =
(body.calendar && body.calendar.id) || customData.calendarId || "";
const calendarId = calendarIdFromUrl(calendarIdRaw.toString().trim());
const managerDirecto = (customData.manager || "").toString().trim();
let manager = managerDirecto || (await managerFromCalendarId(calendarId));

if (manager) {
const existingManagers = await getManagers();
const matched = existingManagers.find(
(m) => normName(m.name) === normName(manager)
);
if (matched) manager = matched.name;
}

const nombre = (customData.nombre || body.full_name || "").toString().trim();
const telefono = (customData.telefono || body.phone || "").toString().trim();
const direccion = (customData.direccion || body.full_address || "").toString().trim();
const fechaCita = (
customData.fechaCita ||
(body.calendar && body.calendar.startTime) ||
""
).toString().trim();
const idioma = (customData.idioma || "").toString().trim();
const notas = (customData.notas || "").toString().trim();

if (!manager || !nombre) {
return json(
{
error: "missing_fields",
debug: {
nombreRecibido: nombre || "(vacio)",
calendarIdRecibidoCrudo: calendarIdRaw || "(vacio)",
calendarIdExtraido: calendarId || "(vacio)",
managerEncontrado: manager || "(no encontrado)",
cuerpoCompletoRecibido: JSON.stringify(body),
},
},
400
);
}

if (!idioma || !fechaCita) {
console.warn(
"AVISO: llego una reserva con datos incompletos.",
JSON.stringify({
nombre,
idioma_vacio: !idioma,
fechaCita_vacia: !fechaCita,
})
);
}

await addManagerIfMissing(manager);

const existingClients = await getAllClients();
const dupe = findDuplicate(existingClients, nombre, telefono, null);
if (dupe) {
return json({ ok: true, created: false, duplicate: true, clientId: dupe.id });
}

const client = {
id: newId(),
manager,
nombre,
telefono,
direccion,
fechaCita,
idioma,
notas,
estado: "Activo",
fechaPago: "",
pagoFecha: "",
pagoMonto: "",
pagoForma: "",
observaciones: "",
revisar: false,
calendarId,
};

await saveClient(client);

return json({ ok: true, created: true, duplicate: false, clientId: client.id });
};

export const config: Config = {
path: "/api/appointment",
};
