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

  const expected = Netlify.env.get("APPOINTMENT_WEBHOOK_SECRET") || "";
  const provided = req.headers.get("x-webhook-token") || "";
  if (!expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const calendarId = (body.calendarId || "").toString().trim();
  const managerDirecto = (body.manager || "").toString().trim();
  const manager = managerDirecto || (await managerFromCalendarId(calendarId));
  const nombre = (body.nombre || "").toString().trim();
  const telefono = (body.telefono || "").toString().trim();
  const direccion = (body.direccion || "").toString().trim();
  const fechaCita = (body.fechaCita || "").toString().trim();
  const idioma = (body.idioma || "").toString().trim();
  const notas = (body.notas || "").toString().trim();

  if (!manager || !nombre) {
    return json(
      {
        error: "missing_fields",
        message:
          "Falta el nombre, o el calendarId no está registrado todavía en la app de calendarios (calendarios-managers-quantica360). Agrega ahí al manager con su link y vuelve a intentar.",
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
