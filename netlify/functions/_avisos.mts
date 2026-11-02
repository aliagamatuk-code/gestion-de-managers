// Aviso por SMS cuando se le asigna un cliente nuevo a un manager (al
// reasignar desde /api/client) o a un sub-gestor (al derivar desde
// /api/derivar). Usa el mismo patron que la recuperacion de clientes
// (_recuperacion.mts): le pega a un Webhook de GoHighLevel con
// {phone, message} y GHL se encarga de mandar el SMS de verdad.
//
// A diferencia de la recuperacion (que usa una URL fija, ya armada de
// antes), esta usa una variable de entorno (GHL_WEBHOOK_AVISO_ASIGNACION)
// porque el workflow de GHL para esto todavia no existe: hay que crearlo
// una vez, con el mismo formato de webhook entrante ({phone, message}),
// y despues cargar su URL como variable de entorno en Netlify. Mientras
// esa variable no este configurada, esta funcion no revienta nada: solo
// no manda el SMS y deja aviso en los registros (Netlify > Logs).
export function mensajeAvisoAsignacion(client: any): string {
  const partes = [
    "Se te asignó un nuevo cliente:",
    `Nombre: ${client.nombre || ""}`,
    client.telefono ? `Teléfono: ${client.telefono}` : "",
    client.direccion ? `Dirección: ${client.direccion}` : "",
    client.fechaCita ? `Fecha y hora: ${client.fechaCita}` : "",
    client.idioma ? `Idioma preferido: ${client.idioma}` : "",
    client.fuente ? `Fuente: ${client.fuente}` : "",
  ].filter(Boolean);
  return partes.join("\n");
}

// Nunca lanza error hacia arriba: si el webhook no esta configurado, o
// GHL falla, o el telefono esta vacio, solo devuelve false. El guardado
// del cliente/la derivacion NUNCA depende de que este aviso funcione.
export async function enviarAvisoAsignacion(telefono: string, mensaje: string): Promise<boolean> {
  if (!telefono) {
    console.warn("AVISO: no se mando SMS de asignacion, el receptor no tiene telefono cargado.");
    return false;
  }
  const webhookUrl = Netlify.env.get("GHL_WEBHOOK_AVISO_ASIGNACION");
  if (!webhookUrl) {
    console.warn("AVISO: falta configurar GHL_WEBHOOK_AVISO_ASIGNACION, no se pudo avisar por SMS de la asignacion.");
    return false;
  }
  console.log("AVISO: intentando enviar SMS de asignacion a", telefono);

  // Desde el 26-oct la conexion con GHL falla de forma intermitente y al
  // instante ("fetch failed", sin llegar a GHL). Por eso se reintenta, pero
  // SOLO cuando es seguro hacerlo (para no mandar el SMS dos veces):
  //  - error de conexion: la orden no llego a GHL -> se reintenta.
  //  - GHL respondio 429 o 5xx -> se reintenta.
  //  - tiempo agotado (abort) o 4xx -> NO se reintenta (podria haber llegado).
  // Hay un tope de tiempo total para no alargar la respuesta de la funcion.
  const MAX_INTENTOS = 3;
  const PAUSAS_MS = [600, 1500];
  const TOPE_TOTAL_MS = 12000;
  const inicio = Date.now();

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    let reintentable = false;
    try {
      const r = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: telefono, message: mensaje }),
        signal: controller.signal,
      });
      if (r.ok) {
        console.log(
          "AVISO: GHL respondio OK (" + r.status + ") al webhook de asignacion" +
            (intento > 1 ? " [salio en el intento " + intento + "]" : "")
        );
        return true;
      }
      console.warn("AVISO: fallo el envio de SMS de asignacion", r.status, "(intento " + intento + ")");
      reintentable = r.status === 429 || r.status >= 500;
    } catch (e: any) {
      const causa = e?.cause?.code || e?.cause?.message || "";
      const fueTimeout = e?.name === "AbortError";
      console.warn(
        "AVISO: error o tiempo agotado enviando SMS de asignacion",
        e?.message,
        causa ? "| causa: " + causa : "",
        "(intento " + intento + ")"
      );
      reintentable = !fueTimeout;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!reintentable || intento === MAX_INTENTOS) break;
    const pausa = PAUSAS_MS[intento - 1] ?? 1500;
    if (Date.now() - inicio + pausa > TOPE_TOTAL_MS) break;
    await new Promise((res) => setTimeout(res, pausa));
  }

  console.warn("AVISO: NO se pudo enviar el SMS de asignacion a", telefono, "despues de los reintentos.");
  return false;
}
