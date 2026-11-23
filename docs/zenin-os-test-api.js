'use strict';

const zeninTestOrigin = 'http://127.0.0.1:5183';
const zeninApiSelect = document.getElementById('test-api');
const zeninTestStatus = document.getElementById('test-api-status');
const zeninPassword = document.getElementById('test-password');
let zeninTestToken = '';

zeninApiSelect.addEventListener('change', () => {
  zeninTestToken = '';
  zeninPassword.value = '';
  zeninTestStatus.textContent = '';
});

async function zeninTestRequest(path, options) {
  if (location.origin !== zeninTestOrigin || zeninApiSelect.value !== 'local') {
    throw Error('Abrí el panel desde la API local y seleccioná «Pruebas locales».');
  }
  const url = new URL(path, zeninTestOrigin);
  if (url.origin !== zeninTestOrigin) throw Error('La solicitud debe usar la API local.');
  const marker = await fetch('/zenin-os-test-environment', { redirect: 'error', cache: 'no-store' });
  if (!marker.ok || (await marker.json().catch(() => null))?.environment !== 'zenin-os-local') {
    throw Error('La API local de pruebas no está disponible.');
  }
  return fetch(url, { ...options, redirect: 'error', cache: 'no-store' });
}

document.getElementById('test-login').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  zeninApiSelect.disabled = true;
  zeninTestToken = '';
  try {
    const response = await zeninTestRequest('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pruebas', password: zeninPassword.value })
    });
    if (!response.ok) throw Error('No se pudo iniciar la sesión de pruebas. Revisá la clave temporal.');
    zeninTestToken = (await response.json()).token;
    zeninTestStatus.textContent = 'Sesión local iniciada. Usá únicamente datos ficticios.';
  } catch (error) {
    zeninTestStatus.textContent = error.message;
  } finally {
    zeninPassword.value = '';
    zeninApiSelect.disabled = false;
    button.disabled = false;
  }
});

function zeninAdminRequest(path, options) {
  if (!zeninTestToken) throw Error('Iniciá la sesión de pruebas en este panel.');
  return zeninTestRequest(path, {
    ...options,
    headers: { ...options.headers, Authorization: 'Bearer ' + zeninTestToken }
  });
}
