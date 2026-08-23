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
  findDuplicateAmplio,
  findManagerByToken,
  regenerateManagerToken,
  renameManager,
  newId,
} from "./_store-helpers.mts";
import { enviarRecuperacion, marcarEnviado } from "./_recuperacion.mts";

// Si un cliente ACABA de pasar a "No atendió" (antes tenia otro estado),
// le manda el SMS de recuperacion de inmediato y deja el cliente listo
// (con sus campos de seguimiento actualizados) para que se guarde junto
// con el resto de los cambios. Si el envio falla, no rompe nada: el
// cliente se guarda igual, y la funcion programada (recuperacion-no-
// atendio.mts) lo intentara de nuevo mas tarde.
async function manejarTransicionNoAtendio(estadoAntes: string | undefined, client: any) {
  if (estadoAntes === undefined) return; // cliente nuevo, no es una transicion
  if (estadoAntes === "No atendió") return; // ya estaba en ese estado, no es transicion nueva
  if (client.estado !== "No atendió") return; // no esta entrando a ese estado
  const ok = await enviarRecuperacion(client);
  if (ok) marcarEnviado(client);
}

// Campos de "resultados de gestion" que un manager SI puede tocar en
// un cliente que ya es suyo (via su link personal). Todo lo demas
// (nombre, telefono, direccion, etc.) esta bloqueado para managers:
// solo el administrador lo puede cambiar.
const MANAGER_ALLOWED_FIELDS = [
  "estado",
  "pagoFecha",
  "pagoMonto",
  "pagoForma",
  "observaciones",
];

// Si el estado que se va a guardar es "Pagado", exige dia, monto y
// forma de pago completos. Se revisa siempre en el servidor (no solo
// en la pantalla) para que nunca se pueda guardar un pago incompleto,
// ni siquiera saltandose la app.
function pagoIncompleto(client: any) {
  if (client.estado !== "Pagado") return false;
  return !client.pagoFecha || !client.pagoMonto || !client.pagoForma;
}

const MAX_BACKUPS = 30;

function store() {
  return getStore("gestion-managers");
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Nunca dejar que el navegador (ni ningun proxy/CDN de por medio)
      // guarde en cache esta respuesta. Sin esto, algunos navegadores
      // (sobre todo en celular) pueden mostrar datos viejos aunque el
      // servidor ya tenga los datos nuevos guardados.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === "/api/data") {
      if (method === "GET") {
        // Si viene un "token" en el link (ej. /?m=abc123), esta pidiendo
        // los datos SOLO de ese manager. Si el codigo no existe, el link
        // ya no sirve (por ejemplo, si Omar borro a ese manager).
        const token = url.searchParams.get("token") || "";
        if (token) {
          const mgr = await findManagerByToken(token);
          if (!mgr) return json({ error: "invalid_token" }, 401);
          const allClients = await getAllClients();
          const clients = allClients.filter((c: any) => c.manager === mgr.name);
          return json({ role: "manager", managerName: mgr.name, clients });
        }
        // Sin token = entrada del administrador (como funcionaba antes).
        // Ve a todos los managers (con su codigo de link, para poder
        // copiarlo y enviarlo) y a todos los clientes.
        const managers = await getManagers();
        const clients = await getAllClients();
        return json({ role: "admin", managers, clients });
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
        const token = (body.token || "").toString().trim();

        // ---- Un manager esta guardando desde SU link personal ----
        // Solo puede actualizar el resultado de gestion (estado, datos
        // de pago, observaciones) de un cliente que YA es suyo. No puede
        // crear clientes nuevos ni cambiar el nombre/telefono/etc, y no
        // puede tocar clientes de otro manager.
        if (token) {
          const mgr = await findManagerByToken(token);
          if (!mgr) return json({ error: "invalid_token" }, 401);
          if (!body.id) return json({ error: "managers_cannot_create" }, 403);
          const existing = await getClient(body.id);
          if (!existing || existing.manager !== mgr.name) {
            return json({ error: "not_found" }, 404);
          }
          const client = { ...existing };
          for (const field of MANAGER_ALLOWED_FIELDS) {
            if (field in body) client[field] = body[field];
          }
          if (pagoIncompleto(client)) {
            return json({ error: "pago_incompleto" }, 400);
          }
          await manejarTransicionNoAtendio(existing.estado, client);
          await saveClient(client);
          return json({ ok: true, client });
        }

        // ---- Flujo normal del administrador (como ya funcionaba) ----
        const nombre = (body.nombre || "").toString().trim();
        if (!nombre) return json({ error: "missing_nombre" }, 400);
        const manager = (body.manager || "").toString().trim();
        if (!manager) return json({ error: "missing_manager" }, 400);

        // No se acepta cargar (ni editar hacia) un cliente duplicado: alcanza
        // con que coincida el nombre, el telefono O la direccion con otro
        // cliente que ya existe (en cualquier manager). Si se esta editando
        // ese mismo cliente, no cuenta contra si mismo (por eso se excluye
        // body.id). Esto se revisa siempre en el servidor, sin excepcion, asi
        // que no hay forma de guardar un duplicado ni saltandose la pantalla.
        const existingClients = await getAllClients();
        const dupe = findDuplicateAmplio(
          existingClients,
          nombre,
          body.telefono,
          body.direccion,
          body.id || null
        );
        if (dupe) {
          return json(
            {
              error: "duplicate_client",
              message: `No se puede, cliente duplicado en el manager ${dupe.manager}.`,
              managerName: dupe.manager,
              duplicateId: dupe.id,
            },
            409
          );
        }

        let client: any;
        let estadoAntesDeGuardar: string | undefined;
        if (body.id) {
          const existing = await getClient(body.id);
          if (!existing) return json({ error: "not_found" }, 404);
          estadoAntesDeGuardar = existing.estado;
          client = { ...existing, ...body };
        } else {
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
            pagoFecha: body.pagoFecha || "",
            pagoMonto: body.pagoMonto || "",
            pagoForma: body.pagoForma || "",
            observaciones: body.observaciones || "",
            revisar: !!body.revisar,
            // Marca de tiempo de creacion del registro (distinta de fechaCita,
            // que es la fecha de la cita en si). Sirve para poder ordenar la
            // lista por "lo ultimo que se agendo" en vez de por la fecha de la
            // cita. Los clientes viejos (creados antes de este cambio) no la
            // tienen, y por eso en pantalla quedan despues de cualquier cliente
            // nuevo, sin necesidad de tocar sus datos.
            creadoEn: Date.now(),
          };
        }
        if (pagoIncompleto(client)) {
          return json({ error: "pago_incompleto" }, 400);
        }
        await addManagerIfMissing(client.manager);
        await manejarTransicionNoAtendio(estadoAntesDeGuardar, client);
        await saveClient(client);
        return json({ ok: true, client });
      }
      if (method === "DELETE") {
        // Un manager, aunque mande su link, JAMAS puede borrar un cliente.
        // Borrar solo lo puede hacer el administrador (sin token).
        const token = url.searchParams.get("token") || "";
        if (token) return json({ error: "forbidden" }, 403);
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "missing_id" }, 400);
        await deleteClient(id);
        return json({ ok: true });
      }
    }

    if (path === "/api/manager") {
      // Agregar o eliminar managers es solo del administrador.
      if (method === "POST") {
        const body = await req.json();
        if (body.token) return json({ error: "forbidden" }, 403);

        // Renombrar un manager que ya existe: mantiene su mismo link
        // personal y reasigna automaticamente a todos sus clientes al
        // nombre nuevo, sin perder ningun dato.
        if (body.renameTo) {
          const oldName = (body.name || "").toString().trim();
          const newName = (body.renameTo || "").toString().trim();
          if (!oldName || !newName) return json({ error: "missing_name" }, 400);
          const result = await renameManager(oldName, newName);
          if (!result.ok) {
            if (result.error === "not_found") return json({ error: "not_found" }, 404);
            if (result.error === "name_taken") {
              return json(
                {
                  error: "name_taken",
                  message: `Ya existe un manager con el nombre "${newName}".`,
                },
                409
              );
            }
            return json({ error: result.error }, 400);
          }
          return json({
            ok: true,
            manager: result.manager,
            updatedClients: result.updatedClients,
          });
        }

        const name = (body.name || "").toString().trim();
        if (!name) return json({ error: "missing_name" }, 400);
        // Generar un link nuevo para un manager que ya existe: invalida el
        // link viejo al instante, sin borrar al manager ni sus clientes.
        if (body.regenerateToken) {
          const mgr = await regenerateManagerToken(name);
          if (!mgr) return json({ error: "not_found" }, 404);
          return json({ ok: true, manager: mgr });
        }
        await addManagerIfMissing(name);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        if (url.searchParams.get("token")) return json({ error: "forbidden" }, 403);
        const name = url.searchParams.get("name") || "";
        if (!name) return json({ error: "missing_name" }, 400);
        const removedCount = await deleteManagerAndClients(name);
        return json({ ok: true, removedCount });
      }
    }

    if (path === "/api/backups") {
      const s = store();
      if (url.searchParams.get("token")) return json({ error: "forbidden" }, 403);
      if (method === "GET") {
        const idx = (await s.get("backup-index", { type: "json" })) || [];
        return json(idx);
      }
      if (method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (body.token) return json({ error: "forbidden" }, 403);
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
      const { id, token } = await req.json();
      if (token) return json({ error: "forbidden" }, 403);
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
