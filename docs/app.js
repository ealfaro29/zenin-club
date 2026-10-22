import { createCommerce } from './commerce.js?v=40';
import { initStorefrontUI } from './storefront-ui.js?v=40';
import {l,getLanguage,setLanguage,formatMoney,productName,colorLabel,collectionName} from './i18n.js?v=40';
import {mountAdmin} from './admin.js?v=40';
import {mountOrderTracking} from './order-tracking.js?v=41';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=formatMoney;
let products = [];
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
const collections = [
  {id:'food', name:'Food Court', subtitle:'GOOD TASTE. QUESTIONABLE HABITS.', emoji:'🍒', color:'#e9a2a4', number:'01'},
  {id:'faces', name:'Mood Swings', subtitle:'FEEL EVERYTHING. WEAR IT OUT.', emoji:'🫠', color:'#d2db9c', number:'02'},
  {id:'objects', name:'Everyday Objects', subtitle:'ORDINARY THINGS. EXTRA FEELINGS.', emoji:'🎱', color:'#b5a8d5', number:'03'},
  {id:'cars', name:'After Hours', subtitle:'FOR THE LONG WAY HOME.', emoji:'🏎️', color:'#99c8c3', number:'04'}
];
const colors = {1:{name:'Washed Black',hex:'#28282a'},2:{name:'Deep Teal',hex:'#008b84'},3:{name:'Dusty Violet',hex:'#65518c'},4:{name:'Faded Red',hex:'#9b4a4c'}};

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3400);
}
function shirtHTML(product, cls = '') {
  return `<div class="shirt-art ${esc(cls)}" style="--shirt-mask:url('assets/shirt-mask-${product.shirt}.svg')"><img class="shirt-base" src="assets/shirt-${product.shirt}.webp" alt="${esc(productName(product))} · ${esc(colorLabel(product.shirt))}" width="1200" height="1200" loading="lazy" draggable="false"><div class="shirt-print" aria-hidden="true"><img class="shirt-logo" src="assets/zenin-logo-transparent.png" alt="" width="872" height="836"><span class="print-emoji">${product.emoji}</span><span class="print-line">${esc(product.printLine || 'MEMBER OF THE CLUB')}</span></div></div>`;
}
function stageColor(product) {
  const palette={food:['#e40020','#ff3574'],faces:['#16859e','#f24c98'],objects:['#33343b','#674fa0'],cars:['#408cac','#292932']};
  return palette[product.category]?.[+product.id.slice(-1)%2] || '#45414f';
}
function productCard(product) {
  const title=productName(product);const shortName=title.replace(/^Camiseta /,'').replace(/ Tee$/,'');
  return `<article class="product-card"><div class="product-image" style="--stage:${stageColor(product)}"><a class="product-picture" href="#product/${product.slug}" aria-label="${l('Ver','View')} ${esc(title)}">${shirtHTML(product)}</a>${product.tag==='NEW'?`<span class="product-tag">${l('Nuevo','New')}</span>`:''}<div class="card-sizes" aria-label="${l('Añadir','Quick add')} ${esc(title)}">${['S','M','L','XL','XXL'].map(size=>`<button data-add-size="${size}" data-product="${product.id}" aria-label="${l('Añadir','Add')} ${esc(title)} ${l('talla','size')} ${size}">${size}</button>`).join('')}</div><button class="quick-add" data-quick="${product.id}" aria-label="${l('Añadir','Quick add')} ${esc(title)}">+</button></div><div class="product-meta"><div><a href="#product/${product.slug}"><h3>${esc(shortName)}</h3></a><p>${l('Camiseta','T-Shirt')}</p></div><div class="product-price"><span>${money(product.price)}</span><small>USD</small></div></div></article>`;
}
function sortHTML() {
  return `<div class="floating-sort"><div id="sort-menu" class="sort-menu" hidden><button data-sort="price-asc">${l('Menor precio','Lowest Price')}</button><button data-sort="featured">${l('Destacados','Best Sellers')}</button><button data-sort="price-desc">${l('Mayor precio','Highest Price')}</button><button data-sort="name">${l('Nombre A–Z','Name A–Z')}</button></div><button id="sort-toggle" aria-expanded="false" aria-controls="sort-menu">${l('ORDENAR','SORT BY')} <span>⌃</span></button></div>`;
}
function collectionsHTML() {
  return `<section class="collection-panels" id="collections" aria-label="${l('Comprar por colección','Shop collections')}"><a class="collection-feature mood-feature" href="#shop/faces"><video muted loop playsinline preload="metadata" poster="assets/media/zenin-teal-poster.jpg" aria-hidden="true"><source src="assets/media/zenin-ugc-teal.mp4" type="video/mp4"></video><div class="feature-fallback">${shirtHTML(products[1])}</div><div class="feature-copy"><span>${l('SIÉNTELO TODO','FEEL EVERYTHING')}</span><h2>${collectionName('faces')}</h2><span class="feature-link">${l('VER LA COLECCIÓN','SHOP THE COLLECTION')} →</span></div></a><a class="collection-feature food-feature" href="#shop/food"><div class="food-scene" aria-hidden="true"><span class="scene-cherry">🍒</span><span class="scene-pizza">🍕</span><div class="scene-shirt">${shirtHTML(products[0])}</div><span class="scene-pepper">🌶️</span></div><div class="feature-copy"><span>${l('TU ANTOJO DIARIO','YOUR DAILY CRAVING')}</span><h2>${collectionName('food')}</h2><span class="feature-link">${l('DATE UN GUSTO','TREAT YOURSELF')} →</span></div></a></section>`;
}
function homeHTML() {
  return `<section class="hero-carousel" aria-label="${l('Colecciones destacadas','Featured collections')}" aria-roledescription="${l('carrusel','carousel')}"><div class="campaign-slide night-campaign is-active" data-campaign="0"><div class="campaign-backdrop"><video class="hero-video" muted autoplay loop playsinline preload="auto" poster="assets/media/zenin-hero-v2-poster.jpg" aria-label="${l('Modelo con la camiseta negra de Zenin Club','Model wearing the black Zenin Club tee')}"><source src="assets/media/zenin-ugc-hero-v2.mp4" type="video/mp4"></video><div class="hero-fallback"><div>${shirtHTML(products[0])}</div></div></div><div class="campaign-copy"><h1>${l('AL CAER<br>LA NOCHE','AFTER DARK')}</h1><p>${l('dulces problemas. buena compañía.','sweet trouble. good company.')}</p><a class="campaign-button" href="#shop/food">${l('ENTRAR','ENTER')}</a></div></div><div class="campaign-slide mood-campaign" data-campaign="1" hidden><div class="campaign-backdrop"><video class="hero-video" muted loop playsinline preload="metadata" poster="assets/media/zenin-teal-poster.jpg" aria-label="${l('Modelo con la camiseta verde de Zenin Club','Model wearing the teal Zenin Club tee')}"><source src="assets/media/zenin-ugc-teal.mp4" type="video/mp4"></video><div class="hero-fallback"><div>${shirtHTML(products[1])}</div></div></div><div class="campaign-copy"><h2>${l('TODO<br>ESTÁ BIEN.','EVERYTHING<br>IS FINE.')}</h2><p>${l('tu estado de ánimo, puesto.','wear your current state of mind.')}</p><a class="campaign-button" href="#shop/faces">${l('VER LA COLECCIÓN','SHOP MOOD SWINGS')}</a></div></div><div class="campaign-slide object-campaign" data-campaign="2" hidden><div class="object-scene" aria-hidden="true"><span>🎱</span><div>${shirtHTML(products[3])}</div><span>🎱</span></div><div class="campaign-copy"><h2>${l('TU CAMISETA<br>DE LA SUERTE.','YOUR LUCKY<br>SHIRT.')}</h2><p>${l('arriésgate. únete al club.','take the shot. join the club.')}</p><a class="campaign-button" href="#shop/objects">${l('VER OBJETOS','SHOP OBJECTS')}</a></div></div><button class="hero-arrow hero-prev" data-hero-prev aria-label="${l('Colección anterior','Previous collection')}">‹</button><button class="hero-arrow hero-next" data-hero-next aria-label="${l('Siguiente colección','Next collection')}">›</button><div class="hero-pagination" aria-label="${l('Elegir colección destacada','Choose featured collection')}">${[l('Después de Oscuro','After Dark'),collectionName('faces'),l('Tu Camiseta de la Suerte','Your Lucky Shirt')].map((name,i)=>`<button data-hero-index="${i}" class="${i===0?'is-active':''}" aria-pressed="${i===0}" aria-label="${l('Mostrar','Show')} ${name}"><span></span></button>`).join('')}</div><button class="hero-pause" data-hero-pause aria-label="${l('Pausar carrusel','Pause slideshow')}" aria-pressed="false"><span aria-hidden="true">Ⅱ</span></button></section><section class="home-catalog" aria-label="${l('Novedades','New arrivals')}"><h2 class="sr-only">${l('Novedades','New arrivals')}</h2><div class="product-grid" id="product-grid">${products.slice(0,10).map(productCard).join('')}</div></section>${collectionsHTML()}<section class="home-catalog" aria-label="${l('Más camisetas','More graphic tees')}"><h2 class="sr-only">${l('Comprar camisetas','Shop graphic tees')}</h2><div class="product-grid">${products.slice(6,16).map(productCard).join('')}</div></section><section class="collection-panels secondary-panels" id="club"><a class="collection-feature car-feature" href="#shop/cars"><span class="car-scene" aria-hidden="true">🏎️</span><div class="feature-copy"><span>${l('EL CAMINO LARGO A CASA','THE LONG WAY HOME')}</span><h2>${collectionName('cars')}</h2><span class="feature-link">${l('VER LA COLECCIÓN','SHOP THE COLLECTION')} →</span></div></a><a class="collection-feature club-feature" href="#shop"><img src="assets/zenin-logo-transparent.png" alt="Zenin Club"><div class="feature-copy"><h2>${l('YA ERES DEL CLUB.','YOU’RE IN.')}</h2><span class="feature-link">${l('VER CAMISETAS','SHOP ALL TEES')} →</span></div></a></section>`;
}
function shopHTML(category) {
  const title=collections.some(c=>c.id===category)?collectionName(category):category==='new'?l('Novedades','New arrivals'):l('Todas las camisetas','All tees');
  return `<section class="shop-page" aria-label="${esc(title)}"><h1 class="sr-only">${esc(title)}</h1><div class="collection-mobile-title">${esc(title)}</div><div class="shop-catalog"><div class="product-grid" id="product-grid"></div></div>${sortHTML()}</section>`;
}
const DESCRIPTION_ES={
'zc-001':'Dulces problemas, después de oscuro. Tu camiseta de todos los días, con una cereza de más.','zc-002':'Mantenerlo todo bajo control es un trabajo de tiempo completo. Hoy puedes tomarte el día libre.','zc-003':'Sin línea de meta. Solo el camino largo a casa. Para esas horas que son tuyas.','zc-004':'Lo bueno llega cuando te atreves. Tu camiseta de la suerte empieza aquí.','zc-005':'Un poco de queso extra nunca está de más. Para pedidos tarde y planes todavía más tarde.','zc-006':'Ya sabes lo que te gusta. Un básico con todo lo bueno incluido.','zc-007':'Un poco de picante llega lejos. Sube la temperatura sin decir una palabra.','zc-008':'Un día normal merece una muy buena camiseta. El estado de ánimo ya está resuelto.','zc-009':'Demasiadas pestañas abiertas. Una cosa menos en qué pensar. Un uniforme para el caos.','zc-010':'La amistad de la que te advirtieron. Buena compañía, ideas cuestionables.','zc-011':'Las cosas pequeñas hacen el trabajo grande. Un clásico para tu rotación diaria.','zc-012':'Guarda un poco de misterio. Ser parte del club es un estado mental.','zc-013':'Algunas cosas mejoran con la repetición. Tu próxima favorita para usar una y otra vez.','zc-014':'Ventanas abajo. Sin destino. Una invitación a tomar la ruta larga.','zc-015':'La respuesta automática ya está activada. Busca un camino y olvida el horario.','zc-016':'Empaca poco. Quédate más. Para los planes que no necesitan fecha de regreso.'};
function productHTML(product) {
  activeProduct=product;chosenSize='';chosenShirt=product.shirt;
  return `<section class="product-page"><div class="product-detail"><div class="detail-gallery"><div class="detail-thumbnails" aria-label="${l('Vistas del producto','Product views')}">${[product.shirt,...[1,2,3,4].filter(s=>s!==product.shirt)].map((s,i)=>`<button data-color="${s}" class="detail-thumb ${i===0?'selected':''}" aria-label="${l('Ver','View')} ${colorLabel(s)}">${shirtHTML({...product,shirt:s,colorName:colors[s].name})}</button>`).join('')}</div><div class="detail-image" style="--stage:${stageColor(product)}"><div id="detail-shirt">${shirtHTML(product)}</div></div></div><div class="detail-copy"><span class="detail-type">${l('Camiseta','T-Shirt')}</span><div class="product-title-row"><h1>${esc(productName(product))}</h1><span aria-hidden="true">${product.emoji}</span></div><p class="detail-description">${esc(getLanguage()==='es'?DESCRIPTION_ES[product.id]||product.description:product.description)}</p><ul class="product-benefits"><li>${l('Sensación de algodón grueso','Heavyweight cotton feel')}</li><li>${l('Corte amplio unisex','Unisex oversized fit')}</li><li>${l('Acabado lavado y hombros caídos','Washed finish, dropped shoulders')}</li><li>${l('Gráfico original de Zenin Club','Original Zenin Club graphic')}</li></ul><div class="detail-color-label">Color: <strong id="chosen-color">${esc(colorLabel(product.shirt))}</strong></div><div class="color-options" role="group" aria-label="${l('Elegir color','Select shirt color')}">${Object.entries(colors).map(([key,c])=>`<button class="color-swatch ${+key===product.shirt?'selected':''}" style="--swatch:${c.hex}" data-color="${key}" aria-label="${colorLabel(key)}" aria-pressed="${+key===product.shirt}"></button>`).join('')}</div><div class="size-label"><span>${l('Talla','Size')}: <strong id="chosen-size">${l('Selecciona tu talla','Select size')}</strong></span><button class="underlined" data-info="size">${l('Guía de tallas','Size Guide')}</button></div><div class="size-options" role="group" aria-label="${l('Elegir talla','Choose a size')}">${['S','M','L','XL','XXL'].map(size=>`<button data-size="${size}" aria-pressed="false">${size}</button>`).join('')}</div><p class="size-error" id="size-error" role="status"></p><button class="btn btn-primary detail-add" id="detail-add"><span>${l('AÑADIR AL CARRITO','ADD TO CART')}</span><span>${money(product.price)} <small>USD</small></span></button><span class="detail-shipping">${l('Envío gratis desde $120 · Pedido de prueba, sin cobro','Free shipping over $120 · Demo order, no charge')}</span><div class="product-accordions"><details><summary>${l('Detalles del producto','Product Details')} <span>+</span></summary><p>${l('Corte amplio, acabado lavado y gráfico de Zenin Club. Tallas unisex S–XXL. Las especificaciones son de ejemplo para esta tienda de prueba.','Oversized fit, washed finish, and a Zenin Club graphic. Unisex sizing S–XXL. Product specifications are placeholder copy for this concept store.')}</p></details><details><summary>${l('Talla y cuidados','Fit & Care')} <span>+</span></summary><p>${l('Elige tu talla habitual para un corte amplio. Lava con agua fría, al revés. Deja secar al aire.','Choose your regular size for an oversized fit. Wash cold, inside out. Hang dry.')}</p></details><details><summary>${l('Envíos y devoluciones','Shipping & Returns')} <span>+</span></summary><p>${l('Los pedidos se guardan para que el administrador pueda prepararlos y actualizar su estado. Esta tienda de prueba no cobra pagos ni contrata envíos reales.','Orders are saved so the administrator can prepare them and update their status. This concept store does not charge payments or book real shipping.')}</p></details></div></div></div><section class="related-products"><h2>${l('También te puede gustar','You might also like')}</h2><div class="product-grid">${products.filter(p=>p.id!==product.id).slice(0,4).map(productCard).join('')}</div></section></section>`;
}
function updateGrid() {
  let visible=products.filter(p=>filter==='all'||(filter==='new'?p.tag==='NEW':p.category===filter));
  if(sort==='price-asc') visible.sort((a,b)=>a.price-b.price);
  if(sort==='price-desc') visible.sort((a,b)=>b.price-a.price);
  if(sort==='name') visible.sort((a,b)=>productName(a).localeCompare(productName(b)));
  $('#product-grid').innerHTML=visible.slice(0,pageLimit).map(productCard).join('');
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
    $('#view').innerHTML='<div id="admin-root"></div>';document.title=l('Administración','Admin')+' — Zenin Club';routeCleanup=mountAdmin({container:$('#admin-root'),shirtHTML,money,toast});
  }else if(routeName==='order'){
    $('#view').innerHTML='<div id="order-root"></div>';document.title=l('Seguir pedido','Track order')+' — Zenin Club';routeCleanup=mountOrderTracking({container:$('#order-root'),id:param,token:trackingToken,shirtHTML,money,toast});
  }else if(routeName==='product') {
    const product=products.find(p=>p.slug===param);
    if(product) {$('#view').innerHTML=productHTML(product);document.title=`${productName(product)} — Zenin Club`;}
    else {document.body.classList.add('home-page');$('#view').innerHTML=homeHTML();document.title='Zenin Club';storefront?.mountHome();toast(l('Esa camiseta no está disponible. Elige otra favorita.','That tee wandered off. Find another favorite.'));}
  } else if(routeName==='shop') {
    pageLimit=16;filter=param==='new'?'new':collections.some(c=>c.id===param)?param:'all';
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
}
function openQuick(product) {
  quickContextBackup={product:activeProduct,size:chosenSize,shirt:chosenShirt};
  activeProduct=product;chosenSize='';chosenShirt=product.shirt;
  $('#product-content').innerHTML=`<button class="close-button quick-close" data-close="product-dialog" aria-label="${l('Cerrar vista rápida','Close quick add')}">×</button><div class="quick-image">${shirtHTML(product)}</div><div class="quick-copy"><span class="detail-type">${l('Camiseta','T-Shirt')}</span><h2>${esc(productName(product))}</h2><p>${money(product.price)} USD · ${esc(colorLabel(product.shirt))}</p><div class="size-label"><span>${l('Selecciona una talla','Select a size')}</span><button class="underlined" data-info="size">${l('Guía de tallas','Size guide')} ↗</button></div><div class="size-options">${['S','M','L','XL','XXL'].map(s=>`<button data-size="${s}" aria-pressed="false">${s}</button>`).join('')}</div><p class="size-error" id="quick-size-error" role="status"></p><button class="btn btn-primary" id="quick-add-confirm">${l('AÑADIR AL CARRITO','ADD TO CART')} <span>${money(product.price)}</span></button><a class="quick-detail-link" href="#product/${product.slug}" data-close="product-dialog">${l('Ver todos los detalles','View full details')} ↗</a></div>`;
  if(!$('#product-dialog').open) $('#product-dialog').showModal();
}
function selectSize(size) {
  chosenSize=size;
  const scope = $('#product-dialog').open ? $('#product-dialog') : $('#view');
  $$('[data-size]', scope).forEach(el=>{const selected=el.dataset.size===size;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected)});
  if($('#chosen-size', scope)) $('#chosen-size', scope).textContent=size || l('Selecciona tu talla','Select your size');
  if($('.size-error', scope)) $('.size-error', scope).textContent='';
}
function addSelected() {
  const scope = $('#product-dialog').open ? $('#product-dialog') : $('#view');
  if(!chosenSize){$('.size-error', scope).textContent=l('Selecciona tu talla para añadir la camiseta.','Pick your size first. Your tee is waiting.');return;}
  const selection={id:activeProduct.id,size:chosenSize,shirt:chosenShirt};
  if($('#product-dialog').open) $('#product-dialog').close();
  commerce.addItem(selection.id,selection.size,1,selection.shirt);
}
function infoData(){return {
  account:{title:l('Tus pedidos','Your orders'),body:`<p>${l('Consulta tus pedidos y su estado desde cualquier dispositivo.','Check your orders and their status from any device.')}</p><a class="btn btn-primary" href="#order" data-close="info-dialog">${l('SEGUIR MI PEDIDO','TRACK MY ORDER')} →</a>`},
  faq:{title:l('Preguntas frecuentes','Frequently Asked Questions'),body:`<h3>${l('¿Es una tienda real?','Is this a real shop?')}</h3><p>${l('Es una tienda de prueba. Los pedidos se guardan y el administrador puede prepararlos, pero no se cobra ningún pago ni se realizan envíos reales.','This is a concept store. Orders are saved and the administrator can prepare them, but no payment is taken and no real shipping takes place.')}</p><h3>${l('¿Dónde veo mi pedido?','Where can I find my order?')}</h3><p>${l('Usa el enlace de seguimiento de tu confirmación, o consulta tu referencia y correo en Seguir mi pedido.','Use the tracking link from your confirmation, or enter your reference and email on Track my order.')}</p><a href="#order" data-close="info-dialog" class="underlined">${l('Seguir mi pedido','Track my order')} →</a><h3>${l('¿Se guarda mi carrito?','Will my cart be saved?')}</h3><p>${l('Sí. Tu selección de color, talla y cantidad se guarda en este navegador hasta completar el pedido o eliminarla.','Yes. Your color, size and quantity choices stay in this browser until checkout or removal.')}</p>`},
  size:{title:l('Encuentra tu talla.','Find your fit.'),body:`<p>${l('Corte amplio. Elige tu talla habitual para un ajuste relajado, o una menor para un ajuste más ceñido.','Oversized by design. Choose your usual size for a relaxed fit, or size down for a closer fit.')}</p><div class="table-scroll"><table><caption>${l('Medidas de la prenda en centímetros · Tallas de ejemplo','Garment measurements in centimeters · Sample sizing')}</caption><thead><tr><th>${l('Talla','Size')}</th><th>${l('Ancho de pecho','Chest width')}</th><th>${l('Largo','Length')}</th></tr></thead><tbody>${[['S',54,70],['M',57,72],['L',60,74],['XL',63,76],['XXL',66,78]].map(r=>`<tr>${r.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">${l('Medidas sobre la prenda extendida, de lado a lado del pecho y del hombro al borde inferior. Las medidas finales pueden variar.','Laid flat, measured across the chest and from shoulder to hem. Final production measurements may vary.')}</p>`},
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
  const matches=query?products.filter(p=>[p.name,productName(p),p.collection,collectionName(p.category),p.description,p.colorName,colorLabel(p.shirt),p.emoji,p.category,DESCRIPTION_ES[p.id]].some(v=>String(v||'').toLocaleLowerCase(getLanguage()).includes(query))):products.slice(0,4);
  $('#search-results').innerHTML=`<span class="search-caption">${query?`${matches.length} ${l(matches.length===1?'RESULTADO':'RESULTADOS',matches.length===1?'MATCH':'MATCHES')}`:l('FAVORITOS DEL CLUB','A FEW CLUB FAVORITES')}</span>${matches.length?matches.map(p=>`<a class="search-result" href="#product/${p.slug}" data-close="search-dialog"><div>${shirtHTML(p)}</div><span><strong>${esc(productName(p))}</strong><small>${esc(collectionName(p.category))} / ${esc(colorLabel(p.shirt))}</small></span><span>${money(p.price)} ↗</span></a>`).join(''):`<div class="search-empty"><span>🫥</span><h3>${l('Todavía no hay nada aquí.','Nothing here. Yet.')}</h3><p>${l('Prueba con “cereza”, “auto”, “negro” u otro estado de ánimo.','Try “cherry”, “car”, “black”, or a different mood.')}</p></div>`}`;
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
  chosenShirt=+value;
  if(!activeProduct||!$('#detail-shirt'))return;
  $('#chosen-color').textContent=colorLabel(chosenShirt);
  $('#detail-shirt').innerHTML=shirtHTML({...activeProduct,shirt:chosenShirt,colorName:colors[chosenShirt].name});
  $$('[data-color]').forEach(el=>{const selected=+el.dataset.color===chosenShirt;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected);});
}
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
$('#newsletter-form').addEventListener('submit',event=>{event.preventDefault();const email=$('#newsletter-email');if(email.validity.valid){toast(l('Ya estás en la lista. Bienvenido al club de prueba.',"You're on the list. Welcome to the mock club."));$('#newsletter-form').innerHTML=`<p class="newsletter-success"><span data-es="YA ERES DEL CLUB. ✳" data-en="YOU’RE ONE OF US. ✳">${l('YA ERES DEL CLUB. ✳','YOU’RE ONE OF US. ✳')}</span><br><small data-es="Registro de prueba completado. No se enviarán correos." data-en="Demo signup complete. No emails will be sent.">${l('Registro de prueba completado. No se enviarán correos.','Demo signup complete. No emails will be sent.')}</small></p>`;}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#mobile-nav').hidden){closeMobileMenu();$('#menu-toggle').focus();}});
window.addEventListener('hashchange',route);
window.addEventListener('zenin:language',()=>{
  applyStaticLanguage();
  const routeName=location.hash.slice(1).split('/')[0];
  if(['admin','order'].includes(routeName))document.title=l(routeName==='admin'?'Administración':'Seguir pedido',routeName==='admin'?'Admin':'Track order')+' — Zenin Club';
  else if(products.length){
    const previous={size:chosenSize,shirt:chosenShirt,scroll:window.scrollY,quick:$('#product-dialog').open?{product:activeProduct,size:chosenSize}:null};
    route({keepDialogs:true,keepScroll:true});
    if(routeName==='product'){selectColor(previous.shirt);selectSize(previous.size);}
    if(previous.quick){openQuick(previous.quick.product);selectSize(previous.quick.size);}
    window.scrollTo({top:previous.scroll,behavior:'instant'});
  }
  if($('#search-dialog').open)search();
});
async function init(){
  applyStaticLanguage();
  try {
    const response=await fetch('./data/products.json');if(!response.ok)throw new Error('Unable to load products');
    products=await response.json();
    commerce=createCommerce({products,shirtHTML,money,toast});
    storefront=initStorefrontUI({onSort:key=>{sort=key;updateGrid();}});
    const updateCount=()=>{$$('.bag-count').forEach(el=>el.textContent=commerce.getCount());};
    commerce.onChange(updateCount);updateCount();route();
  }catch(error){console.error(error);$('#view').innerHTML=`<div class="load-error"><h1>${l('El club está tomando un descanso.','The club is taking a breather.')}</h1><p>${l('Recarga para volver a ver las camisetas.','Please reload to get the tees back.')}</p><button class="btn btn-primary" onclick="location.reload()">${l('REINTENTAR','TRY AGAIN')} ↗</button></div>`;}
}
init();
