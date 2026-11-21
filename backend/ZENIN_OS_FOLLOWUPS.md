# Seguimiento único de clientes interesados — ZENIN CLUB OS

## Política definitiva
- **Un único mensaje de seguimiento a las 48 horas** desde la última interacción del cliente si consultó por un producto o recibió cotización y no respondió.
- **No enviar un segundo recordatorio a las 72 horas** ni reprogramar intentos de recuperación para la misma consulta.
- Si el cliente responde, compra, rechaza recibir mensajes o se cierra la consulta, cancelar el seguimiento.
- No enviar mensajes a clientes sin consentimiento válido; respetar baja, horario apropiado y políticas de WhatsApp.
- El seguimiento automático solo podrá activarse tras conectar oficialmente Meta WhatsApp Business Platform y contar con la plantilla aprobada correspondiente. Antes de ello, ninguna tarea debe enviar mensajes.
- Duplicados: garantizar un máximo de un seguimiento por solicitud, incluso con reintentos o webhooks repetidos.

## Plantilla propuesta (sujeta a aprobación de Meta)
¡Hola! 😊 ¿Cómo estás?

Te saludamos de Zenin Club. Queríamos saber si todavía te interesa la camiseta por la que nos consultaste.

Si tenés alguna pregunta sobre tallas, diseños o cómo realizar tu pedido, con mucho gusto te ayudamos.

¡Que tengás un excelente día! ⚡

## Implementación pendiente
El esquema SQL existente permite stage 1 y 2; la siguiente migración elimina stage 2 de los registros futuros y cancela los ya programados. El motor de envíos aún no está implementado ni desplegado.
