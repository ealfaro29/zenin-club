import { createCommerce } from './commerce.js?v=4';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',minimumFractionDigits:Number.isInteger(Number(value))?0:2,maximumFractionDigits:2}).format(value);
let products = [];
let commerce;
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
  return `<div class="shirt-art ${esc(cls)}"><img src="assets/shirt-${product.shirt}.webp" alt="${esc(product.name)} in ${esc(product.colorName || colors[product.shirt].name)}, with a ${esc(product.emoji)} graphic" width="1200" height="1200" loading="lazy" draggable="false"><div class="shirt-print ${product.shirt===1?'light-print':''}" aria-hidden="true"><span class="print-brand">ZENIN CLUB®</span><span class="print-emoji">${product.emoji}</span><span class="print-line">${esc(product.printLine || 'MEMBER OF THE CLUB')}</span><span class="print-edition">INDEPENDENT MINDS · NO. 001</span></div></div>`;
}
function productCard(product) {
  return `<article class="product-card"><div class="product-image"><a class="product-picture" href="#product/${product.slug}" aria-label="View ${esc(product.name)}">${shirtHTML(product)}</a>${product.tag ? `<span class="product-tag ${product.tag==='NEW'?'':'favorite-tag'}">${esc(product.tag)}</span>`:''}<button class="quick-add" data-quick="${product.id}" aria-label="Quick add ${esc(product.name)}"><span>Quick add</span><span aria-hidden="true">+</span></button></div><div class="product-meta"><div><a href="#product/${product.slug}"><h3>${esc(product.name)}</h3></a><p>${esc(product.colorName)} <span> / ${esc(product.collection)}</span></p></div><span class="product-price">${money(product.price)}</span></div></article>`;
}
function categoryTabs() {
  return `<div class="category-tabs" role="group" aria-label="Filter by collection"><button data-filter="all" class="active" aria-pressed="true">All tees <span>16</span></button>${collections.map(c=>`<button data-filter="${c.id}" aria-pressed="false">${c.name} <span>04</span></button>`).join('')}</div>`;
}
function collectionsHTML() {
  return `<section class="collections-section section-wrap" id="collections"><div class="section-heading"><div><span class="eyebrow">PICK YOUR PERSONALITY</span><h2>Different obsessions.<br>Same club.</h2></div><span class="collection-count">FOUR WAYS TO FIT IN.<br>OR STAND OUT.</span></div><div class="collection-grid">${collections.map(c=>`<a class="collection-card" style="--collection-color:${c.color}" href="#shop/${c.id}"><div class="collection-card-top"><span>COLLECTION / ${c.number}</span><span class="collection-arrow">↗</span></div><span class="collection-emoji" aria-hidden="true">${c.emoji}</span><div><h3>${c.name}</h3><span>${c.subtitle}</span></div></a>`).join('')}</div></section>`;
}
function homeHTML() {
  const heroProducts=[products[0],products[2],products[1]];
  return `<section class="hero"><div class="hero-copy"><div class="hero-kicker"><span class="live-dot"></span> DROP 001 — OUT OF THE ORDINARY</div><h1>WEAR<br>YOUR<br><span>WEIRD.</span><span class="hero-asterisk" aria-hidden="true">✳</span></h1><p>Good tees for your beautifully strange everyday.</p><a class="btn btn-primary" href="#shop">SHOP THE FIRST DROP <span>↗</span></a><div class="hero-footnote">EVERYONE'S WELCOME. NORMAL IS OPTIONAL.</div></div><div class="hero-stage"><span class="hero-background-type" aria-hidden="true">ZC</span><div class="hero-coordinate">ZENIN CLUB / COLLECTION 001<br>ALL PERSONALITIES INCLUDED.</div><div class="floating-shirt shirt-back">${shirtHTML(heroProducts[1])}</div><div class="floating-shirt shirt-side">${shirtHTML(heroProducts[2])}</div><div class="floating-shirt shirt-front">${shirtHTML(heroProducts[0])}</div><div class="club-sticker"><span>100%</span><span>YOUR<br>THING.</span><span>0% BORING</span></div><span class="handwritten hero-scribble">a little weird<br>looks good on you <span>↖</span></span><div class="hero-caption"><span>THE EVERYDAY TEE.<br>WITH A PERSONALITY PROBLEM.</span><a href="#product/${products[0].slug}">MEET YOUR NEW FAVORITE ↗</a></div></div></section><div class="marquee" aria-label="Wear your weird. Welcome to the club."><div>${Array.from({length:4},()=>'<span>GOOD TEES</span><span aria-hidden="true">✳</span><span>STRANGE COMPANY</span><span aria-hidden="true">✳</span><span>ZENIN CLUB</span><span aria-hidden="true">✳</span>').join('')}</div></div><section class="shop-section section-wrap" id="latest"><div class="section-heading"><div><span class="eyebrow">FRESH OUT OF OUR HEADS</span><h2>The first of many.</h2></div><a class="text-link" href="#shop">SHOP ALL TEES <span>↗</span></a></div>${categoryTabs()}<div class="product-grid" id="product-grid">${products.slice(0,8).map(productCard).join('')}</div><div class="view-more"><a class="btn btn-outline" href="#shop">THERE'S MORE WHERE THAT CAME FROM <span>↗</span></a></div></section>${collectionsHTML()}<section class="club-banner" id="club"><div class="club-banner-symbol" aria-hidden="true">✳</div><div><span class="eyebrow">THIS IS YOUR INVITATION</span><h2>YOU DON'T HAVE TO<br>GET IT. JUST GET IN.</h2><p>We're into good tees, odd little things, and people who do their own thing.<br>No dress code. No secret handshake. Just you.</p><a class="btn btn-acid" href="#shop">FIND YOUR PEOPLE. FIND YOUR TEE. <span>↗</span></a></div><span class="club-banner-note">EST. 2026<br>OPEN TO EVERYONE.<br>EXCEPT BORING TEES.</span></section>`;
}
function shopHTML(category) {
  const collection=collections.find(c=>c.id===category);
  return `<section class="shop-page"><div class="shop-title section-wrap"><div class="breadcrumb"><a href="#">Home</a><span>/</span><span>${collection?collection.name:'All tees'}</span></div><span class="eyebrow">DROP 001 / THE EVERYDAY COLLECTION</span><h1>${collection?collection.name:'ALL TEES. ALL YOU.'}${collection?`<span aria-hidden="true">${collection.emoji}</span>`:''}</h1><p>${collection?collection.subtitle.toLowerCase().replace(/^./,c=>c.toUpperCase()):'A little food. A few feelings. Some things we just like. Find your thing.'}</p></div><div class="section-wrap shop-catalog"><div class="shop-controls">${categoryTabs()}<label class="sort-label">Sort by <select id="sort-products" aria-label="Sort products"><option value="featured">Featured</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="name">Name: A–Z</option></select></label></div><div class="catalog-count" id="catalog-count"></div><div class="product-grid" id="product-grid"></div></div></section>`;
}
function productHTML(product) {
  activeProduct=product; chosenSize=''; chosenShirt=product.shirt;
  return `<section class="product-page section-wrap"><div class="breadcrumb"><a href="#">Home</a><span>/</span><a href="#shop/${product.category}">${esc(product.collection)}</a><span>/</span><span>${esc(product.name)}</span></div><div class="product-detail"><div class="detail-image"><span class="detail-label">ZENIN CLUB / DROP 001</span><div id="detail-shirt">${shirtHTML(product)}</div><span class="detail-image-caption">FRONT PRINT · OVERSIZED FIT</span><span class="detail-graphic-note">Actual shirt base.<br>A little emoji imagination.</span></div><div class="detail-copy"><span class="eyebrow">${esc(product.collection)} / COLLECTION 001</span><h1>${esc(product.name)}</h1><div class="detail-price">${money(product.price)} <span>USD</span></div><p class="detail-description">${esc(product.description)}</p><div class="detail-color-label">Color: <strong id="chosen-color">${esc(product.colorName)}</strong></div><div class="color-options" role="group" aria-label="Select shirt color">${Object.entries(colors).map(([key,c])=>`<button class="color-swatch ${+key===product.shirt?'selected':''}" style="--swatch:${c.hex}" data-color="${key}" aria-label="${c.name}" aria-pressed="${+key===product.shirt}"></button>`).join('')}</div><div class="size-label"><span>Size: <strong id="chosen-size">Select your size</strong></span><button class="underlined" data-info="size">Size guide ↗</button></div><div class="size-options" role="group" aria-label="Choose a size">${['S','M','L','XL','XXL'].map(size=>`<button data-size="${size}" aria-pressed="false">${size}</button>`).join('')}</div><p class="size-error" id="size-error" role="status"></p><button class="btn btn-primary detail-add" id="detail-add">ADD TO BAG <span>↗</span></button><span class="detail-shipping">↗ Free shipping on orders $120+ &nbsp; · &nbsp; Demo store</span><div class="product-accordions"><details open><summary>The details <span>+</span></summary><p>Heavyweight feel. Easy, oversized fit. Washed finish. A graphic with a little personality. Unisex sizing S–XXL.</p></details><details><summary>Fit & care <span>+</span></summary><p>Relaxed through the body with dropped shoulders. Choose your regular size for an oversized fit. Wash cold, inside out. Hang dry and keep the good stuff good.</p></details><details><summary>Shipping & returns <span>+</span></summary><p>This is a concept shop. Shipping is simulated at $8, or free for orders $120 and over. No items are shipped and no payment is collected.</p></details></div></div></div><section class="related-products"><div class="section-heading"><div><span class="eyebrow">GOOD COMPANY</span><h2>Also your kind of weird.</h2></div><a class="text-link" href="#shop">VIEW ALL ↗</a></div><div class="product-grid">${products.filter(p=>p.id!==product.id).slice(0,4).map(productCard).join('')}</div></section></section>`;
}
function updateGrid() {
  let visible=products.filter(p=>filter==='all'||p.category===filter);
  if(sort==='price-asc') visible.sort((a,b)=>a.price-b.price);
  if(sort==='price-desc') visible.sort((a,b)=>b.price-a.price);
  if(sort==='name') visible.sort((a,b)=>a.name.localeCompare(b.name));
  $('#product-grid').innerHTML=visible.slice(0,pageLimit).map(productCard).join('');
  if($('#catalog-count')) $('#catalog-count').textContent=`${visible.length} GOOD TEES. ONE GOOD CLUB.`;
  $$('[data-filter]').forEach(el=>{const selected=el.dataset.filter===filter;el.classList.toggle('active',selected);el.setAttribute('aria-pressed',selected);});
}
function route() {
  quickContextBackup=null;
  $$('dialog[open]').forEach(dialog=>dialog.close());
  const path=decodeURIComponent(location.hash.slice(1));
  const [routeName,param]=path.split('/');
  $('#mobile-nav').hidden=true; $('#menu-toggle').setAttribute('aria-expanded','false');
  filter='all';sort='featured';
  if(routeName==='product') {
    const product=products.find(p=>p.slug===param);
    if(product) {$('#view').innerHTML=productHTML(product);document.title=`${product.name} — Zenin Club`;}
    else {$('#view').innerHTML=homeHTML();toast('That tee wandered off. Find another favorite.');}
  } else if(routeName==='shop') {
    pageLimit=16;filter=collections.some(c=>c.id===param)?param:'all';
    $('#view').innerHTML=shopHTML(filter); updateGrid();
    document.title=`${collections.find(c=>c.id===filter)?.name || 'All Tees'} — Zenin Club`;
  } else {
    pageLimit=8;$('#view').innerHTML=homeHTML();
    document.title='Zenin Club — Wear your weird';
    if(routeName==='collections'||routeName==='club') requestAnimationFrame(()=>document.getElementById(routeName)?.scrollIntoView({behavior:'smooth'}));
  }
  if(!['collections','club'].includes(routeName)) window.scrollTo({top:0,behavior:'instant'});
}
function openQuick(product) {
  quickContextBackup = {product: activeProduct, size: chosenSize, shirt: chosenShirt};
  activeProduct=product;chosenSize='';chosenShirt=product.shirt;
  $('#product-content').innerHTML=`<button class="close-button quick-close" data-close="product-dialog" aria-label="Close quick add">×</button><div class="quick-image">${shirtHTML(product)}</div><div class="quick-copy"><span class="eyebrow">${esc(product.collection)}</span><h2>${esc(product.name)}</h2><p>${money(product.price)} USD · ${esc(product.colorName)}</p><div class="size-label"><span>Select a size</span><button class="underlined" data-info="size">Size guide ↗</button></div><div class="size-options">${['S','M','L','XL','XXL'].map(s=>`<button data-size="${s}" aria-pressed="false">${s}</button>`).join('')}</div><p class="size-error" id="quick-size-error" role="status"></p><button class="btn btn-primary" id="quick-add-confirm">ADD TO BAG <span>↗</span></button><a class="quick-detail-link" href="#product/${product.slug}" data-close="product-dialog">View full details ↗</a></div>`;
  $('#product-dialog').showModal();
}
function selectSize(size) {
  chosenSize=size;
  const scope = $('#product-dialog').open ? $('#product-dialog') : $('#view');
  $$('[data-size]', scope).forEach(el=>{const selected=el.dataset.size===size;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected)});
  if($('#chosen-size', scope)) $('#chosen-size', scope).textContent=size || 'Select your size';
  if($('.size-error', scope)) $('.size-error', scope).textContent='';
}
function addSelected() {
  const scope = $('#product-dialog').open ? $('#product-dialog') : $('#view');
  if(!chosenSize){$('.size-error', scope).textContent='Pick your size first. Your tee is waiting.';return;}
  const selection={id:activeProduct.id,size:chosenSize,shirt:chosenShirt};
  if($('#product-dialog').open) $('#product-dialog').close();
  commerce.addItem(selection.id,selection.size,1,selection.shirt);
}
const info={
  size:{title:'Find your fit.',body:`<p>Oversized by design. Choose your usual size for a relaxed fit, or size down for a closer fit.</p><div class="table-scroll"><table><caption>Garment measurements in centimeters · Sample sizing</caption><thead><tr><th>Size</th><th>Chest width</th><th>Length</th></tr></thead><tbody>${[['S',54,70],['M',57,72],['L',60,74],['XL',63,76],['XXL',66,78]].map(r=>`<tr>${r.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">Laid flat, measured across the chest and from shoulder to hem. Final production measurements may vary.</p>`},
  shipping:{title:'The delivery details.',body:`<h3>Shipping</h3><p>Our mock checkout uses $8 standard shipping, with free shipping on orders $120 and over. All prices are in USD.</p><h3>Returns</h3><p>Zenin Club is a concept store for now. Every order is simulated: no payments are collected, no products are shipped, and no real return is needed.</p>`},
  contact:{title:'Hey, club member.',body:`<p>Questions, wild ideas, or a tee you wish existed? We're happy you're here.</p><p>This mock store isn't connected to a support inbox yet. For now, explore the collections and make yourself at home.</p><a class="btn btn-primary" href="#collections" data-close="info-dialog">EXPLORE THE COLLECTIONS <span>↗</span></a>`}
};
function showInfo(type) {
  const content=info[type]; if(!content)return;
  $('#info-content').innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">THE CLUB HANDBOOK</span><h2 id="info-title">${content.title}</h2></div><button class="close-button" data-close="info-dialog" aria-label="Close information">×</button></div><div class="info-body">${content.body}</div>`;
  $('#info-dialog').showModal();
}
function search() {
  const query=$('#search-input').value.trim().toLowerCase();
  const matches=query?products.filter(p=>[p.name,p.collection,p.description,p.colorName,p.emoji,p.category].some(v=>v.toLowerCase().includes(query))):products.slice(0,4);
  $('#search-results').innerHTML=`<span class="search-caption">${query?`${matches.length} ${matches.length===1?'MATCH':'MATCHES'}`:'A FEW CLUB FAVORITES'}</span>${matches.length?matches.map(p=>`<a class="search-result" href="#product/${p.slug}" data-close="search-dialog"><div>${shirtHTML(p)}</div><span><strong>${esc(p.name)}</strong><small>${esc(p.collection)} / ${esc(p.colorName)}</small></span><span>${money(p.price)} ↗</span></a>`).join(''):'<div class="search-empty"><span>🫥</span><h3>Nothing here. Yet.</h3><p>Try “cherry”, “car”, “black”, or a different mood.</p></div>'}`;
}
document.addEventListener('click',event=>{
  const target=event.target.closest('a,button');if(!target)return;
  if(target.classList.contains('skip-link')){event.preventDefault();$('#main').focus();$('#main').scrollIntoView();return;}
  if(target.dataset.close) document.getElementById(target.dataset.close).close();
  if(target.hasAttribute('data-cart-open')) commerce?.openCart();
  if(target.dataset.quick) openQuick(products.find(p=>p.id===target.dataset.quick));
  if(target.dataset.filter){
    if(location.hash.startsWith('#shop')) location.hash=target.dataset.filter==='all'?'shop':`shop/${target.dataset.filter}`;
    else {filter=target.dataset.filter;updateGrid();}
  }
  if(target.dataset.size) selectSize(target.dataset.size);
  if(target.dataset.color){chosenShirt=+target.dataset.color;$('#chosen-color').textContent=colors[chosenShirt].name;$('#detail-shirt').innerHTML=shirtHTML({...activeProduct,shirt:chosenShirt,colorName:colors[chosenShirt].name});$$('[data-color]').forEach(el=>{const selected=+el.dataset.color===chosenShirt;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',selected)});}
  if(target.id==='detail-add'||target.id==='quick-add-confirm') addSelected();
  if(target.dataset.info) showInfo(target.dataset.info);
  if(target.classList.contains('search-toggle')){$('#search-dialog').showModal();search();$('#search-input').focus();}
  if(target.id==='menu-toggle'){const open=$('#mobile-nav').hidden;$('#mobile-nav').hidden=!open;target.setAttribute('aria-expanded',open);target.setAttribute('aria-label',open?'Close menu':'Open menu');}
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
$('#newsletter-form').addEventListener('submit',event=>{event.preventDefault();const email=$('#newsletter-email');if(email.validity.valid){toast("You're on the list. Welcome to the mock club.");$('#newsletter-form').innerHTML='<p class="newsletter-success">YOU’RE ONE OF US. ✳<br><small>Demo signup complete. No emails will be sent.</small></p>';}});
window.addEventListener('hashchange',route);
async function init(){
  try {
    const response=await fetch('./data/products.json');if(!response.ok)throw new Error('Unable to load products');
    products=await response.json();
    commerce=createCommerce({products,shirtHTML,money,toast});
    const updateCount=()=>{$$('.bag-count').forEach(el=>el.textContent=commerce.getCount());};
    commerce.onChange(updateCount);updateCount();route();
  }catch(error){console.error(error);$('#view').innerHTML='<div class="load-error"><h1>The club is taking a breather.</h1><p>Please reload to get the tees back.</p><button class="btn btn-primary" onclick="location.reload()">TRY AGAIN ↗</button></div>';}
}
init();
