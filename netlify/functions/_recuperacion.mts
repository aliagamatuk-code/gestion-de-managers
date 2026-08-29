// Mensaje de "recuperacion" para clientes que agendaron una revision de
// agua, no la atendieron (no-show) y no contestan el telefono.
//
// Se envia por SMS a traves de GoHighLevel, usando el workflow
// "RECUPERACION SMS NO ATENDIO" (un webhook entrante que localiza al
// contacto por telefono y le manda el texto que le pasamos aqui) — el
// mismo patron que ya usa el workflow de recordatorios diarios a los
// managers.
const GHL_WEBHOOK_URL =
  "https://services.leadconnectorhq.com/hooks/FKaqd7bO77dlglaZ0xEk/webhook-trigger/3KGD1VqdS1zKwb0Ol1PZ";

// Link de reagendamiento que se agrega al final del mensaje.
const BOOKING_LINK = "https://api.leadconnectorhq.com/widget/booking/38mQym1YLkX4RdLT0Gmc";

// Cuantas veces se manda el mensaje como maximo: 1 inicial + 2 reenvios.
export const MAX_ENVIOS = 3;

// Cuanto se espera entre un envio y el siguiente reenvio.
export const TRES_DIAS_MS = 3 * 24 * 60 * 60 * 1000;

function primerNombre(nombreCompleto: string): string {
  return (nombreCompleto || "").toString().trim().split(/\s+/)[0] || "";
}

// El campo "idioma" del cliente es de TEXTO LIBRE (no un menu fijo), asi
// que puede venir escrito de formas distintas ("English", "ingles",
// "Inglés", etc). Buscamos cualquier variante que empiece pareciendo
// ingles; todo lo demas (incluido vacio) se manda en español, que es el
// idioma por defecto del negocio.
function esIngles(idioma: string): boolean {
  const n = (idioma || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return n.startsWith("ing") || n.startsWith("en");
}

function mensajeES(nombre: string): string {
  return (
    `Hola ${nombre}, pasamos por su casa en la fecha señalada pero no lo encontramos. ` +
    `Sabemos que su agenda diaria es importante y el día se le pudo haber complicado. ` +
    `Tenemos disponibilidad los 7 días, de 8:00 am a 8:45 pm. Para que no pierda su derecho ` +
    `y respetando su tiempo, ¿qué día y hora le queda mejor para reagendar su cita? ` +
    `Reagende en 30 segundos aquí: ${BOOKING_LINK}`
  );
}

function mensajeEN(nombre: string): string {
  return (
    `Hi ${nombre}, we stopped by on your scheduled date but couldn't reach you. ` +
    `We know your day-to-day is busy, and things happen. We're available all 7 days, ` +
    `8:00 am to 8:45 pm. So you don't lose your free check, and respecting your time, ` +
    `what day and time works best to reschedule? Reschedule in 30 seconds here: ${BOOKING_LINK}`
  );
}

export function componerMensajeRecuperacion(client: any): string {
  const nombre = primerNombre(client.nombre);
  return esIngles(client.idioma) ? mensajeEN(nombre) : mensajeES(nombre);
}

// Manda el SMS de recuperacion via el webhook de GHL. Nunca lanza error
// hacia arriba: si algo falla (GHL caido, telefono invalido, etc.) solo
// devuelve false y deja aviso en los registros (Netlify > Logs), para
// que nunca se caiga el guardado del cliente por culpa de este envio.
export async function enviarRecuperacion(client: any): Promise<boolean> {
  if (!client || !client.telefono) return false;
  // Limite de 8 segundos: si GoHighLevel tarda mas que eso en contestar,
  // se cancela el intento (en vez de dejar la funcion colgada esperando,
  // lo cual antes podia arrastrar y romper el guardado del cliente).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: client.telefono,
        message: componerMensajeRecuperacion(client),
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      console.warn("AVISO: fallo el envio de SMS de recuperacion", client.id, r.status);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn("AVISO: error o tiempo agotado enviando SMS de recuperacion", client.id, e.message);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Decide si a este cliente hay que mandarle el mensaje de recuperacion
// AHORA MISMO. Devuelve true/false. No modifica el cliente (eso lo hace
// marcarEnviado, despues de un envio exitoso).
export function debeEnviarAhora(client: any): boolean {
  if (!client || client.estado !== "No atendió") return false;

  // Si la cita se reprogramo (fechaCita cambio) desde la ultima vez que
  // se le mando un mensaje, es un ciclo de "no atendio" nuevo: se trata
  // como si nunca se le hubiera mandado nada.
  const cicloVigente =
    !client.recuperacionFechaCitaEnvio || client.recuperacionFechaCitaEnvio === client.fechaCita;
  const envios = cicloVigente ? client.recuperacionEnvios || 0 : 0;

  if (envios >= MAX_ENVIOS) return false;
  if (envios === 0) return true;

  const ultimo = client.recuperacionUltimoEnvio
    ? new Date(client.recuperacionUltimoEnvio).getTime()
    : 0;
  if (!ultimo) return true; // por seguridad: sin fecha registrada, se trata como nunca enviado

  return Date.now() - ultimo >= TRES_DIAS_MS;
}

// Actualiza los campos de seguimiento de un cliente DESPUES de un envio
// exitoso. Modifica el objeto que se le pasa (no devuelve uno nuevo).
export function marcarEnviado(client: any) {
  const cicloVigente =
    !client.recuperacionFechaCitaEnvio || client.recuperacionFechaCitaEnvio === client.fechaCita;
  client.recuperacionEnvios = (cicloVigente ? client.recuperacionEnvios || 0 : 0) + 1;
  client.recuperacionUltimoEnvio = new Date().toISOString();
  client.recuperacionFechaCitaEnvio = client.fechaCita;
}
