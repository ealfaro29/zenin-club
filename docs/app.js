import { getAvailableShirts, getDefaultShirt, isShirtAvailable, getDesignUrl, getShirtOption, getShirtSizes } from './product-design.js?v=45';
import { createCommerce } from './commerce.js?v=45';
import { initStorefrontUI } from './storefront-ui.js?v=45';
import {l,getLanguage,setLanguage,formatMoney,productName,colorLabel,collectionName} from './i18n.js?v=45';
import {mountAdmin} from './admin.js?v=45';
import {mountOrderTracking} from './order-tracking.js?v=45';
import {getProducts,apiErrorMessage} from './orders-api.js?v=45';
import {ensureInventory,refreshInventory,getStock,getInventoryState,getProductAvailability,inventoryMessage} from './inventory.js?v=45';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=formatMoney;
const products = [];
let catalogRequest = null;
let catalogQueuedRefresh = null;
let catalogLoadedAt = 0;
let catalogFingerprint = '';
let catalogError = null;
let commerce;
let storefront;
let mediaObserver;
let routeCleanup;
let filter = 'all';
let sort = 'featured';
let pageLimit = 8;
let activeProduct;
let chosenSize = '';
let chosenShirt;
let quickContextBackup = null;
let toastTimer;
const collections = [{id:'originals',name:'Zenin Originals'}];

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3400);
}
function shirtHTML(product, cls = '') {
  if(!product)return '';
  const shirt=Number(product.shirt)||getDefaultShirt(product);
  const option=getShirtOption(product,shirt);
  const baseUrl=option?.imageUrl||'';
  const mockup=baseUrl.match(/(?:^|\/)assets\/shirt-([1-4])\.webp(?:[?#].*)?$/)?.[1];
  const designUrl=getDesignUrl(product);
  const print=designUrl?`<img class="shirt-design" src="${esc(designUrl)}" alt="" loading="lazy" decoding="async" draggable="false">`:'';
  const base=baseUrl?`<img class="shirt-base" src="${esc(baseUrl)}" alt="${esc(productName(product))} · ${esc(shirtOptionLabel(product,shirt))}" width="1200" height="1200" loading="lazy" draggable="false">`:`<div class="shirt-base-missing">${l('Imagen no disponible','Image unavailable')}</div>`;
  return `<div class="shirt-art ${designUrl?'has-design ':''}${esc(cls)}" ${mockup?`style="--shirt-mask:url('assets/shirt-mask-${mockup}.svg')"`:''}>${base}<div class="shirt-print" aria-hidden="true">${print}</div></div>`;
}
function shirtOptionLabel(product,shirt) {
  const option=getShirtOption(product,shirt);
  if(!option||option.legacy)return colorLabel(shirt);
  const base=[option.baseName,option.type,option.weightGsm?`${option.weightGsm} g/m²`:''].filter(Boolean).join(' · ');
  return [base,option.colorName].filter(Boolean).join(' / ');
}
function colorOptionsHTML(product,selectedShirt) {
  const groups=new Map();
  for(const shirt of getAvailableShirts(product)){
    const option=getShirtOption(product,shirt);
    const key=option.baseId||'legacy';
    if(!groups.has(key))groups.set(key,{option,shirts:[]});
    groups.get(key).shirts.push(shirt);
  }
  return [...groups.values()].map(({option,shirts})=>{
    const title=[option.baseName,option.type,option.weightGsm?`${option.weightGsm} g/m²`:''].filter(Boolean).join(' · ');
    return `<fieldset class="base-color-group">${title?`<legend>${esc(title)}</legend>`:''}<div class="color-options">${shirts.map(shirt=>{
      const color=getShirtOption(product,shirt);
      const hex=/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color.hex)?color.hex:'#888888';
      return `<button type="button" class="color-swatch ${shirt===selectedShirt?'selected':''}" style="--swatch:${hex}" data-color="${shirt}" aria-label="${esc(shirtOptionLabel(product,shirt))}" aria-pressed="${shirt===selectedShirt}" title="${esc(color.legacy?colorLabel(shirt):color.colorName)}"></button>`;
    }).join('')}</div></fieldset>`;
  }).join('');
}
function sizeOptionsHTML(product,shirt,selectedSize='') {
  return getShirtSizes(product,shirt).map(size=>`<button type="button" data-size="${esc(size)}" aria-pressed="${size===selectedSize}" class="${size===selectedSize?'selected':''}">${esc(size)}</button>`).join('');
}
function stageColor() { return '#45414f'; }
function productCard(product) {
  const title=productName(product);const shortName=title.replace(/^Camiseta /,'').replace(/ Tee$/,'');
  return `<article class="product-card" data-product-card="${esc(product.id)}"><div class="product-image" style="--stage:${stageColor(product)}"><a class="product-picture" href="#product/${encodeURIComponent(product.slug)}" aria-label="${l('Ver','View')} ${esc(title)}">${shirtHTML(product)}</a>${product.tag==='NEW'?`<span class="product-tag">${l('Nuevo','New')}</span>`:''}<div class="card-sizes" aria-label="${l('Añadir','Quick add')} ${esc(title)}">${getShirtSizes(product).map(size=>`<button data-add-size="${esc(size)}" data-product="${esc(product.id)}" aria-label="${l('Añadir','Add')} ${esc(title)} ${l('talla','size')} ${esc(size)}">${esc(size)}</button>`).join('')}</div><button class="quick-add" data-quick="${esc(product.id)}" aria-label="${l('Añadir','Quick add')} ${esc(title)}">+</button></div><div class="product-meta"><div><a href="#product/${encodeURIComponent(product.slug)}"><h3>${esc(shortName)}</h3></a><p>${l('Camiseta','T-Shirt')}</p></div><div class="product-price"><span>${money(product.price)}</span><small>USD</small></div></div></article>`;
}
function sortHTML() {
  return `<div class="floating-sort"><div id="sort-menu" class="sort-menu" hidden><button data-sort="price-asc">${l('Menor precio','Lowest Price')}</button><button data-sort="featured">${l('Destacados','Best Sellers')}</button><button data-sort="price-desc">${l('Mayor precio','Highest Price')}</button><button data-sort="name">${l('Nombre A–Z','Name A–Z')}</button></div><button id="sort-toggle" aria-expanded="false" aria-controls="sort-menu">${l('ORDENAR','SORT BY')} <span>⌃</span></button></div>`;
}
function collectionsHTML() {
  return `<section class="collection-panels zenin-collection" id="collections" aria-label="${l('Colección de camisetas','T-shirt collection')}"><a class="collection-feature club-feature" href="#shop/originals"><img src="assets/zenin-logo-transparent.png" alt="Zenin Club"><div class="feature-copy"><h2>ZENIN ORIGINALS</h2><span class="feature-link">${l('VER CAMISETAS','SHOP TEES')} →</span></div></a></section>`;
}
function homeHTML() {
  return `<section class="hero-carousel" aria-label="Zenin Club"><div class="campaign-slide night-campaign is-active" data-campaign="0"><div class="campaign-backdrop"><video class="hero-video" muted autoplay loop playsinline preload="auto" poster="assets/media/zenin-hero-v2-poster.jpg" aria-label="${l('Camiseta negra de Zenin Club','Zenin Club black tee')}"><source src="assets/media/zenin-ugc-hero-v2.mp4" type="video/mp4"></video><div class="hero-fallback"><div>${shirtHTML(products[0]||{shirt:1,name:'Zenin Club'})}</div></div></div><div class="campaign-copy"><h1>ZENIN CLUB</h1><p>${l('Tu próxima camiseta.','Your next tee.')}</p><a class="campaign-button" href="#shop">${l('VER CAMISETAS','SHOP TEES')}</a></div></div><button class="hero-pause" data-hero-pause aria-label="${l('Pausar video','Pause video')}" aria-pressed="false"><span aria-hidden="true">Ⅱ</span></button></section><section class="home-catalog" aria-label="${l('Camisetas','T-shirts')}"><h2 class="sr-only">${l('Camisetas de Zenin Club','Zenin Club tees')}</h2><div class="product-grid" id="product-grid">${products.length?products.map(productCard).join(''):catalogEmptyHTML()}</div></section><div id="club">${collectionsHTML()}</div>`;
}
function shopHTML(category) {
  const title=collections.some(c=>c.id===category)?collectionName(category):category==='new'?l('Novedades','New arrivals'):l('Todas las camisetas','All tees');
  return `<section class="shop-page" aria-label="${esc(title)}"><h1 class="sr-only">${esc(title)}</h1><div class="collection-mobile-title">${esc(title)}</div><div class="shop-catalog"><div class="product-grid" id="product-grid"></div></div>${sortHTML()}</section>`;
}

function productHTML(product) {
  activeProduct=product;chosenSize='';chosenShirt=getDefaultShirt(product);
  return `<section class="product-page"><div class="product-detail"><div class="detail-gallery"><div class="detail-thumbnails" aria-label="${l('Vistas del producto','Product views')}">${[chosenShirt,...getAvailableShirts(product).filter(s=>s!==chosenShirt)].map((s,i)=>`<button data-color="${s}" class="detail-thumb ${i===0?'selected':''}" aria-label="${l('Ver','View')} ${esc(shirtOptionLabel(product,s))}">${shirtHTML({...product,shirt:s,colorName:getShirtOption(product,s)?.colorName})}</button>`).join('')}</div><div class="detail-image" style="--stage:${stageColor(product)}"><div id="detail-shirt">${shirtHTML(product)}</div></div></div><div class="detail-copy"><span class="detail-type">${l('Camiseta','T-Shirt')}</span><div class="product-title-row"><h1>${esc(productName(product))}</h1></div><p class="detail-description">${esc(getLanguage()==='es'?product.descriptionEs||product.description:product.descriptionEn||product.description)}</p><div class="detail-color-label">${l('Base y color','Base and color')}: <strong id="chosen-color">${esc(shirtOptionLabel(product,chosenShirt))}</strong></div><div class="base-options" role="group" aria-label="${l('Elegir base y color','Select base and color')}">${colorOptionsHTML(product,chosenShirt)}</div><div class="size-label"><span>${l('Talla','Size')}: <strong id="chosen-size">${l('Selecciona tu talla','Select size')}</strong></span><button class="underlined" data-info="size">${l('Guía de tallas','Size Guide')}</button></div><div class="size-options" role="group" aria-label="${l('Elegir talla','Choose a size')}">${sizeOptionsHTML(product,chosenShirt)}</div><p class="stock-status" id="product-stock" role="status"></p><p class="size-error" id="size-error" role="status"></p><button class="btn btn-primary detail-add" id="detail-add"><span>${l('AÑADIR AL CARRITO','ADD TO CART')}</span><span>${money(product.price)} <small>USD</small></span></button><span class="detail-shipping">${l('Envío gratis desde $120 · Pedido de prueba, sin cobro','Free shipping over $120 · Demo order, no charge')}</span><div class="product-accordions"><details><summary>${l('Detalles del producto','Product Details')} <span>+</span></summary><p>${l('Diseño de Zenin Club. Selecciona tu color y talla entre las opciones disponibles.','A Zenin Club design. Choose your color and size from the available options.')}</p></details><details><summary>${l('Talla y cuidados','Fit & Care')} <span>+</span></summary><p>${l('Revisa la información de talla antes de comprar. Sigue las instrucciones de cuidado de la etiqueta de la prenda.','Review the sizing information before purchasing. Follow the care instructions on the garment label.')}</p></details><details><summary>${l('Envíos y devoluciones','Shipping & Returns')} <span>+</span></summary><p>${l('Los pedidos se guardan para que el administrador pueda prepararlos y actualizar su estado. Esta tienda de prueba no cobra pagos ni contrata envíos reales.','Orders are saved so the administrator can prepare them and update their status. This concept store does not charge payments or book real shipping.')}</p></details></div></div></div><section class="related-products"><h2>${l('También te puede gustar','You might also like')}</h2><div class="product-grid">${products.filter(p=>p.id!==product.id).slice(0,4).map(productCard).join('')}</div></section></section>`;
}
function updateGrid() {
  let visible=products.filter(p=>filter==='all'||(filter==='new'?p.tag==='NEW':p.category===filter));
  if(sort==='price-asc') visible.sort((a,b)=>a.price-b.price);
  if(sort==='price-desc') visible.sort((a,b)=>b.price-a.price);
  if(sort==='name') visible.sort((a,b)=>productName(a).localeCompare(productName(b)));
  if(!$('#product-grid'))return;
  $('#product-grid').innerHTML=visible.length?visible.slice(0,pageLimit).map(productCard).join(''):catalogEmptyHTML();
  syncStockUI();
  if($('#catalog-count')) $('#catalog-count').textContent=`${visible.length} ${l('CAMISETAS. UN SOLO CLUB.','GOOD TEES. ONE GOOD CLUB.')}`;
  $$('[data-filter]').forEach(el=>{const selected=el.dataset.filter===filter;el.classList.toggle('active',selected);el.setAttribute('aria-pressed',selected);});
}
function route(options={}) {
  storefront?.destroyHome();
  mediaObserver?.disconnect();
  routeCleanup?.();routeCleanup=null;
  quickContextBackup=null;
  if(!options.keepDialogs) $$('dialog[open]').forEach(dialog=>dialog.close());
  const path=decodeURIComponent(location.hash.slice(1));
  const [routeName,param,trackingToken]=path.split('/');
  closeMobileMenu();
  document.body.classList.toggle('home-page',!['shop','product','admin','order'].includes(routeName));
  document.body.classList.toggle('admin-page',routeName==='admin');
  filter='all';sort='featured';
  if(routeName==='admin'){
    $('#view').innerHTML='<div id="admin-root"></div>';document.title=(param==='inventory'?l('Inventario','Inventory'):l('Administración','Admin'))+' — Zenin Club';routeCleanup=mountAdmin({container:$('#admin-root'),shirtHTML,money,toast,products,section:param});
  }else if(routeName==='order'){
    $('#view').innerHTML='<div id="order-root"></div>';document.title=l('Seguir pedido','Track order')+' — Zenin Club';routeCleanup=mountOrderTracking({container:$('#order-root'),id:param,token:trackingToken,shirtHTML,money,toast});
  }else if(routeName==='product') {
    const product=products.find(p=>p.slug===param);
    if(product) {$('#view').innerHTML=productHTML(product);document.title=`${productName(product)} — Zenin Club`;}
    else {document.body.classList.add('home-page');$('#view').innerHTML=homeHTML();document.title='Zenin Club';storefront?.mountHome();toast(l('Esa camiseta no está disponible. Elige otra favorita.','That tee wandered off. Find another favorite.'));}
  } else if(routeName==='shop') {
    pageLimit=Math.max(16,products.length);filter=param==='new'?'new':collections.some(c=>c.id===param)?param:'all';
    $('#view').innerHTML=shopHTML(filter); updateGrid();
    document.title=`${collections.some(c=>c.id===filter)?collectionName(filter):(filter==='new'?l('Novedades','New Arrivals'):l('Camisetas','All Tees'))} — Zenin Club`;
  } else {
    pageLimit=10;$('#view').innerHTML=homeHTML();storefront?.mountHome();
    document.title='Zenin Club';
    if(routeName==='collections'||routeName==='club') requestAnimationFrame(()=>document.getElementById(routeName)?.scrollIntoView({behavior:'smooth'}));
  }
  if(!options.keepScroll&&!['collections','club'].includes(routeName)) window.scrollTo({top:0,behavior:'instant'});
  storefront?.refreshHeader();
  $$('video').forEach(video=>{video.addEventListener('loadeddata',()=>video.closest('.campaign-slide,.collection-feature')?.classList.add('media-loaded'),{once:true});if(video.readyState>=2)video.closest('.campaign-slide,.collection-feature')?.classList.add('media-loaded');});
  mediaObserver=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(target.closest('.hero-carousel'))return;if(isIntersecting&&!matchMedia('(prefers-reduced-motion:reduce)').matches)target.play().catch(()=>{});else target.pause();}),{threshold:.1});
  $$('.collection-feature video').forEach(v=>mediaObserver.observe(v));
  syncStockUI();ensureInventory().catch(()=>{});
}
function openQuick(product) {
  if(!product){toast(l('Este producto ya no está disponible.','This product is no longer available.'));return;}
  quickContextBackup={product:activeProduct,size:chosenSize,shirt:chosenShirt};
  activeProduct=product;chosenSize='';chosenShirt=getDefaultShirt(product);
  $('#product-content').innerHTML=`<button class="close-button quick-close" data-close="product-dialog" aria-label="${l('Cerrar vista rápida','Close quick add')}">×</button><div class="quick-image">${shirtHTML(product)}</div><div class="quick-copy"><span class="detail-type">${l('Camiseta','T-Shirt')}</span><h2>${esc(productName(product))}</h2><p>${money(product.price)} USD · <span data-chosen-color>${esc(shirtOptionLabel(product,chosenShirt))}</span></p><div class="base-options" role="group" aria-label="${l('Elegir base y color','Select base and color')}">${colorOptionsHTML(product,chosenShirt)}</div><div class="size-label"><span>${l('Selecciona una talla','Select a size')}</span><button class="underlined" data-info="size">${l('Guía de tallas','Size guide')} ↗</button></div><div class="size-options">${sizeOptionsHTML(product,chosenShirt)}</div><p class="stock-status" id="quick-stock" role="status"></p><p class="size-error" id="quick-size-error" role="status"></p><button class="btn btn-primary" id="quick-add-confirm">${l('AÑADIR AL CARRITO','ADD TO CART')} <span>${money(product.price)}</span></button><a class="quick-detail-link" href="#product/${encodeURIComponent(product.slug)}" data-close="product-dialog">${l('Ver todos los detalles','View full details')} ↗</a></div>`;
  if(!$('#product-dialog').open) $('#product-dialog').showModal();
  syncStockUI();ensureInventory().catch(()=>{});
}
function selectSize(size, scopeOverride) {
  chosenSize=activeProduct&&getShirtSizes(activeProduct,chosenShirt).includes(size)?size:'';
  size=chosenSize;
  const scope = scopeOverride || ($('#product-dialog').open ? $('#product-dialog') : $('#view'));
  $$('[data-size]', scope).forEach(el=>{const selected=el.dataset.size===size;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected)});
  if($('#chosen-size', scope)) $('#chosen-size', scope).textContent=size || l('Selecciona tu talla','Select your size');
  if($('.size-error', scope)) $('.size-error', scope).textContent='';
  syncStockUI();
}
function addSelected() {
  const scope = $('#product-dialog').open ? $('#product-dialog') : $('#view');
  if(!chosenSize){$('.size-error', scope).textContent=l('Selecciona tu talla para añadir la camiseta.','Pick your size first. Your tee is waiting.');return;}
  const selection={id:activeProduct.id,size:chosenSize,shirt:chosenShirt};
  const added=commerce.addItem(selection.id,selection.size,1,selection.shirt);
  if(added&&$('#product-dialog').open) $('#product-dialog').close();
}
function infoData(){return {
  account:{title:l('Tus pedidos','Your orders'),body:`<p>${l('Consulta tus pedidos y su estado desde cualquier dispositivo.','Check your orders and their status from any device.')}</p><a class="btn btn-primary" href="#order" data-close="info-dialog">${l('SEGUIR MI PEDIDO','TRACK MY ORDER')} →</a>`},
  faq:{title:l('Preguntas frecuentes','Frequently Asked Questions'),body:`<h3>${l('¿Es una tienda real?','Is this a real shop?')}</h3><p>${l('Es una tienda de prueba. Los pedidos se guardan y el administrador puede prepararlos, pero no se cobra ningún pago ni se realizan envíos reales.','This is a concept store. Orders are saved and the administrator can prepare them, but no payment is taken and no real shipping takes place.')}</p><h3>${l('¿Dónde veo mi pedido?','Where can I find my order?')}</h3><p>${l('Usa el enlace de seguimiento de tu confirmación, o consulta tu referencia y correo en Seguir mi pedido.','Use the tracking link from your confirmation, or enter your reference and email on Track my order.')}</p><a href="#order" data-close="info-dialog" class="underlined">${l('Seguir mi pedido','Track my order')} →</a><h3>${l('¿Se guarda mi carrito?','Will my cart be saved?')}</h3><p>${l('Sí. Tu selección de color, talla y cantidad se guarda en este navegador hasta completar el pedido o eliminarla.','Yes. Your color, size and quantity choices stay in this browser until checkout or removal.')}</p>`},
  size:{title:l('Guía de tallas','Size guide'),body:`<p>${l('La tabla de medidas de las camisetas se publicará cuando esté confirmada. Las opciones de talla disponibles aparecen en cada producto.','The garment measurement chart will be published once confirmed. Available size options are listed on each product.')}</p>`},
  shipping:{title:l('Envíos y devoluciones.','The delivery details.'),body:`<h3>${l('Envíos','Shipping')}</h3><p>${l('Envío estándar de ejemplo: $8. Gratis desde $120 antes de descuentos. Precios en USD.','Sample standard shipping: $8. Free over $120 before discounts. All prices in USD.')}</p><h3>${l('Pedidos de prueba','Demo orders')}</h3><p>${l('Los pedidos se guardan y comparten con administración para preparar y actualizar su estado. No se cobran pagos, contratan envíos ni tramitan devoluciones reales.','Orders are saved and shared with administration for preparation and status updates. No real payments, shipments or returns are processed.')}</p>`},
  contact:{title:l('Hola, miembro del club.','Hey, club member.'),body:`<p>${l('¿Preguntas, ideas o una camiseta que te gustaría ver? Bienvenido al club.','Questions, wild ideas, or a tee you wish existed? Welcome to the club.')}</p><p>${l('El formulario de contacto todavía no está conectado. Puedes explorar las colecciones y seguir el estado de tus pedidos.','The contact form is not connected yet. You can explore the collections and track your orders.')}</p><a class="btn btn-primary" href="#collections" data-close="info-dialog">${l('EXPLORAR COLECCIONES','EXPLORE THE COLLECTIONS')} ↗</a>`}
};}
function closeMobileMenu(){$('#mobile-nav').hidden=true;$('#menu-backdrop').hidden=true;document.body.classList.remove('mobile-nav-open');$('#menu-toggle').setAttribute('aria-expanded','false');$('#menu-toggle').setAttribute('aria-label',l('Abrir menú','Open menu'));}
function showInfo(type) {
  const content=infoData()[type]; if(!content)return;
  $('#info-content').innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">${l('MANUAL DEL CLUB','THE CLUB HANDBOOK')}</span><h2 id="info-title">${content.title}</h2></div><button class="close-button" data-close="info-dialog" aria-label="${l('Cerrar información','Close information')}">×</button></div><div class="info-body">${content.body}</div>`;
  $('#info-dialog').showModal();
}
function search() {
  const query=$('#search-input').value.trim().toLocaleLowerCase(getLanguage());
  const matches=query?products.filter(p=>[p.name,p.nameEs,p.nameEn,productName(p),p.descriptionEs,p.descriptionEn,p.collection,collectionName(p.category),p.description,p.colorName,shirtOptionLabel(p,p.shirt),p.category].some(v=>String(v||'').toLocaleLowerCase(getLanguage()).includes(query))):products.slice(0,4);
  $('#search-results').innerHTML=`<span class="search-caption">${query?`${matches.length} ${l(matches.length===1?'RESULTADO':'RESULTADOS',matches.length===1?'MATCH':'MATCHES')}`:l('FAVORITOS DEL CLUB','A FEW CLUB FAVORITES')}</span>${matches.length?matches.map(p=>`<a class="search-result" href="#product/${encodeURIComponent(p.slug)}" data-close="search-dialog"><div>${shirtHTML(p)}</div><span><strong>${esc(productName(p))}</strong><small>${esc(collectionName(p.category))} / ${esc(shirtOptionLabel(p,p.shirt))}</small></span><span>${money(p.price)} ↗</span></a>`).join(''):`<div class="search-empty"><h3>${l('Todavía no hay nada aquí.','Nothing here. Yet.')}</h3><p>${l('Prueba con el nombre de un diseño o un color de camiseta.','Try a design name or shirt color.')}</p></div>`}`;
}
function applyStaticLanguage(){
  const lang=getLanguage();document.documentElement.lang=lang;
  $$('[data-es][data-en]').forEach(el=>el.textContent=el.dataset[lang]);
  $$('[data-placeholder-es][data-placeholder-en]').forEach(el=>el.placeholder=el.getAttribute('data-placeholder-'+lang));
  $$('[data-label-es][data-label-en]').forEach(el=>el.setAttribute('aria-label',el.getAttribute('data-label-'+lang)));
  $$('[data-set-language]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.setLanguage===lang)));
  const description=$('meta[name="description"]');if(description)description.content=l('Bienvenido a Zenin Club. Camisetas gráficas, colecciones y pedidos desde cualquier dispositivo.','Welcome to Zenin Club. Shop graphic tees, collections and track your orders from any device.');
}
function selectColor(value){
  if(!activeProduct)return;
  chosenShirt=isShirtAvailable(activeProduct,value)?Number(value):getDefaultShirt(activeProduct);
  const quick=$('#product-dialog').open;
  const scope=quick?$('#product-dialog'):$('.product-page');
  if(!scope)return;
  const label=$('#chosen-color',scope)||$('[data-chosen-color]',scope);
  if(label)label.textContent=shirtOptionLabel(activeProduct,chosenShirt);
  if(chosenSize&&!getShirtSizes(activeProduct,chosenShirt).includes(chosenSize))chosenSize='';
  const sizes=$('.size-options',scope);if(sizes)sizes.innerHTML=sizeOptionsHTML(activeProduct,chosenShirt,chosenSize);
  const sizeLabel=$('#chosen-size',scope);if(sizeLabel)sizeLabel.textContent=chosenSize||l('Selecciona tu talla','Select size');
  const image=quick?$('.quick-image',scope):$('#detail-shirt',scope);
  if(image)image.innerHTML=shirtHTML({...activeProduct,shirt:chosenShirt,colorName:getShirtOption(activeProduct,chosenShirt)?.colorName});
  $$('[data-color]',scope).forEach(el=>{const selected=Number(el.dataset.color)===chosenShirt;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected);});
  syncStockUI();
}
function syncStockUI(){
  const state=getInventoryState();
  $$('[data-add-size]').forEach(button=>{
    const product=products.find(p=>p.id===button.dataset.product);if(!product)return;
    const stock=getStock(product.id,product.shirt,button.dataset.addSize);
    button.disabled=false;button.dataset.stockState=stock===null?'unknown':stock<=3?'low':'ready';
    button.title=stock===null?inventoryMessage():stock===0?'Low stock':l('{count} disponibles','{count} available',{count:stock});
  });
  $$('[data-product-card]').forEach(card=>{
    const product=products.find(p=>p.id===card.dataset.productCard);if(!product)return;
    const color=getProductAvailability(product.id,product.shirt);
    const low=Object.values(color.sizes).some(stock=>stock!==null&&stock<=3);
    let badge=$('.stock-tag',card);
    if(low){if(!badge){badge=document.createElement('span');badge.className='stock-tag';$('.product-image',card).append(badge);}badge.textContent='Low stock';}
    else badge?.remove();
    const quick=$('.quick-add',card);if(quick){quick.disabled=false;quick.title=low?'Low stock':'';}

  });
  const quick=$('#product-dialog').open;
  const scope=quick?$('#product-dialog'):$('.product-page');
  if(!scope||!activeProduct)return;
  const availability=getProductAvailability(activeProduct.id,chosenShirt);
  $$('[data-size]',scope).forEach(button=>{
    const stock=getStock(activeProduct.id,chosenShirt,button.dataset.size);
    button.disabled=false;button.dataset.stockState=stock===null?'unknown':stock<=3?'low':'ready';
    button.title=stock===null?inventoryMessage():stock===0?'Low stock':l('{count} disponibles','{count} available',{count:stock});
  });
  const status=$('.stock-status',scope),add=$('#quick-add-confirm',scope)||$('#detail-add',scope);
  const stock=chosenSize?getStock(activeProduct.id,chosenShirt,chosenSize):null;
  if(add)add.disabled=false;
  if(status){
    status.replaceChildren();status.dataset.state='';
    if(state.status!=='ready'){
      const message=document.createElement('span');message.textContent=inventoryMessage();status.append(message);
      if(state.status==='error'){status.dataset.state='error';const retry=document.createElement('button');retry.type='button';retry.dataset.stockRetry='true';retry.textContent=l('Reintentar','Retry');status.append(retry);}
    }else if(availability.available===false){status.textContent='Low stock';status.dataset.state='low';}
    else if(chosenSize){status.textContent=stock===0?'Low stock':(stock<=3?'Low stock · ':'')+l('{count} unidades disponibles','{count} units available',{count:stock});status.dataset.state=stock<=3?'low':'ready';}
    else status.textContent=l('Selecciona tu talla para ver las existencias.','Select your size to see available stock.');
  }
}
window.addEventListener('zenin:inventory',syncStockUI);
window.addEventListener('focus',()=>{ensureInventory().catch(()=>{});refreshCatalog().catch(()=>{});});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){ensureInventory().catch(()=>{});refreshCatalog().catch(()=>{});}});
window.addEventListener('zenin:catalog-changed',()=>{refreshCatalog({force:true}).catch(error=>toast(apiErrorMessage(error)));refreshInventory().catch(()=>{});});
document.addEventListener('click',event=>{
  const target=event.target.closest('a,button');if(!target)return;
  if(target.classList.contains('skip-link')){event.preventDefault();$('#main').focus();$('#main').scrollIntoView();return;}
  if(target.closest('#mobile-nav a'))closeMobileMenu();
  if(target.dataset.close) document.getElementById(target.dataset.close).close();
  if(target.hasAttribute('data-cart-open')) commerce?.openCart();
  if(target.dataset.addSize) commerce?.addItem(target.dataset.product,target.dataset.addSize);
  if(target.hasAttribute('data-mobile-close'))closeMobileMenu();
  if(target.dataset.quick) openQuick(products.find(p=>p.id===target.dataset.quick));
  if(target.dataset.filter){
    if(location.hash.startsWith('#shop')) location.hash=target.dataset.filter==='all'?'shop':`shop/${target.dataset.filter}`;
    else {filter=target.dataset.filter;updateGrid();}
  }
  if(target.dataset.size) selectSize(target.dataset.size);
  if(target.dataset.color)selectColor(target.dataset.color);
  if(target.dataset.setLanguage&&target.dataset.setLanguage!==getLanguage())setLanguage(target.dataset.setLanguage);
  if(target.id==='detail-add'||target.id==='quick-add-confirm') addSelected();
  if(target.dataset.info) showInfo(target.dataset.info);
  if(target.dataset.stockRetry)refreshInventory().catch(()=>{});
  if(target.hasAttribute('data-catalog-retry'))init();
  if(target.classList.contains('search-toggle')){$('#search-dialog').showModal();search();$('#search-input').focus();}
  if(target.id==='menu-toggle'){const open=$('#mobile-nav').hidden;$('#mobile-nav').hidden=!open;target.setAttribute('aria-expanded',open);target.setAttribute('aria-label',open?l('Cerrar menú','Close menu'):l('Abrir menú','Open menu'));$('#menu-backdrop').hidden=!open;document.body.classList.toggle('mobile-nav-open',open);}
});
document.addEventListener('change',event=>{if(event.target.id==='sort-products'){sort=event.target.value;updateGrid();}});
$('#product-dialog').addEventListener('close',()=>{
  if(quickContextBackup){
    activeProduct=quickContextBackup.product;chosenShirt=quickContextBackup.shirt;
    selectSize(quickContextBackup.size);quickContextBackup=null;
  }
});
$('#search-input').addEventListener('input',search);
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();}));
$('#newsletter-form')?.addEventListener('submit',event=>{event.preventDefault();toast(l('El registro de novedades estará disponible próximamente.','Newsletter signup will be available soon.'));});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#mobile-nav').hidden){closeMobileMenu();$('#menu-toggle').focus();}});
window.addEventListener('hashchange',route);
window.addEventListener('zenin:language',()=>{
  applyStaticLanguage();
  const routeName=location.hash.slice(1).split('/')[0];
  if(['admin','order'].includes(routeName)){const inventory=routeName==='admin'&&location.hash.split('/')[1]==='inventory';document.title=(inventory?l('Inventario','Inventory'):l(routeName==='admin'?'Administración':'Seguir pedido',routeName==='admin'?'Admin':'Track order'))+' — Zenin Club';}
  else if(commerce){
    const previous=captureCatalogView();
    route({keepDialogs:true,keepScroll:true});
    if(routeName==='product'&&$('.product-page')){selectColor(previous.shirt||activeProduct.shirt);selectSize(previous.size,$('#view'));}
    if(previous.quick){const current=products.find(product=>product.id===previous.quick.id);if(current){openQuick(current);selectColor(previous.quick.shirt);selectSize(previous.quick.size);}else $('#product-dialog').close();}
    window.scrollTo({top:previous.scroll,behavior:'instant'});
  }
  if($('#search-dialog').open)search();
  syncStockUI();
});
function catalogEmptyHTML(){return `<div class="catalog-empty" style="grid-column:1/-1;padding:55px 25px;text-align:center"><h2>${l('NUEVAS CAMISETAS MUY PRONTO','NEW TEES COMING SOON')}</h2><p>${l('Los diseños estarán disponibles aquí cuando se publique la colección.','Designs will appear here when the collection is released.')}</p></div>`;}
function normalizeCatalog(value){
  if(!Array.isArray(value))throw Object.assign(new Error(),{code:'CATALOG_UNAVAILABLE'});
  const ids=new Set(),slugs=new Set();
  return value.map(product=>{
    if(!product||typeof product.id!=='string'||typeof product.slug!=='string'||!product.slug||typeof product.name!=='string'||!Number.isFinite(product.price)||product.price<0||(!Number.isSafeInteger(product.shirt)||product.shirt<1)||ids.has(product.id)||slugs.has(product.slug))throw Object.assign(new Error(),{code:'CATALOG_UNAVAILABLE'});
    ids.add(product.id);slugs.add(product.slug);
    const availableShirts=getAvailableShirts(product);if(!availableShirts.length)throw Object.assign(new Error(),{code:'CATALOG_UNAVAILABLE'});
    return {...product,shirt:getDefaultShirt(product),availableShirts,designUrl:getDesignUrl(product),description:String(product.description||'')};
  });
}
function captureCatalogView(){
  const quickOpen=$('#product-dialog').open;
  const detail=quickOpen&&quickContextBackup?quickContextBackup:{size:chosenSize,shirt:chosenShirt};
  return {sort,filter,size:detail.size,shirt:detail.shirt,scroll:window.scrollY,quick:quickOpen?{id:activeProduct?.id,size:chosenSize,shirt:chosenShirt}:null};
}
function rerenderCatalogView(){
  if(!commerce)return;
  const routeName=location.hash.slice(1).split('/')[0];
  if(['admin','order'].includes(routeName)){if($('#search-dialog').open)search();return;}
  const previous=captureCatalogView();
  route({keepDialogs:true,keepScroll:true});
  if(routeName==='shop'){sort=previous.sort;filter=previous.filter;pageLimit=Math.max(16,products.length);updateGrid();}
  if(routeName==='product'&&$('.product-page')){selectColor(previous.shirt||activeProduct.shirt);selectSize(previous.size,$('#view'));}
  if(previous.quick){const current=products.find(product=>product.id===previous.quick.id);if(current){openQuick(current);selectColor(previous.quick.shirt);selectSize(previous.quick.size);}else{$('#product-dialog').close();toast(l('Este producto se retiró de la tienda.','This product has been removed from the store.'));}}
  if($('#search-dialog').open)search();
  window.scrollTo({top:previous.scroll,behavior:'instant'});
}
function refreshCatalog({force=false,render=true}={}){
  if(catalogRequest){
    if(!force)return catalogRequest;
    if(!catalogQueuedRefresh)catalogQueuedRefresh=catalogRequest.catch(()=>{}).then(()=>{catalogQueuedRefresh=null;return refreshCatalog({force:true,render});});
    return catalogQueuedRefresh;
  }
  if(!force&&catalogLoadedAt&&Date.now()-catalogLoadedAt<60000)return Promise.resolve(products);
  catalogRequest=(async()=>{
    try{const result=await getProducts();const next=normalizeCatalog(result.products);const fingerprint=JSON.stringify(next);const changed=fingerprint!==catalogFingerprint;products.splice(0,products.length,...next);catalogFingerprint=fingerprint;catalogLoadedAt=Date.now();catalogError=null;if(changed){commerce?.setProducts(next);if(render)rerenderCatalogView();}return products;}
    catch(error){catalogError=error;throw error;}
    finally{catalogRequest=null;}
  })();
  return catalogRequest;
}
async function init(){
  applyStaticLanguage();
  try {
    await refreshCatalog({force:true,render:false});
    if(!commerce)commerce=createCommerce({products,shirtHTML,money,toast});
    if(!storefront)storefront=initStorefrontUI({onSort:key=>{sort=key;updateGrid();}});
    const updateCount=()=>{$$('.bag-count').forEach(el=>el.textContent=commerce.getCount());};
    commerce.onChange(updateCount);updateCount();route();
    ensureInventory().catch(()=>{});
  }catch(error){console.error(error);$('#view').innerHTML=`<div class="load-error"><h1>${l('El club está tomando un descanso.','The club is taking a breather.')}</h1><p>${l('Recarga para volver a ver las camisetas.','Please reload to get the tees back.')}</p><button class="btn btn-primary" data-catalog-retry>${l('REINTENTAR','TRY AGAIN')} ↗</button></div>`;}
}
init();
