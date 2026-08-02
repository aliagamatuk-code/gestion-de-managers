Configuracion critica - NO TOCAR sin leer esto
Este documento explica como funciona la automatizacion de reservas que alimenta esta app (GoHighLevel -> Netlify -> Gestion de Managers). Si algo deja de funcionar (por ejemplo, si un cliente que agendo no aparece), revisa primero esta lista antes de cambiar nada.
Cual es el sitio correcto
Este repositorio (aliagamatuk-code/gestion-de-managers) es el que alimenta la app real que usa Omar todos los dias: https://regal-hamster-65a058.netlify.app

Existe otro repositorio viejo (aliagamatuk24/leads-for-managers) que se construyo por error en un sitio distinto (gestion-managers-quantica360.netlify.app). Ese sitio viejo ya NO se usa y se dejo sin tocar, solo como historial. No hay que confundirlo con este.
Que hace el sistema, en resumen
Paso 1. Un cliente reserva una cita de "Water Quality Assessment" en el calendario de un manager especifico en GoHighLevel (GHL). Cada manager tiene su propio enlace de reservas.

Paso 2. El Workflow "03 Appointment Booking" en GHL detecta esa reserva, espera 3 minutos, guarda el idioma y la hora en dos campos personalizados del contacto, y manda toda la informacion a la funcion appointment.mts en Netlify por medio de un Webhook.

Paso 3. La funcion appointment.mts identifica automaticamente a que manager corresponde la cita (usando el calendario) y guarda al cliente en el almacen de datos (Netlify Blobs, store "gestion-managers").

Paso 4. La pantalla que usa Omar (index.html y app-web.js) muestra esos datos, organizados por manager.
Configuracion critica en GoHighLevel (NO cambiar sin avisar)
Workflow: "03 Appointment Booking", ubicacion Quantica360.

El disparador (trigger) debe ser "Estado de la cita", con el filtro "El estado de la cita es" en "confirmado".

El paso "Esperar" debe quedar en 3 minutos.

El paso "Actualizar campo de contacto" copia el idioma y la hora de la cita a los campos personalizados Language Text Sync y Appointment Time Text Sync.

El paso "Webhook" debe apuntar exactamente a esta direccion: https://regal-hamster-65a058.netlify.app/api/appointment?token=Q360-Citas-8f2k91

Y debe mandar estos Datos personalizados (custom data), con estos nombres exactos: calendarId (igual a appointment.calendar_id), nombre (igual a contact.first_name + contact.last_name), telefono (igual a contact.phone), direccion (igual a contact.full_address), fechaCita (igual a Appointment Time Text Sync), idioma (igual a Language Text Sync).
Muy importante: el manager se identifica por el calendario
La funcion appointment.mts EXIGE poder identificar automaticamente a que manager pertenece la cita. Para eso usa el calendarId de la cita y lo compara contra la lista publicada en https://calendarios-managers-quantica360.netlify.app/api/managers

Si el calendario de la cita no esta en esa lista (por ejemplo, si se usa por error el enlace general "CITAS QUANTICA GENERAL" en vez del enlace individual de un manager), la cita se rechaza con un error 400 "missing_fields" y NUNCA se guarda. En GoHighLevel esto se ve como un pequeno "Error" en el paso Webhook dentro de Registros de ejecucion, sin ningun otro aviso visible.

Confirmado el 1 de agosto de 2026: los clientes reales agendan por los enlaces individuales de cada manager, asi que en condiciones normales esto no afecta las reservas reales. Pero si algun dia se comparte por error el enlace general, esas citas se van a perder en silencio. Si un manager nuevo se agrega, hay que asegurarse de que su calendario quede registrado en esa lista de managers.
Riesgo conocido, todavia sin arreglar: guardados que se pisan entre si
Netlify Blobs (donde se guardan los datos) no tiene ningun control de bloqueo automatico. Cada vez que se guarda algo (Omar editando la pantalla, o una cita nueva llegando por Webhook) se reescribe TODA la lista de clientes de una sola vez. Si dos guardados ocurren casi al mismo tiempo, el segundo puede borrar sin querer lo que el primero acababa de agregar.

Esto se confirmo el 1 de agosto de 2026: una cita de prueba que llego correctamente por el Webhook desaparecio porque Omar estaba usando la pantalla al mismo tiempo. Es muy probable que esto explique citas reales que no aparecieron en el pasado.

La solucion planeada (todavia no implementada) es guardar cada cliente en su propio espacio individual dentro de Netlify Blobs, en vez de un solo archivo con todos los clientes juntos, para que un guardado nunca pueda borrar a otro. Este cambio toca tres archivos: appointment.mts, api.mts y app-web.js, y hay que probarlo con calma en un momento en que la app no este en uso activo, antes de publicarlo.

Mientras tanto, si notas que un cliente que agendo no aparece, revisa primero si alguien tenia la pantalla abierta y guardando cambios en esos mismos minutos.
Como llegan los datos a Netlify (esto costo mucho tiempo descubrirlo)
GoHighLevel no manda los Datos personalizados sueltos en el JSON del webhook. Los manda todos juntos, anidados dentro de un objeto llamado customData. El JSON que llega tiene una parte asi:

customData: { calendarId: "...", nombre: "...", telefono: "...", direccion: "...", fechaCita: "...", idioma: "..." }

La funcion appointment.mts busca cada dato dentro de body.customData. Si en el futuro se agrega un nuevo Dato personalizado en el Webhook de GHL, debe leerse igual: dentro de customData, no suelto.
Si algo se rompe, revisa en este orden
Primero: en Netlify (proyecto regal-hamster-65a058), Deploys, revisa si el ultimo deploy dice "Published" en verde, o si fallo.

Segundo: en GHL, Automatizacion, 03 Appointment Booking, Registros de ejecucion, busca el contacto y revisa si el workflow dice "Finalizado" o se quedo pegado, y si el paso Webhook tiene la marca roja de "Error".

Tercero: en Netlify, Logs and metrics, Functions, appointment, cambia la vista de "Real-time" a "Last day" (Real-time no muestra historial), y revisa si hubo invocaciones cerca de la hora esperada.

Cuarto: si el workflow no se dispara, revisa que el filtro "El estado de la cita es" siga en "confirmado".

Quinto: si el workflow se dispara pero la cita no aparece, revisa que el calendario usado sea el enlace individual de un manager (no el enlace general), y que ese manager este en la lista de calendarios-managers-quantica360.netlify.app/api/managers.

Sexto: si todo lo anterior esta bien, revisa si alguien tenia la pantalla de la app abierta guardando cambios al mismo tiempo (ver seccion de "guardados que se pisan entre si" arriba).
