import { API_BASE_URL } from './config.js?v=46';
import { l, productName, colorLabel } from './i18n.js?v=46';

export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  if (!API_BASE_URL) {
    const error = new Error(l('La conexión de pedidos aún no está configurada. Inténtalo de nuevo más tarde.', 'The order connection is not configured yet. Please try again later.'));
    error.code = 'API_NOT_CONFIGURED';
    throw error;
  }
  const headers = { Accept: 'application/json' };
  const binary = typeof Blob !== 'undefined' && body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = binary ? (body.type || 'application/octet-stream') : 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  } catch (cause) {
    const error = new Error(l('No pudimos conectar con el servidor. Revisa tu conexión y vuelve a intentarlo.', 'We could not connect to the server. Check your connection and try again.'));
    error.code = 'NETWORK_ERROR';
    error.cause = cause;
    throw error;
  }
  let data;
  try { data = await response.json(); }
  catch {
    const error = new Error(l('El servidor devolvió una respuesta inesperada. Inténtalo de nuevo.', 'The server returned an unexpected response. Please try again.'));
    error.code = 'INVALID_RESPONSE';
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const payload = data && typeof data === 'object' ? data : {};
    const details = typeof payload.error === 'object' && payload.error ? payload.error : payload;
    const message = typeof payload.error === 'string' ? payload.error : details.message || payload.message;
    const error = new Error(message || l('No se pudo completar la solicitud. Inténtalo de nuevo.', 'The request could not be completed. Please try again.'));
    error.code = details.code || payload.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.details = details.details || payload.details || details;
    throw error;
  }
  return data;
}

export const getProducts = () => apiRequest('/products');
export const getCollections = () => apiRequest('/collections');
export const getLanding = () => apiRequest('/settings/landing');
export const getPaymentConfig = () => apiRequest('/payments/config');
export const payOrder = ({ id, token }) => apiRequest('/orders/pay', { method: 'POST', body: { id, token } });
export const createOrder = (payload) => apiRequest('/orders', { method: 'POST', body: payload });
export const trackOrder = ({ id, token, email }) => apiRequest('/orders/track', { method: 'POST', body: { id, ...(token ? { token } : {}), ...(email ? { email } : {}) } });

export function apiErrorMessage(error) {
  const messages = {
    API_NOT_CONFIGURED: l('La conexión de pedidos aún no está configurada. Inténtalo de nuevo más tarde.', 'The order connection is not configured yet. Please try again later.'),
    NETWORK_ERROR: l('No pudimos conectar con el servidor. Revisa tu conexión y vuelve a intentarlo.', 'We could not connect to the server. Check your connection and try again.'),
    INVALID_RESPONSE: l('El servidor devolvió una respuesta inesperada. Inténtalo de nuevo.', 'The server returned an unexpected response. Please try again.'),
    SERVICE_UNAVAILABLE: l('El servicio de pedidos no está disponible en este momento. Inténtalo de nuevo.', 'The order service is temporarily unavailable. Please try again.'),
    INTERNAL_ERROR: l('No se pudo completar la solicitud. Puedes volver a intentarlo.', 'The request could not be completed. Please try again.'),
    ORDER_NOT_FOUND: l('No encontramos ese pedido con esos datos. Revisa la referencia y tu correo.', 'We could not find that order with those details. Check the reference and your email.'),
    INVALID_CUSTOMER: l('Completa tus datos de contacto y envío.', 'Complete your contact and shipping details.'),
    INVALID_ITEMS: l('Elige entre 1 y 40 combinaciones de camisetas.', 'Choose between 1 and 40 shirt combinations.'),
    INVALID_PRODUCT: l('Un producto se retiró de la tienda. Elimínalo de tu bolsa para continuar.', 'A product was removed from the store. Remove it from your bag to continue.'),
    INVALID_COLOR: l('Elige un color de camiseta válido.', 'Choose a valid shirt color.'),
    INVALID_SIZE: l('Elige una talla válida.', 'Choose a valid size.'),
    PRODUCT_CHANGED: l('El producto cambió. Actualiza el catálogo y revisa los datos antes de guardar.', 'The product changed. Refresh the catalog and review your details before saving.'),
    INVALID_PRODUCT_DATA: l('Revisa los datos del producto: nombre, precio, colección, color y diseño.', 'Please review the product name, price, collection, color, and graphic.'),
    INVALID_BASE_DATA: l('Revisa el modelo, tipo, gramaje, tallas y colores de la camiseta base.', 'Check the shirt base model, type, fabric weight, sizes and colors.'),
    BASE_COLOR_IN_USE: l('Este color está asociado a un producto. Retíralo de ese producto antes de quitarlo de la base.', 'This color is linked to a product. Remove it from that product before removing it from the base.'),
    BASE_IN_USE: l('Esta base tiene productos asociados y todavía no se puede archivar.', 'This base has linked products and cannot be archived yet.'),
    BASE_CHANGED: l('La base cambió en otro dispositivo. Actualiza los datos antes de guardar.', 'The base changed on another device. Refresh before saving.'),
    BASE_NOT_FOUND: l('No encontramos esta camiseta base. Actualiza los datos.', 'This shirt base was not found. Refresh the data.'),
    BASE_SIZE_IN_USE: l('Hay productos que usan las tallas de esta base. Retíralos antes de cambiar las tallas.', 'Products use this base’s sizes. Remove those products before changing sizes.'),
    INVALID_COLLECTION: l('Elige una colección activa.', 'Choose an active collection.'),
    COLLECTION_IN_USE: l('Esta colección tiene productos activos. Muévelos o archívalos antes de archivarla.', 'This collection has active products. Move or archive them first.'),
    COLLECTION_CHANGED: l('La colección cambió en otro dispositivo. Actualiza antes de guardar.', 'The collection changed on another device. Refresh before saving.'),
    COLLECTION_NOT_FOUND: l('No encontramos esta colección. Actualiza los datos.', 'This collection was not found. Refresh the data.'),
    BACK_PHOTO_REQUIRED: l('Para imprimir en la espalda, cada color elegido necesita su foto de espalda. Súbela en Camisetas.', 'Back prints need a back photo for every selected color. Upload it in Shirts.'),
    ARTICLE_BASE: l('Edita las variantes de este artículo desde Artículos.', 'Edit this article’s variants from Articles.'),
    SLUG_TAKEN: l('Ya existe otro elemento con esa dirección web. Cambia el nombre o la URL.', 'Another item already uses that URL. Change the name or URL.'),
    VIDEO_REQUIRED: l('Elige un video MP4 o WebM.', 'Choose an MP4 or WebM video.'),
    VIDEO_TOO_LARGE: l('El video supera 50 MB. Expórtalo más corto o en menor calidad (1080p H.264 suele bastar).', 'The video exceeds 50 MB. Export it shorter or smaller (1080p H.264 is usually enough).'),
    INVALID_VIDEO: l('El archivo no es un video MP4 o WebM válido.', 'The file is not a valid MP4 or WebM video.'),
    UNPLAYABLE_VIDEO: l('Este video no se puede reproducir en el navegador. Expórtalo como MP4 (H.264).', 'This video cannot play in browsers. Export it as MP4 (H.264).'),
    INVALID_VIDEO_URL: l('Uno de los videos ya no está disponible. Vuelve a subirlo.', 'One of the videos is no longer available. Upload it again.'),
    LENGTH_REQUIRED: l('No se pudo leer el tamaño del video. Vuelve a elegirlo.', 'The video size could not be read. Choose it again.'),
    SETTINGS_CHANGED: l('El landing cambió en otro dispositivo. Recarga antes de publicar.', 'The landing changed on another device. Reload before publishing.'),
    PAYMENT_UNAVAILABLE: l('No pudimos abrir la página de pago. Tu pedido quedó guardado: reintenta el pago desde el seguimiento.', 'We could not open the payment page. Your order is saved: retry the payment from order tracking.'),
    PAYMENTS_DISABLED: l('Los pagos en línea no están activos en este momento.', 'Online payments are not active right now.'),
    ORDER_ALREADY_PAID: l('Este pedido ya está pagado.', 'This order is already paid.'),
    ORDER_NOT_PAYABLE: l('Este pedido ya no se puede pagar. Haz un pedido nuevo.', 'This order can no longer be paid. Please place a new order.'),
    ORDER_NOT_REFUNDABLE: l('Este pedido no tiene un pago aprobado para reembolsar.', 'This order has no approved payment to refund.'),
    REFUND_REJECTED: l('Tilopay rechazó el reembolso. Revisa la transacción en el panel de Tilopay.', 'Tilopay rejected the refund. Check the transaction in the Tilopay dashboard.'),
    PAYMENT_CREDENTIALS_INVALID: l('Tilopay rechazó el usuario o la contraseña API. Cópialos de nuevo desde el panel de Tilopay.', 'Tilopay rejected the API user or password. Copy them again from the Tilopay dashboard.'),
    PAYMENT_KEY_INVALID: l('Tilopay rechazó la key de la integración. Revisa que sea la de Integración con plataformas.', 'Tilopay rejected the integration key. Make sure it is the one under Integración con plataformas.'),
    PAYMENT_CREDENTIALS_MISSING: l('Completa el usuario API, la contraseña API y la key.', 'Enter the API user, API password and key.'),
    PNG_REQUIRED: l('Selecciona un archivo PNG.', 'Select a PNG file.'),
    DESIGN_TOO_LARGE: l('El PNG supera el máximo de 5 MB.', 'The PNG exceeds the 5 MB limit.'),
    DESIGN_DIMENSIONS: l('El PNG supera el límite de dimensiones o 16 megapíxeles.', 'The PNG exceeds the dimension or 16 megapixel limit.'),
    INVALID_DESIGN: l('Selecciona un PNG válido de hasta 5 MB y 16 megapíxeles.', 'Choose a valid PNG up to 5 MB and 16 megapixels.'),
    DESIGN_NOT_FOUND: l('No encontramos el diseño guardado. Vuelve a seleccionar el PNG.', 'The saved design was not found. Select the PNG again.'),
    DESIGN_STORAGE_UNAVAILABLE: l('No pudimos guardar el diseño. Inténtalo de nuevo; tus datos se conservan.', 'The design could not be saved. Try again; your details have been kept.'),
    CATALOG_UNAVAILABLE: l('No pudimos cargar el catálogo actualizado. Inténtalo de nuevo.', 'We could not load the current catalog. Please try again.'),
    PRODUCT_NOT_FOUND: l('Este producto se retiró de la tienda. Elimínalo de tu bolsa para continuar.', 'This product was removed from the store. Remove it from your bag to continue.'),
    INVENTORY_UNAVAILABLE: l('La información de stock no está disponible. Puedes continuar con tu compra.', 'Stock information is unavailable. You can still place your order.'),
    INVALID_QUANTITY: l('El pedido permite hasta 50 camisetas y hasta 10 de cada combinación.', 'Orders allow up to 50 tees and up to 10 of each combination.'),
    INVALID_DISCOUNT: l('El código de descuento no es válido.', 'The discount code is invalid.'),
    INVALID_LANGUAGE: l('Selecciona español o inglés.', 'Choose Spanish or English.'),
    INVALID_IDEMPOTENCY_KEY: l('El identificador de compra no es válido. Vuelve a abrir tu bolsa.', 'The checkout identifier is invalid. Please reopen your bag.'),
    IDEMPOTENCY_CONFLICT: l('Este intento de compra ya está asociado a otro pedido. Revisa tu referencia antes de volver a comprar.', 'This checkout attempt is already linked to another order. Check your reference before placing another order.'),
    RATE_LIMITED: l('Has realizado muchas consultas. Espera un momento y vuelve a intentarlo.', 'Too many requests. Please wait a moment and try again.'),
    ORIGIN_DENIED: l('La conexión con la tienda no está autorizada. Inténtalo de nuevo desde el sitio de Zenin Club.', 'This store connection is not authorized. Please try again from the Zenin Club site.'),
    INVALID_CREDENTIALS: l('El usuario o la contraseña no son correctos.', 'The username or password is incorrect.'),
    UNAUTHORIZED: l('Inicia sesión de nuevo para continuar.', 'Sign in again to continue.'),
    INVALID_STATUS: l('Selecciona un estado de pedido válido.', 'Choose a valid order status.'),
    INVALID_UPDATE: l('No se pudo aplicar ese cambio al pedido.', 'That order update could not be applied.'),
    INVALID_TRACKING: l('Revisa los datos de seguimiento.', 'Please check the tracking details.'),
    ORDER_CHANGED: l('El pedido cambió. Actualiza la página y vuelve a intentarlo.', 'The order changed. Refresh and try again.'),
    JSON_REQUIRED: l('La solicitud no tiene el formato esperado.', 'The request is not in the expected format.'),
    INVALID_JSON: l('La solicitud no tiene el formato esperado.', 'The request is not in the expected format.'),
    BODY_TOO_LARGE: l('La solicitud es demasiado grande. Revisa los datos e inténtalo de nuevo.', 'The request is too large. Check your details and try again.'),
    NOT_FOUND: l('No encontramos la información solicitada.', 'The requested information was not found.'),
    METHOD_NOT_ALLOWED: l('Esta acción no está disponible.', 'This action is unavailable.'),
    ORDER_RESPONSE_INCOMPLETE: l('El servidor no confirmó el pedido. Reintenta para comprobarlo sin duplicarlo.', 'The server did not confirm the order. Retry to check without duplicating it.'),
  };
  if (error.code === 'INSUFFICIENT_STOCK') {
    const items = error.details?.items || error.details?.variants || [];
    const details = items.map(item => l('{name}, {color}, talla {size}: {available} disponibles', '{name}, {color}, size {size}: {available} available', { name: productName({ productId: item.productId, name: item.name || item.productId }), color: colorLabel(item.shirt), size: item.size, available: item.available ?? item.stock ?? 0 })).join('; ');
    return l('No hay stock suficiente para completar el pedido. {details} Tu bolsa se conserva; ajusta las cantidades o elige otra talla.', 'There is not enough stock to complete the order. {details} Your bag is preserved; adjust quantities or choose another size.', { details: details ? `${details}.` : '' });
  }
  if (error.code === 'INVALID_FIELD') {
    const labels = { name: l('nombre completo', 'full name'), email: l('correo electrónico', 'email'), address: l('dirección', 'address'), apartment: l('apartamento', 'apartment'), city: l('ciudad', 'city'), postal: l('código postal', 'postal code'), country: l('país', 'country'), id: l('referencia del pedido', 'order reference'), token: l('enlace de seguimiento', 'tracking link') };
    const field = labels[error.details?.field] || l('datos del formulario', 'form details');
    return l('Revisa el campo: {field}.', 'Please check: {field}.', { field });
  }
  return messages[error.code] || error.message || l('No se pudo completar la solicitud. Inténtalo de nuevo.', 'The request could not be completed. Please try again.');
}
