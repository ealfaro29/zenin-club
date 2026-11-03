const LANGUAGE_KEY='zenin-language-v1';
let language='es';
try{language=localStorage.getItem(LANGUAGE_KEY)==='en'?'en':'es';}catch{}
export const getLanguage=()=>language;
export function setLanguage(value){language=value==='en'?'en':'es';try{localStorage.setItem(LANGUAGE_KEY,language);}catch{}document.documentElement.lang=language;window.dispatchEvent(new CustomEvent('zenin:language',{detail:language}));}
export function l(es,en,values={}){let text=language==='es'?es:en;for(const[key,value]of Object.entries(values))text=text.replaceAll(`{${key}}`,String(value));return text;}
export const formatMoney=value=>new Intl.NumberFormat(language==='es'?'es-CR':'en-US',{style:'currency',currency:'USD',currencyDisplay:'narrowSymbol',minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
export const formatDate=value=>new Intl.DateTimeFormat(language==='es'?'es-CR':'en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Costa_Rica'}).format(new Date(value));
export const statusLabel=status=>({new:l('Nuevo','New'),preparing:l('En preparación','Preparing'),ready:l('Listo','Ready'),shipped:l('Enviado','Shipped'),cancelled:l('Cancelado','Cancelled')})[status]||status;
document.documentElement.lang=language;
export const productName=product=>language==='es'?(product.nameEs||product.name||product.nameEn):(product.nameEn||product.name||product.nameEs);
export const colorLabel=value=>{const labels={1:['Negro desgastado','Washed Black'],2:['Verde azulado','Deep Teal'],3:['Violeta','Dusty Violet'],4:['Rojo desteñido','Faded Red']};const found=labels[value]||Object.values(labels).find(a=>a.includes(value));return found?l(...found):String(value??'');};
export const collectionName=value=>['originals','Zenin Originals','ZENIN ORIGINALS'].includes(value)?'Zenin Originals':String(value??'');
