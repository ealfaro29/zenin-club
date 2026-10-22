import { API_BASE_URL } from './config.js?v=40';
import { l } from './i18n.js?v=40';

export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  if (!API_BASE_URL) {
    const error = new Error(l('La conexión de pedidos aún no está configurada. Inténtalo de nuevo más tarde.', 'The order connection is not configured yet. Please try again later.'));
    error.code = 'API_NOT_CONFIGURED';
    throw error;
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' });
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
    INVALID_PRODUCT: l('Una de las camisetas ya no está disponible. Revisa tu bolsa.', 'One of the tees is unavailable. Please review your bag.'),
    INVALID_COLOR: l('Elige un color de camiseta válido.', 'Choose a valid shirt color.'),
    INVALID_SIZE: l('Elige una talla válida.', 'Choose a valid size.'),
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
  if (error.code === 'INVALID_FIELD') {
    const labels = { name: l('nombre completo', 'full name'), email: l('correo electrónico', 'email'), address: l('dirección', 'address'), apartment: l('apartamento', 'apartment'), city: l('ciudad', 'city'), postal: l('código postal', 'postal code'), country: l('país', 'country'), id: l('referencia del pedido', 'order reference'), token: l('enlace de seguimiento', 'tracking link') };
    const field = labels[error.details?.field] || l('datos del formulario', 'form details');
    return l('Revisa el campo: {field}.', 'Please check: {field}.', { field });
  }
  return messages[error.code] || error.message || l('No se pudo completar la solicitud. Inténtalo de nuevo.', 'The request could not be completed. Please try again.');
}
