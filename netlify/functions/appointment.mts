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

// Lista de estados de EE.UU. (abreviatura -> nombre completo). Se usa
// SOLO para identificar en que estado vive un cliente cuando la cita
// viene de uno de los 2 calendarios "compartidos" (Water Quality
// Assessment / RP), y asi decidir si hay que mandarlo a un manager
// especifico en vez del manager normal de ese calendario.
const US_STATES: Record<string, string> = {
AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
DC: "District of Columbia",
};

// Intenta identificar el estado (ej. "PA", "OH") a partir del texto libre
// de la direccion completa. Devuelve la abreviatura en mayusculas, o null
// si no se pudo identificar con confianza. NUNCA "adivina" a la fuerza:
// si no hay una senal clara, prefiere devolver null.
function detectUSState(direccion: string): string | null {
if (!direccion) return null;

// Metodo 1 (el mas confiable): formato clasico de direccion de EE.UU,
// "Calle, Ciudad, XX 12345" -> buscamos una abreviatura de 2 letras
// pegada justo antes de un codigo postal de 5 digitos, y la validamos
// contra la lista real de estados (para no confundir "St" u otra cosa).
const zipMatch = direccion.match(/\b([A-Za-z]{2})\b[\s,]+\d{5}(-\d{4})?\b/);
if (zipMatch) {
const abbr = zipMatch[1].toUpperCase();
if (US_STATES[abbr]) return abbr;
}

// Metodo 2 (respaldo): buscamos el nombre completo del estado como
// palabra completa en cualquier parte del texto (ej. "Pennsylvania"),
// ignorando tildes y mayusculas.
const normalized = direccion
.normalize("NFD")
.split("")
.filter((ch) => { const code = ch.codePointAt(0) || 0; return code < 768 || code > 879; })
.join("")
.toLowerCase();
for (const abbr of Object.keys(US_STATES)) {
const name = US_STATES[abbr].toLowerCase();
const re = new RegExp("\\b" + name + "\\b");
if (re.test(normalized)) return abbr;
}

return null;
}

// Reglas de reasignacion automatica por estado, SOLO para estos 2
// calendarios compartidos (reciben citas de clientes de zonas distintas).
// Si el calendario de la cita no esta en esta lista, o el estado
// detectado no esta en la lista de ese calendario, no se toca nada: se
// usa el manager normal de siempre.
const REGLAS_ESTADO_POR_CALENDARIO: Record<string, Record<string, string>> = {
// Water Quality Assessment
"38mQym1YLkX4RdLT0Gmc": {
PA: "Carlos Rosario",
OH: "Carlos Buenaventura",
WI: "Carlos Buenaventura",
MI: "Carlos Buenaventura",
},
// Water Quality Assessment RP
"A5AyPCIXAZoOQsBnBj3K": {
OH: "Carlos Buenaventura",
WI: "Carlos Buenaventura",
MI: "Carlos Buenaventura",
},
};

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

const managerDirecto = (customData.manager || "").toString().trim();

// REASIGNACION AUTOMATICA POR ESTADO (solo calendarios compartidos):
// Si esta cita vino de "Water Quality Assessment" o su version RP,
// revisamos en que estado de EE.UU. vive el cliente (leyendo su
// direccion) para decidir si hay que mandarla a un manager especifico
// en vez del manager normal de ese calendario.
let manager = "";
let necesitaRevision = false;
const reglasDeEsteCalendario = REGLAS_ESTADO_POR_CALENDARIO[calendarId];
if (reglasDeEsteCalendario) {
const estadoDetectado = detectUSState(direccion);
if (estadoDetectado && reglasDeEsteCalendario[estadoDetectado]) {
// Estado detectado con confianza y esta en la lista de este
// calendario: se reasigna al manager que corresponde.
manager = reglasDeEsteCalendario[estadoDetectado];
} else if (!estadoDetectado) {
// No pudimos leer el estado con confianza en la direccion. NO
// adivinamos: dejamos que siga el flujo normal de abajo, pero
// marcamos el cliente para que Omar lo revise a mano, y dejamos
// aviso en los registros (Netlify > Logs) para poder auditarlo.
necesitaRevision = true;
console.warn(
"AVISO: no se pudo identificar el estado en la direccion de una cita de calendario compartido.",
JSON.stringify({ calendarId, direccion })
);
}
// Si se detecto un estado pero no esta en la lista de este
// calendario (ej. PA en el calendario RP), no se hace nada especial
// aqui: sigue el flujo normal de abajo, sin marcar revision.
}

if (!manager) {
manager = managerDirecto || (await managerFromCalendarId(calendarId));
}

// BLINDAJE CONTRA TILDES: el nombre del manager puede llegar escrito
// un poco distinto al que ya esta guardado (ej. "Angel Cadenas" sin
// tilde, en vez de "Angel Cadenas"). Si eso pasa y no lo corregimos,
// el cliente se guarda igual, pero queda "invisible" en el link
// personal de ese manager (porque el link compara el nombre exacto).
// Aqui buscamos si el nombre que llego (sea el normal o el reasignado
// por estado) coincide, ignorando tildes y mayusculas, con un manager
// que YA existe, y si es asi usamos el nombre EXACTO que ya esta
// guardado, para que el cliente quede visible desde el primer momento.
if (manager) {
const existingManagers = await getManagers();
const matched = existingManagers.find(
(m) => normName(m.name) === normName(manager)
);
if (matched) manager = matched.name;
}

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
// Si no pudimos leer el estado del cliente con confianza (y venia de
// uno de los 2 calendarios compartidos), lo marcamos para que Omar lo
// confirme a mano, en vez de arriesgarnos a asignarlo mal.
revisar: necesitaRevision,
// Guardamos de que calendario vino esta cita. Sirve, por ejemplo,
// para saber si un cliente vino de un calendario "compartido" entre
// varias zonas (como "Water Quality Assessment" o su version RP),
// donde el manager asignado puede necesitar corregirse despues.
calendarId,
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
