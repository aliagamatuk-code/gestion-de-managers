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

// Saca el calendarId final de un link de booking, ej:
// https://api.leadconnectorhq.com/widget/booking/54Gonho9iMIzHsEoZCYF -> 54Gonho9iMIzHsEoZCYF
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

// BLINDAJE CONTRA TILDES: el nombre del manager puede llegar escrito
// un poco distinto al que ya esta guardado (ej. "Angel Cadenas" sin
// tilde, en vez de "Ángel Cadenas"). Si eso pasa y no lo corregimos,
// el cliente se guarda igual, pero queda "invisible" en el link
// personal de ese manager (porque el link compara el nombre exacto).
// Aqui buscamos si el nombre que llego coincide, ignorando tildes y
// mayusculas, con un manager que YA existe, y si es asi usamos el
// nombre EXACTO que ya esta guardado, para que el cliente quede
// visible desde el primer momento.
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

// AVISO DE SEGURIDAD (blindaje): si idioma o fechaCita llegan vacios,
// lo anotamos en los registros de la funcion (Netlify > Logs) para
// detectar rapido si algo cambio en GHL (el trigger, el mapeo de
// customData, etc.) y esto se rompio de nuevo.
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

// Nos aseguramos de que el manager quede registrado (si ya existe, no
// hace nada). Esto es de muy bajo riesgo porque casi nunca escribe:
// solo escribe cuando aparece un manager que todavia no esta en la lista.
await addManagerIfMissing(manager);

// Revisamos si ya existe un cliente igual (mismo nombre + telefono).
// Esto es solo LECTURA, asi que nunca puede chocar con otro guardado.
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
};

// Este guardado escribe SOLO la llave de este cliente nuevo. No toca
// ninguna otra llave, asi que no puede borrar cambios que otra persona
// (o otra cita) haya guardado al mismo tiempo.
await saveClient(client);

return json({ ok: true, created: true, duplicate: false, clientId: client.id });
};

export const config: Config = {
path: "/api/appointment",
};
