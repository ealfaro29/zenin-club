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
const PRODUCT_ES={
'zc-001':'Camiseta Antojo de Medianoche','zc-002':'Camiseta Todo Está Bien','zc-003':'Camiseta Turno de Noche','zc-004':'Camiseta Golpe de Suerte','zc-005':'Camiseta Una Porción Más','zc-006':'Camiseta Lo de Siempre','zc-007':'Camiseta Picante','zc-008':'Camiseta Suficientemente Bien','zc-009':'Camiseta Cabeza en Órbita','zc-010':'Camiseta Mala Influencia','zc-011':'Camiseta Todo Unido','zc-012':'Camiseta Club Privado','zc-013':'Camiseta En Repetición','zc-014':'Camiseta Paseo Nocturno','zc-015':'Camiseta Fuera de la Oficina','zc-016':'Camiseta Fin de Semana Largo'};
export const productName=product=>language==='es'?(product.nameEs||PRODUCT_ES[product.productId||product.id]||product.name||product.nameEn):(product.nameEn||product.name||product.nameEs);
export const colorLabel=value=>{const labels={1:['Negro desgastado','Washed Black'],2:['Verde azulado','Deep Teal'],3:['Violeta','Dusty Violet'],4:['Rojo desteñido','Faded Red']};const found=labels[value]||Object.values(labels).find(a=>a.includes(value));return found?l(...found):String(value??'');};
export const collectionName=value=>{const labels={'Food Court':['Patio de Comidas','Food Court'],'Mood Swings':['Cambios de Humor','Mood Swings'],'Everyday Objects':['Objetos Cotidianos','Everyday Objects'],'After Hours':['Después de Hora','After Hours'],food:['Patio de Comidas','Food Court'],faces:['Cambios de Humor','Mood Swings'],objects:['Objetos Cotidianos','Everyday Objects'],cars:['Después de Hora','After Hours']};return labels[value]?l(...labels[value]):String(value??'');};
