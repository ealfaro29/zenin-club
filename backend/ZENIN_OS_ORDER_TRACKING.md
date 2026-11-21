# Zenin Club OS — consulta pública del estado de pedido (diseño aprobado)

## Objetivo
Incorporar «Rastreá tu pedido» en zeninclub.shop para pedidos de redes sociales y web, sin exigir contacto por WhatsApp.

## Acceso y privacidad
- Requerir **número de pedido + secreto de seguimiento aleatorio** emitido al confirmar el pago; no exponer estado usando solo un ID secuencial.
- Guardar solo hash del secreto en servidor; enviarlo una vez al cliente por el canal de compra.
- Respuesta pública mínima: número, estado, hitos y tipo de entrega; no mostrar dirección, teléfono, correo, referencias bancarias ni comprobantes.
- Limitar intentos por IP/identificador, respuestas genéricas para datos incorrectos y no registrar secretos.
- La infraestructura de pedidos legacy ya tiene tracking_hash; evaluar compatibilidad antes de implementar.

## Flujo
1. Consulta o cotización: **sin número de pedido**.
2. Redes sociales: 50% SINPE efectivamente verificado por administrador; web: 100% Tilopay confirmado por servidor.
3. Conversión idempotente a pedido oficial: generar número y secreto privado de seguimiento.
4. Estado público: confirmado → en producción → listo para retiro/envío → entregado. Diferenciar retiro en taller de envío a domicilio.
5. Si se envía por Correos, mostrar guía y enlace de rastreo solo cuando se registren y verifiquen.
6. Actualizaciones posteriores en panel administrativo; WhatsApp automático solo tras conexión oficial y permisos.

## Pendiente de implementación
- Rutina transaccional de conversión sin duplicados; adaptar modelo legacy orders sin activar reservas de inventario para pedidos bajo encargo.
- Endpoint público de consulta con validación del secreto y protección contra enumeración.
- Interfaz de consulta en frontend, pruebas y revisión de seguridad.
- No desplegar ni modificar main sin autorización explícita.
