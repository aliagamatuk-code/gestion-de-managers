import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function store() {
  return getStore("gestion-managers");
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normName(n: any) {
  return (n || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}
function normPhone(p: any) {
  return (p || "").toString().replace(/\D/g, "").slice(-10);
}
function newId() {
  return "c" + Date.now() + Math.floor(Math.random() * 1000);
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
  const manager = managerDirecto || (await managerFromCalendarId(calendarId));
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
          nombreRecibido: nombre || "(vacío)",
          calendarIdRecibidoCrudo: (body.calendarId || "(vacío)").toString(),
          calendarIdExtraido: calendarId || "(vacío)",
          managerEncontrado: manager || "(no encontrado)",
          cuerpoCompletoRecibido: JSON.stringify(body),
        },
      },
      400
    );
  }

  const s = store();
  const state = (await s.get("state", { type: "json" })) || { managers: [], clients: [] };
  if (!Array.isArray(state.managers)) state.managers = [];
  if (!Array.isArray(state.clients)) state.clients = [];

  // Encontrar el manager existente ignorando mayúsculas/espacios; si no existe, se agrega.
  let managerMatch = state.managers.find((m: string) => normName(m) === normName(manager));
  if (!managerMatch) {
    managerMatch = manager;
    state.managers.push(manager);
  }

  // Misma regla de duplicados que usa la app: nombre normalizado + últimos 10 dígitos del teléfono.
  const nn = normName(nombre);
  const np = normPhone(telefono);
  const dupe = state.clients.find(
    (c: any) => normName(c.nombre) === nn && np && normPhone(c.telefono) === np
  );

  if (dupe) {
    return json({ ok: true, created: false, duplicate: true, clientId: dupe.id });
  }

  const client = {
    id: newId(),
    manager: managerMatch,
    nombre,
    telefono,
    direccion,
    fechaCita,
    idioma,
    notas,
    estado: "Activo",
    fechaPago: "",
    revisar: false,
  };
  state.clients.push(client);
  await s.setJSON("state", state);

  return json({ ok: true, created: true, duplicate: false, clientId: client.id });
};

export const config: Config = {
  path: "/api/appointment",
};
