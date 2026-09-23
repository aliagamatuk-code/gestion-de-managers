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
  addSubgestor,
  updateSubgestor,
  deleteSubgestor,
  findManagerAndSubgestorByToken,
  findSubgestorById,
  buscarChoqueHorario,
  setManagerTelefono,
} from "./_store-helpers.mts";
import { enviarRecuperacion, marcarEnviado } from "./_recuperacion.mts";
import { mensajeAvisoAsignacion, enviarAvisoAsignacion } from "./_avisos.mts";

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

// Campos que SI puede tocar un sub-gestor en un cliente que tiene
// actualmente asignado (via su link personal). A diferencia del manager,
// el sub-gestor puede editar tambien los datos de contacto/ficha (nombre,
// telefono, direccion, idioma, notas) porque es quien esta en el campo
// gestionando esa cita puntual. Lo unico que se deja afuera a proposito:
// "manager" y "subgestorId" (eso solo lo cambia el manager/admin via
// /api/derivar y /api/liberar) y "fechaCita" (cambiarla reinicia el ciclo
// de recuperacion por SMS en _recuperacion.mts, asi que queda reservada
// al manager/admin).
const SUBGESTOR_ALLOWED_FIELDS = [
  "nombre",
  "telefono",
  "direccion",
  "idioma",
  "notas",
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
          if (mgr) {
            const allClients = await getAllClients();
            const clients = allClients.filter((c: any) => c.manager === mgr.name);
            return json({
              role: "manager",
              managerName: mgr.name,
              subgestores: mgr.subgestores || [],
              clients,
            });
          }
          // No es el link de ningun manager: probamos si es el link de un
          // sub-gestor (segundo nivel de acceso, ve solo lo que tiene
          // asignado dentro de la cartera de su manager).
          const found = await findManagerAndSubgestorByToken(token);
          if (found) {
            const allClients = await getAllClients();
            const clients = allClients.filter((c: any) => c.subgestorId === found.subgestor.id);
            return json({
              role: "subgestor",
              subgestorName: found.subgestor.nombre,
              managerName: found.manager.name,
              clients,
            });
          }
          return json({ error: "invalid_token" }, 401);
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
          if (mgr) {
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
            if ("estado" in body) client.resultadoRegistradoEn = Date.now();
            // Guardamos el cambio de estado PRIMERO, antes de intentar mandar el
            // SMS de recuperacion. Asi, aunque GoHighLevel tarde o falle, el
            // cambio de estado del cliente nunca se pierde.
            await saveClient(client);
            await manejarTransicionNoAtendio(existing.estado, client);
            if (client.recuperacionEnvios) await saveClient(client);
            return json({ ok: true, client });
          }

          // ---- Un sub-gestor esta guardando desde SU link personal ----
          // Solo puede tocar un cliente que tiene actualmente asignado
          // (client.subgestorId === su id), pero a diferencia del manager
          // si puede editar la ficha completa (nombre, telefono, direccion,
          // idioma, notas) ademas del resultado de gestion.
          const found = await findManagerAndSubgestorByToken(token);
          if (!found) return json({ error: "invalid_token" }, 401);
          if (!body.id) return json({ error: "subgestores_cannot_create" }, 403);
          const existing = await getClient(body.id);
          if (!existing || existing.subgestorId !== found.subgestor.id) {
            return json({ error: "not_found" }, 404);
          }
          const client = { ...existing };
          for (const field of SUBGESTOR_ALLOWED_FIELDS) {
            if (field in body) client[field] = body[field];
          }
          if (pagoIncompleto(client)) {
            return json({ error: "pago_incompleto" }, 400);
          }
          // Mismo chequeo de duplicado "amplio" que usa el administrador
          // cuando de verdad se esta tocando nombre/telefono/direccion, para
          // que el sub-gestor no pueda cargar sin querer un duplicado.
          if (body.nombre || body.telefono || body.direccion) {
            const existingClients = await getAllClients();
            const dupe = findDuplicateAmplio(
              existingClients,
              client.nombre,
              client.telefono,
              client.direccion,
              body.id
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
          }
          if ("estado" in body) client.resultadoRegistradoEn = Date.now();
          await saveClient(client);
          await manejarTransicionNoAtendio(existing.estado, client);
          if (client.recuperacionEnvios) await saveClient(client);
          return json({ ok: true, client });
        }

        // ---- Flujo normal del administrador (como ya funcionaba) ----
        let client: any;
        let estadoAntesDeGuardar: string | undefined;
        // Si esto termina siendo una reasignacion de manager, guardamos
        // aca el telefono y el mensaje para avisarle por SMS DESPUES de
        // guardar (nunca antes: si el guardado falla, no hay que avisar
        // nada). Si el manager nuevo no tiene telefono cargado, queda en
        // null y simplemente no se manda nada.
        let avisoNuevoManager: { telefono: string; mensaje: string } | null = null;

        if (body.id) {
          // Actualizando un cliente que ya existe. Puede venir con la ficha
          // completa (editar cliente) o con solo un campo suelto — por
          // ejemplo, un clic rapido en una pastilla de estado solo manda
          // {id, estado, revisar}, SIN nombre ni manager. Por eso, cuando hay
          // id, NUNCA exigimos nombre/manager: si no vienen en este guardado
          // puntual, es porque no cambiaron.
          const existing = await getClient(body.id);
          if (!existing) return json({ error: "not_found" }, 404);
          estadoAntesDeGuardar = existing.estado;

          // Choque de horario: si esto es una reasignacion de manager (viene
          // "manager" y es distinto al que ya tenia), revisamos ANTES de
          // guardar si el manager nuevo ya tiene otra cita a una hora o menos
          // de distancia, comparando SOLO contra las citas que ese manager
          // tiene asignadas DIRECTAMENTE (nunca las que tiene derivadas a sus
          // propios sub-gestores). Si hay choque y todavia no vino
          // confirmarChoque:true, no guardamos: el frontend le pregunta al
          // admin si quiere igual, y si confirma vuelve a mandar el pedido.
          if ("manager" in body && body.manager && body.manager !== existing.manager) {
            const todos = await getAllClients();
            const citasDelReceptor = todos.filter(
              (cc: any) => cc.manager === body.manager && !cc.subgestorId && cc.id !== existing.id
            );
            const choque = buscarChoqueHorario(citasDelReceptor, existing.fechaCita);
            if (choque && !body.confirmarChoque) {
              return json(
                {
                  error: "choque_horario",
                  message: `Este manager ya tiene una cita a las ${choque.hora}, ¿de todos modos querés asignarle esta?`,
                  hora: choque.hora,
                },
                409
              );
            }
            body.choqueHorario = !!choque;

            const managers = await getManagers();
            const mgrDestino = managers.find((m) => m.name === body.manager);
            if (mgrDestino && mgrDestino.telefono) {
              avisoNuevoManager = {
                telefono: mgrDestino.telefono,
                mensaje: mensajeAvisoAsignacion({ ...existing, manager: body.manager }),
              };
            }
          }
          delete body.confirmarChoque;

          client = { ...existing, ...body };
          if ("estado" in body) client.resultadoRegistradoEn = Date.now();

          // Solo revisamos duplicado si de verdad se esta tocando el nombre,
          // telefono o direccion (una edicion real de ficha), no en guardados
          // parciales como el estado.
          if (body.nombre || body.telefono || body.direccion) {
            const existingClients = await getAllClients();
            const dupe = findDuplicateAmplio(
              existingClients,
              client.nombre,
              client.telefono,
              client.direccion,
              body.id
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
          }
        } else {
          // Creando un cliente nuevo: aqui si son obligatorios nombre y
          // manager, y siempre se revisa duplicado.
          const nombre = (body.nombre || "").toString().trim();
          if (!nombre) return json({ error: "missing_nombre" }, 400);
          const manager = (body.manager || "").toString().trim();
          if (!manager) return json({ error: "missing_manager" }, 400);

          // No se acepta cargar un cliente duplicado: alcanza con que coincida
          // el nombre, el telefono O la direccion con otro cliente que ya
          // existe (en cualquier manager). Esto se revisa siempre en el
          // servidor, sin excepcion, asi que no hay forma de guardar un
          // duplicado ni saltandose la pantalla.
          const existingClients = await getAllClients();
          const dupe = findDuplicateAmplio(
            existingClients,
            nombre,
            body.telefono,
            body.direccion,
            null
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
        // Guardamos el cambio de estado PRIMERO, antes de intentar mandar el
        // SMS de recuperacion. Asi, aunque GoHighLevel tarde o falle, el
        // cambio de estado del cliente nunca se pierde.
        await saveClient(client);
        await manejarTransicionNoAtendio(estadoAntesDeGuardar, client);
        if (client.recuperacionEnvios) await saveClient(client);
        // Aviso por SMS al manager nuevo (si hubo reasignacion y tiene
        // telefono cargado): se manda DESPUES de guardar, y si falla no
        // afecta el guardado (ver enviarAvisoAsignacion en _avisos.mts).
        if (avisoNuevoManager) {
          await enviarAvisoAsignacion(avisoNuevoManager.telefono, avisoNuevoManager.mensaje);
        }
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
        // El telefono es opcional (se usa solo para poder avisarle por SMS
        // cuando se le reasigna un cliente). Si viene, esto tambien sirve
        // para cargarselo/cambiarselo a un manager que ya existe.
        if ("telefono" in body) {
          await addManagerIfMissing(name, (body.telefono || "").toString().trim());
          const mgr = await setManagerTelefono(name, (body.telefono || "").toString().trim());
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

    if (path === "/api/subgestor") {
      // Agregar/editar/eliminar sub-gestores: lo puede hacer el
      // administrador (sin token) o el propio manager dueño (con su
      // token). Un sub-gestor NUNCA puede administrar sub-gestores (ni los
      // suyos ni los de nadie), aunque mande su propio token.
      if (method === "POST") {
        const body = await req.json();
        const token = (body.token || "").toString().trim();
        let managerName: string;
        if (token) {
          const mgr = await findManagerByToken(token);
          if (!mgr) {
            const asSubgestor = await findManagerAndSubgestorByToken(token);
            if (asSubgestor) return json({ error: "forbidden" }, 403);
            return json({ error: "invalid_token" }, 401);
          }
          managerName = mgr.name;
        } else {
          managerName = (body.managerName || "").toString().trim();
          if (!managerName) return json({ error: "missing_manager_name" }, 400);
        }

        if (body.id) {
          const nombre = "nombre" in body ? (body.nombre || "").toString().trim() : undefined;
          const telefono = "telefono" in body ? (body.telefono || "").toString().trim() : undefined;
          const result = await updateSubgestor(managerName, body.id, { nombre, telefono });
          if (!result.ok) return json({ error: result.error }, 404);
          return json({ ok: true, subgestor: result.subgestor });
        }

        const nombre = (body.nombre || "").toString().trim();
        if (!nombre) return json({ error: "missing_nombre" }, 400);
        const telefono = (body.telefono || "").toString().trim();
        const result = await addSubgestor(managerName, nombre, telefono);
        if (!result.ok) return json({ error: result.error }, 404);
        return json({ ok: true, subgestor: result.subgestor });
      }
      if (method === "DELETE") {
        const token = url.searchParams.get("token") || "";
        let managerName: string;
        if (token) {
          const mgr = await findManagerByToken(token);
          if (!mgr) {
            const asSubgestor = await findManagerAndSubgestorByToken(token);
            if (asSubgestor) return json({ error: "forbidden" }, 403);
            return json({ error: "invalid_token" }, 401);
          }
          managerName = mgr.name;
        } else {
          managerName = url.searchParams.get("managerName") || "";
          if (!managerName) return json({ error: "missing_manager_name" }, 400);
        }
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "missing_id" }, 400);
        const ok = await deleteSubgestor(managerName, id);
        if (!ok) return json({ error: "not_found" }, 404);

        // Ningun cliente puede quedar "atascado" apuntando a un sub-gestor
        // que ya no existe: liberamos automaticamente a todos los que lo
        // tuvieran asignado.
        const clients = await getAllClients();
        for (const c of clients) {
          if (c.subgestorId === id) {
            c.subgestorId = "";
            c.subgestorNombre = "";
            c.derivadoEn = 0;
            c.resultadoRegistradoEn = 0;
            await saveClient(c);
          }
        }
        return json({ ok: true });
      }
    }

    if (path === "/api/derivar" && method === "POST") {
      // Deriva un cliente a un sub-gestor especifico. Lo puede hacer el
      // administrador o el manager dueño de ese cliente. Un cliente NUNCA
      // puede quedar derivado a dos sub-gestores a la vez: si ya tiene uno
      // asignado, hay que liberarlo primero (/api/liberar) antes de poder
      // reasignarlo.
      const body = await req.json();
      const token = (body.token || "").toString().trim();
      const clientId = (body.clientId || "").toString().trim();
      const subgestorId = (body.subgestorId || "").toString().trim();
      if (!clientId || !subgestorId) return json({ error: "missing_fields" }, 400);

      const existing = await getClient(clientId);
      if (!existing) return json({ error: "not_found" }, 404);

      let managerName = existing.manager;
      if (token) {
        const mgr = await findManagerByToken(token);
        if (!mgr) return json({ error: "invalid_token" }, 401);
        if (existing.manager !== mgr.name) return json({ error: "not_found" }, 404);
        managerName = mgr.name;
      }

      const sub = await findSubgestorById(managerName, subgestorId);
      if (!sub) return json({ error: "not_found" }, 404);

      if (existing.subgestorId) {
        return json(
          {
            error: "ya_derivada",
            message: "Esta cita ya está derivada a otro sub-gestor. Liberala primero para poder reasignarla.",
          },
          409
        );
      }

      // Choque de horario: revisamos si este sub-gestor ya tiene otra cita a
      // una hora o menos de distancia, comparando SOLO contra las citas que
      // tiene asignadas DIRECTAMENTE. Si hay choque y no vino
      // confirmarChoque:true, no guardamos todavia (ver mismo patron en
      // /api/client, arriba).
      const todosLosClientes = await getAllClients();
      const citasDelReceptor = todosLosClientes.filter(
        (cc: any) => cc.subgestorId === subgestorId && cc.id !== existing.id
      );
      const choque = buscarChoqueHorario(citasDelReceptor, existing.fechaCita);
      if (choque && !body.confirmarChoque) {
        return json(
          {
            error: "choque_horario",
            message: `Este sub-gestor ya tiene una cita a las ${choque.hora}, ¿de todos modos querés asignarle esta?`,
            hora: choque.hora,
          },
          409
        );
      }

      const client = { ...existing };
      client.subgestorId = sub.id;
      client.subgestorNombre = sub.nombre;
      client.derivadoEn = Date.now();
      client.resultadoRegistradoEn = 0;
      client.choqueHorario = !!choque;
      await saveClient(client);
      // Aviso por SMS al sub-gestor (si tiene telefono cargado, que es lo
      // normal): se manda DESPUES de guardar y nunca afecta la derivacion
      // si falla (ver enviarAvisoAsignacion en _avisos.mts).
      if (sub.telefono) {
        await enviarAvisoAsignacion(sub.telefono, mensajeAvisoAsignacion(existing));
      }
      return json({ ok: true, client });
    }

    if (path === "/api/liberar" && method === "POST") {
      // Libera un cliente derivado (le quita la asignacion de sub-gestor).
      // Lo puede hacer el administrador o el manager dueño de ese cliente.
      const body = await req.json();
      const token = (body.token || "").toString().trim();
      const clientId = (body.clientId || "").toString().trim();
      if (!clientId) return json({ error: "missing_fields" }, 400);

      const existing = await getClient(clientId);
      if (!existing) return json({ error: "not_found" }, 404);

      if (token) {
        const mgr = await findManagerByToken(token);
        if (!mgr) return json({ error: "invalid_token" }, 401);
        if (existing.manager !== mgr.name) return json({ error: "not_found" }, 404);
      }

      const client = { ...existing };
      client.subgestorId = "";
      client.subgestorNombre = "";
      client.derivadoEn = 0;
      client.resultadoRegistradoEn = 0;
      // Al liberar, la cita vuelve a quedar directamente con el manager: el
      // choque (si lo hubo) era contra el sub-gestor anterior, ya no aplica.
      client.choqueHorario = false;
      await saveClient(client);
      return json({ ok: true, client });
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
  path: [
    "/api/data",
    "/api/client",
    "/api/manager",
    "/api/subgestor",
    "/api/derivar",
    "/api/liberar",
    "/api/backups",
    "/api/backups/restore",
    "/api/parse",
  ],
};
