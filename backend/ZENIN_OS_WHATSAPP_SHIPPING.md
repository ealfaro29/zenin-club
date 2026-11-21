# ZENIN CLUB OS — WhatsApp y despachos (MVP prioritario)

## Regla principal: usar los mensajes reales del vendedor
El asistente no debe inventar una modalidad de retiro en sucursal de Correos. Para pedidos por WhatsApp, Facebook e Instagram en Costa Rica, ofrecer:
1. Retiro en taller, Santa Bárbara de Heredia, sin costo adicional.
2. Envío a domicilio, tarifa comunicada actualmente de ₡2.500, sujeta a cobertura y confirmación.

**Plantilla 1 — modalidad**
> Para la entrega manejamos dos modalidades:
>
> • Retiro en taller: En Santa Bárbara de Heredia (sin costo adicional).
> • Envío a domicilio: Por ₡2.500 hasta la puerta de tu casa. 🚚
>
> ¿Te gustaría retirar o prefieres que te lo enviemos? ⚡

**Plantilla 2 — datos para envío**
> Para hacer el envío necesitamos la siguiente información
>
> Nombre completo
> Número telefónico
> Dirección exacta con cantón, ciudad y distrito

Enviar la plantilla 2 solo cuando el cliente elige envío a domicilio y falten datos. Si ya facilitó datos, preguntar únicamente por los campos faltantes. Interpretar respuestas coloquiales (p. ej., «me lo envían», «paso a recoger») con posibilidad de confirmación humana ante ambigüedad. No marcar una dirección como completa hasta que el cliente la confirme.

## Datos de entrega
- `delivery_mode = workshop_pickup`: registrar nombre, teléfono, retiro en taller; no pedir dirección.
- `delivery_mode = home_delivery`: registrar nombre, teléfono, provincia/cantón/distrito y dirección exacta con referencias si son necesarias.
- La modalidad se selecciona explícitamente; `NULL` significa que aún no hay respuesta.
- El campo `carrier` de envíos es interno, no una opción de entrega ofrecida al cliente.
- Para pedidos internacionales de la web: cotizar envío por país y mantener Tilopay al 100%; no aplicar automáticamente tarifa de ₡2.500.
- Validar cobertura y tarifa de Correos antes de emitir una guía.

## Reglas de pago y pedido
- Web: Tilopay 100% confirmado antes de crear pedido oficial.
- Ventas por chat: 50% SINPE verificado manualmente antes de crear pedido oficial.
- Comprobante recibido no equivale a pago confirmado.
- No despachar hasta confirmar el saldo total.
- Retiro en taller no necesita guía de Correos.
- Envío a domicilio: datos completos + saldo confirmado + producción lista antes de preparar la guía.

## WhatsApp y Correos
Fase 1: bandeja administrativa con mensajes preparados para revisión/copia y registro manual de respuestas. Fase 2: Meta WhatsApp Business Platform, únicamente tras confirmar elegibilidad de coexistencia con la app, consentimiento, plantillas y webhooks verificados. No existe aún acceso a conversaciones reales.

Correos: preparar información para Sucursal Virtual, registrar manualmente la guía y seguimiento; no afirmar creación automática de guías ni utilizar scraping no autorizado. Las migraciones y handlers aún requieren integración y pruebas en D1 de desarrollo.
