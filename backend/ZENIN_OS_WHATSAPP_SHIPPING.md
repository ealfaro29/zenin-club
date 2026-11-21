# ZENIN CLUB OS — WhatsApp y despachos (MVP prioritario)

## Alcance
La tienda web conserva Tilopay y cobra el 100%. Ventas atendidas por WhatsApp, Facebook o Instagram requieren un adelanto SINPE del 50% verificado por una persona. El número de pedido oficial se asigna **después** de verificar el pago correspondiente. No confundir comprobante recibido con pago confirmado.

## Captura de pedidos
- Canal y referencia de conversación; nombre y teléfono del cliente.
- Producto o diseño, talla, color, cantidad, personalización y notas.
- Cotización aceptada, moneda, precio, adelanto requerido, estado de verificación.
- Datos de envío: nombre completo, teléfono, país, provincia, cantón, distrito, dirección exacta, código postal cuando aplique y referencias.
- Preguntar solamente por campos faltantes; ofrecer revisión y confirmación antes de guardar una dirección como confirmada.
- No solicitar números de cuenta, credenciales ni datos de tarjetas por chat.

## Estados operativos
1. Solicitud incompleta: redactar pregunta específica sobre datos faltantes.
2. Cotización pendiente: preparar resumen para aprobación del vendedor.
3. Adelanto pendiente: solicitar comprobante; verificación bancaria humana.
4. Pedido en producción: avisos según cambios reales de estado.
5. Producción terminada: solicitar saldo restante.
6. Saldo verificado + dirección confirmada: habilitar preparación de guía.
7. Guía registrada: compartir número de tracking y enlace oficial verificado.
8. Entrega: seguimiento cuando exista evidencia de entrega.

## WhatsApp Business
Primera fase: mensajes preparados para copiar y enviar manualmente, tareas de seguimiento y registro de respuestas por el operador. Segunda fase: conectar Meta WhatsApp Business Platform con coexistencia con la app solo si la cuenta/número son elegibles. Webhooks verificados, opt-in, control de duplicados, protección de datos, plantillas aprobadas para conversaciones fuera de la ventana de atención y posibilidad de intervención humana. Nunca inferir que ya hay acceso a conversaciones por tener GitHub conectado.

## Correos de Costa Rica
MVP: recopilar y validar dirección, preparar datos para Sucursal Virtual, crear la guía manualmente en el portal autorizado, registrar el número y compartir el seguimiento. No afirmar que se generó una guía antes de contar con confirmación de Correos. No automatizar el portal por scraping. Evaluar API oficial o convenio empresarial en una etapa posterior.

## Reglas de bloqueo
- Sin pago inicial verificado, no existe pedido oficial ni orden de producción.
- Sin saldo total verificado, no se habilita despacho.
- Sin dirección confirmada, no se prepara guía.
- No enviar mensajes sin revisión/consentimiento y conexión autorizada.
- Evitar duplicados por identificador de mensaje y eventos idempotentes.
- Conservar historial de cambios y restringir acceso a datos personales.

## Implementación técnica
- Migración 0012: clientes, solicitudes, cotizaciones y pagos manuales.
- Migración 0013: perfiles de envío, envíos y tareas de mensajería.
- Próximo código: rutas administrativas autenticadas para capturar respuestas, completar dirección y generar tareas; pruebas de autorización y validación de estados.
- Después: panel de trabajo con bandejas «faltan datos», «pagos por verificar», «listos para guía» y «seguimiento pendiente».
- Las migraciones están diseñadas para añadirse a D1, pero **no están aplicadas ni probadas**; ejecutar pruebas en una base de desarrollo antes de cualquier despliegue.
