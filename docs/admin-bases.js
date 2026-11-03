import { l, formatDate } from './i18n.js?v=45';
import { apiErrorMessage } from './orders-api.js?v=45';

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const SIZE_CHOICES = ['XS', ...SIZES, 'XXXL'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const key = () => crypto.randomUUID();
const date = value => { try { return formatDate(value); } catch { return '—'; } };
const safeImage = value => { try { const url = new URL(String(value)); return ['https:', 'http:', 'blob:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const blankColor = () => ({ _key: key(), name: '', hex: '#222222', imageUrl: '', file: null, preview: '', dimensions: '', checking: false, error: '' });
const blankForm = () => ({ id: '', version: null, name: '', type: '', weightGsm: '180', sizes: [...SIZES], customSizes: [], colors: [blankColor()] });

/** Reusable garment models. All writes use the parent admin's authenticated request. */
export function createAdminBases({ request, onChange: onRender = () => {}, announce = () => {} } = {}) {
  let alive = true;
  let loadSequence = 0;
  let mutationSequence = 0;
  let imageSequence = 0;
  const state = { bases: [], loaded: false, loading: false, error: '', updatedAt: '', form: null, dirty: false, busy: '', formError: '', discardPrompt: false, archiveId: '', archiveError: '', createKey: '', uploaded: 0, uploadTotal: 0, sizeDraft: '', sizeError: '' };
  const changed = () => { if (alive) onRender(); };
  const isBusy = () => !!state.busy || !!state.form?.colors.some(color => color.checking);
  const imageOf = color => safeImage(color.preview || color.imageUrl);
  const releaseColor = color => { if (color.preview?.startsWith('blob:')) URL.revokeObjectURL(color.preview); color.preview = ''; };
  const releaseForm = () => { state.form?.colors.forEach(releaseColor); imageSequence++; };
  const setDirty = () => { state.dirty = true; state.createKey = ''; state.discardPrompt = false; state.formError = ''; };
  const errorText = error => {
    const messages = {
      BASE_CHANGED: l('Esta base cambió en otro dispositivo. Actualiza la lista y vuelve a abrirla antes de guardar.', 'This base changed on another device. Refresh the list and reopen it before saving.'),
      BASE_COLOR_IN_USE: l('Un color que intentas quitar está en uso por un producto. Conserva ese color o retíralo primero del producto.', 'A color you are removing is in use by a product. Keep it or remove it from the product first.'),
      BASE_SIZE_IN_USE: l('Una talla que intentas quitar está en uso por un producto. Conserva esa talla o actualiza primero el producto.', 'A size you are removing is in use by a product. Keep it or update the product first.'),
      BASE_IN_USE: l('Hay productos que usan esta base. Retira la base de esos productos antes de archivarla.', 'Products are using this base. Remove the base from those products before archiving it.'),
      INVALID_BASE: l('Revisa el nombre, tipo, gramaje, tallas y colores de la camiseta base.', 'Check the base garment name, type, fabric weight, sizes and colors.'),
      INVALID_FIELD: l('Revisa el nombre, tipo, gramaje, tallas y colores de la camiseta base.', 'Check the base garment name, type, fabric weight, sizes and colors.'),
      BASE_NOT_FOUND: l('Esta base ya no está disponible. Actualiza la lista.', 'This base is no longer available. Refresh the list.'),
      INVALID_DESIGN: l('Usa una imagen PNG de hasta 5 MB, 8192 px por lado y 16 megapíxeles.', 'Use a PNG up to 5 MB, 8192 px per side and 16 megapixels.'),
      PNG_REQUIRED: l('La imagen de cada color debe ser un archivo PNG.', 'Each color image must be a PNG file.'),
      DESIGN_DIMENSIONS: l('La imagen supera 8192 px por lado o 16 megapíxeles.', 'The image exceeds 8192 px per side or 16 megapixels.'),
    };
    return messages[error?.code] || apiErrorMessage(error || {});
  };

  function colorHTML(color, index) {
    const disabled = state.busy ? 'disabled' : '';
    const image = imageOf(color);
    return `<fieldset class="admin-base-color-row"><legend>${l('Color', 'Color')} ${index + 1}</legend>
      <div class="admin-base-color-preview ${image ? 'has-image' : ''}">${image ? `<img src="${esc(image)}" alt="${esc(color.name || l('Camiseta base', 'Base garment'))}">` : `<span>${l('Imagen de la camiseta', 'Garment image')}</span>`}</div>
      <div class="admin-base-color-fields"><label for="admin-base-color-name-${color._key}"><span>${l('Nombre del color', 'Color name')}</span><input id="admin-base-color-name-${color._key}" data-base-color="${color._key}" data-base-color-field="name" value="${esc(color.name)}" maxlength="80" required placeholder="${l('Ej.: Negro', 'For example: Black')}" ${disabled}></label>
      <label class="admin-base-hex-label" for="admin-base-color-hex-${color._key}"><span>${l('Muestra de color', 'Color swatch')}</span><input id="admin-base-color-hex-${color._key}" data-base-color="${color._key}" data-base-color-field="hex" type="color" value="${esc(color.hex)}" aria-label="${l('Muestra del color', 'Color swatch')} ${index + 1}" ${disabled}><small data-base-hex="${color._key}">${esc(color.hex.toUpperCase())}</small></label>
      <label class="admin-base-upload" for="admin-base-image-${color._key}"><span>${image ? l('Cambiar imagen PNG', 'Replace PNG image') : l('Subir imagen PNG', 'Upload PNG image')}</span><input id="admin-base-image-${color._key}" data-base-image="${color._key}" type="file" accept="image/png,.png" ${disabled}></label>
      <small class="admin-base-image-meta" role="status">${color.checking ? l('Revisando imagen…', 'Checking image…') : esc(color.file?.name || color.dimensions || (color.imageUrl ? l('Imagen guardada', 'Saved image') : l('Sin imagen seleccionada', 'No image selected')))}</small>
      ${color.error ? `<p class="admin-base-color-error" role="alert">${esc(color.error)}</p>` : ''}</div>
      <button type="button" class="admin-base-remove-color" data-base-action="remove-color" data-base-key="${color._key}" ${disabled || state.form.colors.length < 2 ? 'disabled' : ''} aria-label="${l('Quitar color', 'Remove color')} ${index + 1}">×</button>
    </fieldset>`;
  }

  function formHTML() {
    const form = state.form;
    if (!form) return '';
    const disabled = state.busy ? 'disabled' : '';
    return `<section class="admin-panel admin-base-editor"><div class="admin-base-section-heading"><div><span class="admin-eyebrow">ZENIN CLUB / ${l('BASES', 'BASE GARMENTS')}</span><h2>${form.id ? l('Editar camiseta base', 'Edit base garment') : l('Crear camiseta base', 'Create base garment')}</h2><p>${l('Define el modelo una vez y úsalo en todos tus diseños.', 'Define the garment once and reuse it across your designs.')}</p></div></div>
      ${state.formError ? `<div class="admin-base-alert" role="alert">${esc(state.formError)}</div>` : ''}
      <form id="admin-base-form"><div class="admin-base-fields">
        <label for="admin-base-name"><span>${l('Nombre del modelo', 'Model name')}</span><input id="admin-base-name" data-base-field="name" value="${esc(form.name)}" minlength="2" maxlength="120" required placeholder="${l('Ej.: Essential Oversize', 'For example: Essential Oversize')}" ${disabled}></label>
        <label for="admin-base-type"><span>${l('Tipo o corte', 'Type or fit')}</span><input id="admin-base-type" data-base-field="type" value="${esc(form.type)}" minlength="2" maxlength="80" required placeholder="${l('Ej.: Oversize, regular, boxy…', 'For example: Oversize, regular, boxy…')}" ${disabled}></label>
        <label for="admin-base-weight"><span>${l('Gramaje', 'Fabric weight')} <small>g/m²</small></span><input id="admin-base-weight" data-base-field="weightGsm" type="number" min="1" max="2000" step="1" inputmode="numeric" value="${esc(form.weightGsm)}" required ${disabled}></label>
      </div>
      <fieldset class="admin-base-sizes"><legend>${l('Tallas disponibles', 'Available sizes')}</legend><div>${[...new Set([...SIZE_CHOICES, ...(form.customSizes || []), ...form.sizes])].map(size => `<label><input type="checkbox" data-base-size="${esc(size)}" ${form.sizes.includes(size) ? 'checked' : ''} ${disabled}><span>${esc(size)}</span></label>`).join('')}</div>
        <div class="admin-base-custom-size"><label for="admin-base-custom-size"><span>${l('Agregar otra talla', 'Add another size')}</span><input id="admin-base-custom-size" data-base-custom-size value="${esc(state.sizeDraft)}" maxlength="24" placeholder="${l('Ej.: 4 años, 4XL, única…', 'For example: Age 4, 4XL, one size…')}" aria-describedby="admin-base-size-note${state.sizeError ? ' admin-base-size-error' : ''}" ${disabled}></label><button type="button" class="admin-button admin-button-light" data-base-action="add-size" ${disabled}>+ ${l('Agregar talla', 'Add size')}</button></div>
        <p id="admin-base-size-note" class="admin-base-size-note">${l('Hasta 20 tallas por base. Desmarca una talla para dejar de ofrecerla.', 'Up to 20 sizes per garment. Uncheck a size to stop offering it.')}</p>${state.sizeError ? `<p id="admin-base-size-error" class="admin-base-color-error" role="alert">${esc(state.sizeError)}</p>` : ''}
      </fieldset>
      <div class="admin-base-section-heading admin-base-colors-heading"><div><h3>${l('Colores de esta base', 'Colors for this garment')}</h3><p>${l('Sube una imagen de la camiseta sin diseño para cada color. Usa el mismo encuadre y fondo transparente para obtener vistas previas consistentes.', 'Upload a blank garment image for each color. Use matching framing and a transparent background for consistent previews.')}</p></div><button type="button" class="admin-button admin-button-light" data-base-action="add-color" ${disabled || form.colors.length >= 30 ? 'disabled' : ''}>+ ${l('Agregar color', 'Add color')}</button></div>
      <div class="admin-base-color-list">${form.colors.map(colorHTML).join('')}</div><p class="admin-base-file-note">${l('PNG de hasta 5 MB por imagen. Máximo 8192 px por lado y 16 megapíxeles.', 'PNG up to 5 MB per image. Maximum 8192 px per side and 16 megapixels.')}</p>
      <div class="admin-base-form-footer"><p role="status">${state.busy === 'upload' ? l('Guardando imágenes {done}/{total}…', 'Saving images {done}/{total}…', { done: state.uploaded, total: state.uploadTotal }) : l('Los productos podrán usar estas bases y colores desde su formulario.', 'Products can select these garments and colors in their editor.')}</p><button type="button" class="admin-button admin-button-light" data-base-action="cancel-edit" ${disabled}>${l('Cancelar', 'Cancel')}</button><button type="submit" class="admin-button admin-button-primary" ${isBusy() ? 'disabled' : ''}>${state.busy ? l('Guardando…', 'Saving…') : form.id ? l('Guardar base', 'Save garment') : l('Crear base', 'Create garment')} <span aria-hidden="true">→</span></button></div>
      ${state.discardPrompt ? `<div class="admin-base-discard" role="alert"><p>${l('¿Descartar los cambios de esta camiseta base?', 'Discard changes to this base garment?')}</p><button type="button" class="admin-button admin-button-light" data-base-action="keep-edit">${l('Seguir editando', 'Keep editing')}</button><button type="button" class="admin-button admin-button-danger" data-base-action="discard-edit">${l('Descartar', 'Discard')}</button></div>` : ''}
      </form></section>`;
  }

  function baseHTML(base) {
    const images = (base.colors || []).slice(0, 4).map(color => ({ ...color, imageUrl: safeImage(color.imageUrl) }));
    return `<article class="admin-base-card"><div class="admin-base-card-images">${images.map(color => color.imageUrl ? `<img src="${esc(color.imageUrl)}" alt="${esc(color.name)}" loading="lazy">` : '<span class="admin-base-empty-image"></span>').join('')}</div><div class="admin-base-card-content"><div class="admin-base-card-heading"><h2>${esc(base.name)}</h2><span>${Number(base.weightGsm) > 0 ? `${esc(base.weightGsm)} g/m²` : '—'}</span></div><p>${esc(base.type)}</p><div class="admin-base-card-swatches">${(base.colors || []).map(color => `<span title="${esc(color.name)}"><i style="background:${/^#[0-9a-f]{6}$/i.test(color.hex) ? color.hex : '#555'}"></i>${esc(color.name)}</span>`).join('')}</div><p class="admin-base-card-sizes">${l('Tallas', 'Sizes')}: ${(base.sizes || []).map(esc).join(' · ')}</p><div class="admin-base-card-actions"><button type="button" class="admin-button admin-button-light" data-base-action="edit" data-base-id="${esc(base.id)}" ${isBusy() || state.dirty ? 'disabled' : ''}>${l('Editar base', 'Edit garment')}</button><button type="button" class="admin-base-archive" data-base-action="ask-archive" data-base-id="${esc(base.id)}" ${isBusy() || state.dirty ? 'disabled' : ''}>${l('Archivar', 'Archive')}</button></div></div></article>`;
  }

  function archiveHTML() {
    const base = state.bases.find(base => base.id === state.archiveId);
    if (!base) return '';
    return `<section class="admin-base-archive-confirm" role="alert"><h3>${l('Archivar', 'Archive')} ${esc(base.name)}</h3><p>${l('Dejará de estar disponible para crear productos. Las bases que estén en uso por productos activos deben retirarse de esos productos primero.', 'It will no longer be available for new products. Garments used by active products must first be removed from those products.')}</p>${state.archiveError ? `<p class="admin-base-color-error">${esc(state.archiveError)}</p>` : ''}<div><button type="button" class="admin-button admin-button-light" data-base-action="cancel-archive" ${state.busy ? 'disabled' : ''}>${l('Conservar base', 'Keep garment')}</button><button type="button" class="admin-button admin-button-danger" data-base-action="confirm-archive" ${state.busy ? 'disabled' : ''}>${state.busy === 'archive' ? l('Archivando…', 'Archiving…') : l('Sí, archivar', 'Yes, archive')}</button></div></section>`;
  }

  function html() {
    return `<section class="admin-bases" aria-label="${l('Camisetas base', 'Base garments')}"><div class="admin-base-toolbar"><p>${l('Modelos, gramajes y colores compartidos por todo tu catálogo.', 'Garment models, fabric weights and colors shared across your catalog.')}</p><div><button type="button" class="admin-button admin-button-light" data-base-action="refresh" ${state.loading || isBusy() ? 'disabled' : ''}>↻ ${l('Actualizar', 'Refresh')}</button><button type="button" class="admin-button admin-button-primary" data-base-action="create" ${isBusy() || state.dirty ? 'disabled' : ''}>+ ${l('Crear base', 'Create garment')}</button></div></div>
      ${state.error ? `<div class="admin-base-alert" role="alert">${esc(state.error)}</div>` : ''}${formHTML()}${archiveHTML()}
      ${state.loading && !state.loaded ? `<div class="admin-panel admin-empty" role="status"><span class="admin-spinner"></span><h2>${l('Cargando camisetas base…', 'Loading base garments…')}</h2></div>` : state.loaded && !state.bases.length ? `<div class="admin-panel admin-empty"><h2>${l('Primero, tus camisetas base', 'Start with your base garments')}</h2><p>${l('Crea cada modelo con su tipo, gramaje, tallas y colores. Después podrás aplicar tus diseños PNG sobre estas imágenes.', 'Create each model with its type, fabric weight, sizes and colors. Then apply your PNG designs to those images.')}</p>${!state.form ? `<button type="button" class="admin-button admin-button-primary" data-base-action="create">+ ${l('Crear primera base', 'Create first garment')}</button>` : ''}</div>` : `<div class="admin-base-grid">${state.bases.map(baseHTML).join('')}</div>`}
      ${state.updatedAt ? `<p class="admin-sync-note">${l('Actualizado', 'Updated')}: ${esc(date(state.updatedAt))} · ${l('Compartido entre dispositivos.', 'Shared across devices.')}</p>` : ''}</section>`;
  }

  async function load({ quiet = false } = {}) {
    if (!alive || isBusy()) return;
    const run = ++loadSequence;
    state.loading = true;
    if (!quiet) changed();
    try {
      const data = await request('/admin/bases');
      if (!alive || run !== loadSequence) return;
      if (!Array.isArray(data.bases)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      state.bases = data.bases.filter(base => base.active !== false);
      state.loaded = true; state.error = ''; state.updatedAt = new Date().toISOString();
    } catch (error) { if (alive && run === loadSequence && error?.code !== 'STALE_REQUEST') state.error = errorText(error); }
    finally { if (alive && run === loadSequence) { state.loading = false; changed(); } }
  }

  async function chooseImage(colorKey, file) {
    const color = state.form?.colors.find(color => color._key === colorKey);
    if (!color || !file || state.busy) return;
    const form = state.form;
    const run = ++imageSequence;
    color._imageRun = run; color.checking = true; color.error = ''; setDirty(); changed();
    let preview = '';
    try {
      if (!file.size || file.size > MAX_IMAGE_BYTES || (file.type && file.type !== 'image/png')) throw new Error(l('Selecciona un archivo PNG de hasta 5 MB.', 'Choose a PNG file up to 5 MB.'));
      const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (signature.length !== 8 || signature.some((byte, i) => byte !== [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error(l('El archivo no es un PNG válido.', 'The file is not a valid PNG.'));
      preview = URL.createObjectURL(file);
      const dimensions = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error(l('No se pudo abrir la imagen PNG.', 'The PNG image could not be opened.')));
        image.src = preview;
      });
      if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 16 * 1024 * 1024) throw new Error(l('La imagen supera 8192 px por lado o 16 megapíxeles.', 'The image exceeds 8192 px per side or 16 megapixels.'));
      if (!alive || state.form !== form || color._imageRun !== run || !form.colors.includes(color)) return;
      releaseColor(color); color.preview = preview; preview = ''; color.file = file; color.imageUrl = ''; color.dimensions = `${dimensions.width} × ${dimensions.height} px`; color.error = '';
    } catch (error) { if (alive && state.form === form && color._imageRun === run) color.error = error.message; }
    finally {
      if (preview) URL.revokeObjectURL(preview);
      if (alive && state.form === form && color._imageRun === run) { color.checking = false; changed(); }
    }
  }

  function validForm() {
    const form = state.form;
    if (!form || form.name.trim().length < 2 || form.type.trim().length < 2 || !/^\d+$/.test(form.weightGsm) || Number(form.weightGsm) < 1 || Number(form.weightGsm) > 2000 || !form.sizes.length || form.sizes.length > 20) return l('Completa el nombre, tipo, gramaje y entre 1 y 20 tallas.', 'Complete the name, type, fabric weight and between 1 and 20 sizes.');
    if (!form.colors.length || form.colors.length > 30) return l('Agrega entre 1 y 30 colores.', 'Add between 1 and 30 colors.');
    if (form.colors.some(color => !color.name.trim() || color.name.trim().length > 80 || !/^#[0-9a-f]{6}$/i.test(color.hex) || (!color.file && !color.imageUrl) || color.checking || color.error)) return l('Cada color necesita un nombre, una muestra de color y una imagen PNG válida.', 'Each color needs a name, a color swatch and a valid PNG image.');
    if (new Set(form.colors.map(color => color.name.trim().toLocaleLowerCase())).size !== form.colors.length) return l('Usa nombres distintos para los colores de esta base.', 'Use a different name for each garment color.');
    return '';
  }

  async function save() {
    if (!alive || isBusy() || !state.form) return;
    const invalid = validForm();
    if (invalid) { state.formError = invalid; changed(); return; }
    const form = state.form;
    const run = ++mutationSequence;
    ++loadSequence; state.loading = false; state.formError = ''; state.busy = 'upload'; state.uploaded = 0; state.uploadTotal = form.colors.filter(color => color.file && !color.imageUrl).length;
    if (!state.createKey) state.createKey = key();
    changed();
    try {
      for (const color of form.colors) {
        if (!color.file || color.imageUrl) continue;
        const uploaded = await request('/admin/designs', { method: 'POST', body: color.file.type === 'image/png' ? color.file : new Blob([color.file], { type: 'image/png' }) });
        if (!alive || run !== mutationSequence || state.form !== form) return;
        if (!safeImage(uploaded.designUrl)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
        color.imageUrl = uploaded.designUrl; state.uploaded++; changed();
      }
      state.busy = 'save'; changed();
      const body = { name: form.name.trim(), type: form.type.trim(), weightGsm: Number(form.weightGsm), sizes: [...form.sizes], colors: form.colors.map(color => ({ ...(Number.isSafeInteger(color.shirt) ? { shirt: color.shirt } : {}), name: color.name.trim(), hex: color.hex, imageUrl: color.imageUrl })), ...(form.id ? { version: form.version } : { idempotencyKey: state.createKey }) };
      const data = await request(form.id ? `/admin/bases/${encodeURIComponent(form.id)}` : '/admin/bases', { method: form.id ? 'PATCH' : 'POST', body });
      if (!alive || run !== mutationSequence || state.form !== form) return;
      if (!data.base?.id) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      const index = state.bases.findIndex(base => base.id === data.base.id);
      if (index < 0) state.bases.unshift(data.base); else state.bases[index] = data.base;
      releaseForm(); state.form = null; state.dirty = false; state.createKey = ''; state.discardPrompt = false; state.updatedAt = new Date().toISOString();
      window.dispatchEvent(new CustomEvent('zenin:bases-changed', { detail: { action: form.id ? 'updated' : 'created', baseId: data.base.id } }));
      announce(l('Camiseta base guardada.', 'Base garment saved.'));
    } catch (error) { if (alive && run === mutationSequence && error?.code !== 'STALE_REQUEST') state.formError = errorText(error); }
    finally { if (alive && run === mutationSequence) { state.busy = ''; changed(); } }
  }

  async function archive() {
    const base = state.bases.find(base => base.id === state.archiveId);
    if (!alive || !base || isBusy()) return;
    const run = ++mutationSequence;
    ++loadSequence; state.loading = false; state.busy = 'archive'; state.archiveError = ''; changed();
    try {
      const data = await request(`/admin/bases/${encodeURIComponent(base.id)}`, { method: 'DELETE', body: { version: base.version } });
      if (!alive || run !== mutationSequence) return;
      if (data.archived !== true) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      state.bases = state.bases.filter(item => item.id !== base.id); state.archiveId = ''; state.updatedAt = new Date().toISOString();
      if (state.form?.id === base.id) { releaseForm(); state.form = null; state.dirty = false; }
      window.dispatchEvent(new CustomEvent('zenin:bases-changed', { detail: { action: 'archived', baseId: base.id } }));
      announce(l('Camiseta base archivada.', 'Base garment archived.'));
    } catch (error) { if (alive && run === mutationSequence && error?.code !== 'STALE_REQUEST') state.archiveError = errorText(error); }
    finally { if (alive && run === mutationSequence) { state.busy = ''; changed(); } }
  }

  function onSubmit(event) {
    if (event.target.id !== 'admin-base-form') return false;
    event.preventDefault();
    if (document.activeElement?.id === 'admin-base-custom-size') { addSize(); return true; }
    if (event.target.reportValidity()) save();
    return true;
  }
  function onInput(event) {
    const target = event.target;
    if (target.dataset && Object.hasOwn(target.dataset, 'baseCustomSize') && state.form && !state.busy) { state.sizeDraft = target.value; state.sizeError = ''; setDirty(); return true; }
    if (target.dataset?.baseField && state.form && !state.busy) { state.form[target.dataset.baseField] = target.value; setDirty(); return true; }
    if (target.dataset?.baseColor && state.form && !state.busy) {
      const color = state.form.colors.find(color => color._key === target.dataset.baseColor);
      if (!color || !['name', 'hex'].includes(target.dataset.baseColorField)) return false;
      color[target.dataset.baseColorField] = target.value; setDirty();
      if (target.dataset.baseColorField === 'hex') { const label = target.closest('.admin-base-hex-label')?.querySelector('small'); if (label) label.textContent = target.value.toUpperCase(); }
      return true;
    }
    return false;
  }
  function onChange(event) {
    const target = event.target;
    if (target.dataset?.baseImage) { chooseImage(target.dataset.baseImage, target.files?.[0]); return true; }
    if (target.dataset?.baseSize && state.form && !state.busy) { const size = target.dataset.baseSize; if (target.checked && !state.form.sizes.includes(size) && state.form.sizes.length >= 20) { state.sizeError = l('Cada base puede ofrecer hasta 20 tallas.', 'Each garment can offer up to 20 sizes.'); changed(); return true; } state.form.sizes = [...new Set(target.checked ? [...state.form.sizes, size] : state.form.sizes.filter(item => item !== size))]; state.sizeError = ''; setDirty(); return true; }
    if (target.dataset?.baseField || target.dataset?.baseColor) return onInput(event);
    return false;
  }
  function addSize() {
    if (!state.form || state.busy) return;
    const typed = state.sizeDraft.trim().replace(/\s+/g, ' ');
    if (!typed || typed.length > 24 || /[<>\u0000-\u001f]/.test(typed)) { state.sizeError = l('Escribe una talla de entre 1 y 24 caracteres.', 'Enter a size between 1 and 24 characters.'); changed(); return; }
    const options = [...SIZE_CHOICES, ...(state.form.customSizes || []), ...state.form.sizes];
    const size = options.find(value => value.toLocaleLowerCase() === typed.toLocaleLowerCase()) || typed;
    if (!state.form.sizes.includes(size) && state.form.sizes.length >= 20) { state.sizeError = l('Cada base puede ofrecer hasta 20 tallas.', 'Each garment can offer up to 20 sizes.'); changed(); return; }
    state.form.sizes = [...new Set([...state.form.sizes, size])];
    if (!SIZE_CHOICES.includes(size)) state.form.customSizes = [...new Set([...(state.form.customSizes || []), size])];
    state.sizeDraft = ''; state.sizeError = ''; setDirty(); changed();
  }
  function onClick(event) {
    const button = event.target.closest('button[data-base-action]');
    if (!button || button.disabled) return false;
    if (isBusy()) return true;
    switch (button.dataset.baseAction) {
      case 'create': if (state.dirty) return true; releaseForm(); state.form = blankForm(); state.dirty = false; state.formError = ''; state.archiveId = ''; state.createKey = ''; state.sizeDraft = ''; state.sizeError = ''; changed(); return true;
      case 'edit': {
        if (state.dirty) return true;
        const base = state.bases.find(base => base.id === button.dataset.baseId); if (!base) return true;
        releaseForm(); state.form = { id: base.id, version: base.version, name: base.name, type: base.type, weightGsm: String(base.weightGsm || ''), sizes: [...base.sizes], customSizes: base.sizes.filter(size => !SIZE_CHOICES.includes(size)), colors: base.colors.map(color => ({ ...blankColor(), ...color })) }; state.dirty = false; state.formError = ''; state.archiveId = ''; state.createKey = ''; state.sizeDraft = ''; state.sizeError = ''; changed(); return true;
      }
      case 'add-size': addSize(); return true;
      case 'add-color': if (state.form && state.form.colors.length < 30) { state.form.colors.push(blankColor()); setDirty(); changed(); } return true;
      case 'remove-color': if (state.form && state.form.colors.length > 1) { const color = state.form.colors.find(color => color._key === button.dataset.baseKey); if (color) releaseColor(color); state.form.colors = state.form.colors.filter(color => color._key !== button.dataset.baseKey); setDirty(); changed(); } return true;
      case 'cancel-edit': if (state.dirty) state.discardPrompt = true; else { releaseForm(); state.form = null; } changed(); return true;
      case 'keep-edit': state.discardPrompt = false; changed(); return true;
      case 'discard-edit': releaseForm(); state.form = null; state.dirty = false; state.discardPrompt = false; state.formError = ''; state.createKey = ''; changed(); return true;
      case 'refresh': load(); return true;
      case 'ask-archive': state.archiveId = button.dataset.baseId; state.archiveError = ''; changed(); return true;
      case 'cancel-archive': state.archiveId = ''; state.archiveError = ''; changed(); return true;
      case 'confirm-archive': archive(); return true;
      default: return false;
    }
  }
  function reset() {
    ++loadSequence; ++mutationSequence; releaseForm();
    Object.assign(state, { bases: [], loaded: false, loading: false, error: '', updatedAt: '', form: null, dirty: false, busy: '', formError: '', discardPrompt: false, archiveId: '', archiveError: '', createKey: '', uploaded: 0, uploadTotal: 0, sizeDraft: '', sizeError: '' });
  }
  return { html, load, onSubmit, onClick, onInput, onChange, reset, hasUnsaved: () => state.dirty || !!state.sizeDraft.trim(), isSaving: isBusy, cleanup: () => { alive = false; reset(); } };
}
