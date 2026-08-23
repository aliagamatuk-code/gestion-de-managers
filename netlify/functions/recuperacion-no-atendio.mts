// Funcion programada (corre sola, todos los dias) que revisa a los
// clientes marcados "No atendió" y les reenvia el SMS de recuperacion
// si ya pasaron 3 dias desde el ultimo envio (hasta un maximo de 2
// reenvios). El PRIMER envio (el inmediato, apenas se marca "No
// atendió") lo hace api.mts en el momento — esta funcion solo se
// encarga de los reenvios de seguimiento, y sirve tambien de red de
// seguridad por si algun cliente quedo sin su primer mensaje.
import type { Config } from "@netlify/functions";
import { getAllClients, saveClient } from "./_store-helpers.mts";
import { debeEnviarAhora, marcarEnviado, enviarRecuperacion } from "./_recuperacion.mts";

export default async () => {
  const clients = await getAllClients();
  let enviados = 0;

  for (const client of clients) {
    if (!debeEnviarAhora(client)) continue;
    const ok = await enviarRecuperacion(client);
    if (ok) {
      marcarEnviado(client);
      await saveClient(client);
      enviados++;
    }
  }

  console.log(
    `Recuperacion no atendio: ${enviados} mensaje(s) enviado(s) de ${clients.length} cliente(s) revisado(s).`
  );
};

export const config: Config = {
  // Todos los dias a las 14:00 UTC = 10:00 am hora del Este (EDT).
  schedule: "0 14 * * *",
};
