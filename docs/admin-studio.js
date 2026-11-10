import { l, getLanguage, formatMoney, productName } from "./i18n.js?v=46";
import { apiErrorMessage } from "./orders-api.js?v=46";
import { stageStyle, printAreaStyle, DEFAULT_PRINT_AREA, getPriceRange } from "./product-design.js?v=46";

/**
 * Catalog studio: launch checklist plus reusable wizards for shirt types and
 * colors, collections, apparel designs and articles. Every wizard stays
 * available after launch for new collections, designs and articles.
 */
export const STUDIO_SECTIONS = ["launch", "shirts", "collections", "products", "articles", "landing", "payments"];

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const HEX = /^#[0-9a-f]{6}$/i;
const SIZE_PRESETS = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const FIT_PRESETS = ["Regular", "Oversize", "Boxy", "Slim fit", "Crop", "Manga larga", "Tank top", "Hoodie"];
const ARTICLE_TYPES = ["Botella", "Llavero", "Taza", "Gorra", "Tote bag", "Sticker", "Pin", "Calcetines"];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_SIDE = 8192;
const SIDE_WORDS = /\b(front|frente|delantera|delantero|back|espalda|trasera|trasero|reverso|posterior)\b/gi;
const BACK_WORDS = /\b(back|espalda|trasera|trasero|reverso|posterior)\b/i;
const NAMED_COLORS = [
  ["Negro", "Black", "#121212"],
  ["Blanco", "White", "#f4f4f2"],
  ["Gris claro", "Light grey", "#c9c9c9"],
  ["Gris", "Grey", "#8a8a8a"],
  ["Gris oscuro", "Charcoal", "#3b3b3d"],
  ["Crema", "Cream", "#eee5d1"],
  ["Arena", "Sand", "#d4c3a0"],
  ["Beige", "Beige", "#c3a985"],
  ["Café", "Brown", "#6b4a33"],
  ["Rojo", "Red", "#c62828"],
  ["Vino", "Burgundy", "#6b1d2c"],
  ["Rosa", "Pink", "#efa4c0"],
  ["Naranja", "Orange", "#ec7a21"],
  ["Amarillo", "Yellow", "#f1c84b"],
  ["Verde", "Green", "#2f7d34"],
  ["Verde oliva", "Olive", "#666a39"],
  ["Verde menta", "Mint", "#a6e3c9"],
  ["Azul marino", "Navy", "#1c2a48"],
  ["Azul", "Blue", "#2160c0"],
  ["Celeste", "Sky blue", "#8fc3ea"],
  ["Turquesa", "Teal", "#17958f"],
  ["Morado", "Purple", "#653a95"],
  ["Lila", "Lilac", "#b8a1d8"],
];
const SAMPLE_DESIGN = URL.createObjectURL(
  new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 360"><rect x="4" y="4" width="292" height="352" rx="6" fill="#f04432" fill-opacity=".16" stroke="#f04432" stroke-width="6" stroke-dasharray="18 12"/><text x="150" y="172" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="34" fill="#f04432">TU</text><text x="150" y="214" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="34" fill="#f04432">DISEÑO</text></svg>`,
    ],
    { type: "image/svg+xml" },
  ),
);

const rgb = (hex) => {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function colorName(hex) {
  if (!HEX.test(hex)) return "";
  const target = rgb(hex);
  const nearest = NAMED_COLORS.reduce((best, entry) =>
    distance(rgb(entry[2]), target) < distance(rgb(best[2]), target) ? entry : best,
  );
  return l(nearest[0], nearest[1]);
}
function nameFromFile(name) {
  const cleaned = String(name || "")
    .replace(/\.png$/i, "")
    .replace(SIDE_WORDS, " ")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^(img|image|imagen|dsc|photo|foto|screenshot|captura)?\s*\d*$/i.test(cleaned) || /^\d+$/.test(cleaned))
    return "";
  return cleaned.replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase(getLanguage()));
}
const fileKey = (name) => nameFromFile(name).toLocaleLowerCase();

/** The most common opaque color, ignoring a solid photo background when present. */
function dominantColor(image) {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    const pixel = (x, y) => {
      const index = (y * size + x) * 4;
      return [data[index], data[index + 1], data[index + 2], data[index + 3]];
    };
    const corners = [pixel(0, 0), pixel(size - 1, 0), pixel(0, size - 1), pixel(size - 1, size - 1)];
    const background =
      corners.every((corner) => corner[3] > 245) && corners.every((corner) => distance(corner, corners[0]) < 40)
        ? corners[0]
        : null;
    const buckets = new Map();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 200) continue;
      const color = [data[index], data[index + 1], data[index + 2]];
      if (background && distance(color, background) < 38) continue;
      const key = ((color[0] >> 4) << 8) | ((color[1] >> 4) << 4) | (color[2] >> 4);
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += color[0];
      bucket.g += color[1];
      bucket.b += color[2];
      buckets.set(key, bucket);
    }
    const best = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
    return best ? toHex(best.r / best.count, best.g / best.count, best.b / best.count) : "";
  } catch {
    return "";
  }
}

/** Validates a PNG locally and scales oversized files to the server limits. */
async function preparePng(file) {
  if (!file || !(file.type === "image/png" || /\.png$/i.test(file.name || "")))
    throw Object.assign(new Error(), { code: "PNG_REQUIRED" });
  const previewUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = previewUrl;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(previewUrl);
    throw Object.assign(new Error(), { code: "INVALID_DESIGN" });
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  let blob = file.type === "image/png" ? file : new Blob([file], { type: "image/png" });
  let resized = false;
  if (file.size > MAX_BYTES || width * height > MAX_PIXELS || Math.max(width, height) > MAX_SIDE) {
    let scale = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)), 3200 / Math.max(width, height));
    for (let attempt = 0; attempt < 7; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      resized = true;
      if (blob && blob.size <= MAX_BYTES) break;
      scale *= 0.8;
    }
    if (!blob || blob.size > MAX_BYTES) throw Object.assign(new Error(), { code: "DESIGN_TOO_LARGE" });
  }
  return { blob, previewUrl, width, height, color: dominantColor(image), resized };
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const videoType = (file) => {
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  if (file?.type === "video/webm" || extension === "webm") return "video/webm";
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(file?.type) || ["mp4", "m4v", "mov"].includes(extension)) return "video/mp4";
  return "";
};
const isVideoFile = (file) => Boolean(videoType(file));
/** Confirms the browser can play the video and captures a PNG poster frame for instant first paint. */
async function prepareVideo(file) {
  const type = videoType(file);
  if (!type) throw Object.assign(new Error(), { code: "VIDEO_REQUIRED" });
  if (file.size > MAX_VIDEO_BYTES) throw Object.assign(new Error(), { code: "VIDEO_TOO_LARGE" });
  const previewUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = previewUrl;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error(), { code: "UNPLAYABLE_VIDEO" })), 15000);
      video.onloadeddata = () => (clearTimeout(timer), resolve());
      video.onerror = () => (clearTimeout(timer), reject(Object.assign(new Error(), { code: "UNPLAYABLE_VIDEO" })));
    });
    if (!video.videoWidth) throw Object.assign(new Error(), { code: "UNPLAYABLE_VIDEO" });
    const moment = Math.min(1, (video.duration || 0) / 3);
    if (moment > 0.05)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        video.onseeked = () => (clearTimeout(timer), resolve());
        video.currentTime = moment;
      });
  } catch (error) {
    URL.revokeObjectURL(previewUrl);
    throw error;
  }
  let poster = null;
  let scale = Math.min(1, 1600 / video.videoWidth);
  for (let attempt = 0; attempt < 5; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    poster = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (poster && poster.size <= MAX_BYTES) break;
    scale *= 0.75;
  }
  return {
    blob: new Blob([file], { type }),
    previewUrl,
    poster: poster && poster.size <= MAX_BYTES ? poster : null,
    posterPreview: poster ? URL.createObjectURL(poster) : "",
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
  };
}
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;

const money = (value) => formatMoney(Number(value) || 0);
const priceValue = (value) => {
  const number = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) && number >= 0.01 && number <= 10000 && Math.abs(number * 100 - Math.round(number * 100)) < 1e-6
    ? Math.round(number * 100) / 100
    : null;
};
const wholeNumber = (value, max = 999999) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max ? number : null;
};
const optionFromColor = (base, color) => ({
  shirt: color.shirt ?? color.key,
  baseId: base.id,
  baseName: base.name,
  type: base.type,
  weightGsm: base.weightGsm,
  colorName: color.name,
  hex: color.hex,
  imageUrl: color.imagePreview || color.imageUrl,
  backImageUrl: color.backPreview || color.backImageUrl || "",
  printArea: base.printArea,
  sizes: base.sizes,
});
const productTitle = (product) =>
  getLanguage() === "es" ? product.nameEs || product.name : product.name || product.nameEs;
const collectionTitle = (collection) =>
  collection ? (getLanguage() === "es" ? collection.nameEs || collection.name : collection.name || collection.nameEs) : "";

export function createAdminStudio({ section = "launch", subsection = "", request, onChange = () => {}, announce = () => {}, shirtHTML }) {
  let alive = true;
  let loadSequence = 0;
  const objectUrls = new Set();
  const state = {
    loaded: false,
    loading: false,
    error: "",
    bases: [],
    collections: [],
    products: [],
    showArchived: false,
    confirm: null,
    busyId: "",
    wizard: null,
    landing: { slides: [], version: 0 },
    payments: { enabled: false, version: 0 },
    autoOpen: String(subsection || ""),
  };
  const changed = () => alive && onChange();
  const activeBases = () => state.bases.filter((base) => base.active);
  const activeCollections = () => state.collections.filter((collection) => collection.active);
  const apparel = () => state.products.filter((product) => product.kind !== "article");
  const articles = () => state.products.filter((product) => product.kind === "article");
  const findCollection = (id) => state.collections.find((collection) => collection.id === id);
  const baseUsage = (baseId) =>
    state.products.filter((product) => product.active && product.shirtOptions?.some((option) => option.baseId === baseId))
      .length;

  async function load({ quiet = false } = {}) {
    if (quiet && state.wizard) return;
    const run = ++loadSequence;
    if (!quiet) {
      state.loading = true;
      state.error = "";
      changed();
    }
    try {
      const [bases, collections, products, landing, payments] = await Promise.all([
        request("/admin/bases?includeArchived=true"),
        request("/admin/collections?includeArchived=true"),
        request("/admin/products?includeArchived=true"),
        request("/admin/settings/landing"),
        request("/admin/settings/payments"),
      ]);
      if (!alive || run !== loadSequence) return;
      state.bases = bases.bases || [];
      state.collections = collections.collections || [];
      state.products = (products.products || []).filter((product) => product.designUrl || product.kind === "article");
      state.landing = landing.landing || { slides: [], version: 0 };
      state.payments = payments.payments || { enabled: false, version: 0 };
      if (section === "payments" && (!state.wizard || (!state.wizard.dirty && !state.wizard.busy))) openPayments();
      state.loaded = true;
      state.error = "";
      if (section === "landing" && (!state.wizard || (!state.wizard.dirty && !state.wizard.busy))) openLanding();
      if (state.autoOpen) {
        const [action, value] = state.autoOpen.split(":");
        state.autoOpen = "";
        if (action === "new") openWizard(wizardTypeFor(section), { collectionId: value || "" });
        else if (action === "edit" && value) openEdit(section, value);
      }
    } catch (error) {
      if (!alive || run !== loadSequence || error?.code === "STALE_REQUEST") return;
      state.error = apiErrorMessage(error);
    } finally {
      if (alive && run === loadSequence) {
        state.loading = false;
        changed();
      }
    }
  }
  const wizardTypeFor = (name) =>
    ({ shirts: "shirt", collections: "collection", products: "product", articles: "article" })[name] || "";

  /* ---------- Wizard drafts ---------- */
  function shirtDraft(base) {
    return {
      name: base?.name || "",
      type: base?.type || "",
      weightGsm: base ? String(base.weightGsm || "") : "",
      sizes: base ? [...base.sizes] : ["S", "M", "L", "XL"],
      customSize: "",
      colors: (base?.colors || []).map((color) => ({
        key: uid(),
        shirt: color.shirt,
        name: color.name,
        hex: color.hex,
        hexManual: true,
        detected: "",
        imageUrl: color.imageUrl,
        backImageUrl: color.backImageUrl || "",
      })),
      printArea: { ...(base?.printArea || DEFAULT_PRINT_AREA) },
      previewSide: "front",
      inUse: base ? baseUsage(base.id) > 0 : false,
    };
  }
  function collectionDraft(collection) {
    return {
      nameEs: collection?.nameEs || collection?.name || "",
      name: collection && collection.name !== collection.nameEs ? collection.name || "" : "",
      descriptionEs: collection?.descriptionEs || "",
      description: collection?.description || "",
      slug: collection?.slug || "",
      coverUrl: collection?.coverUrl || "",
      accent: collection?.accent || "#f04432",
      accentManual: Boolean(collection),
      detected: "",
      sortOrder: String(collection?.sortOrder ?? activeCollections().length),
      videos: (collection?.videos || []).map((video) => ({ key: uid(), url: video.url, posterUrl: video.posterUrl || "" })),
    };
  }
  function productDraft(product, preset = {}) {
    const selected = {};
    for (const base of activeBases()) {
      const shirts = product ? base.colors.filter((color) => product.availableShirts?.includes(color.shirt)).map((c) => c.shirt) : [];
      selected[base.id] = {
        enabled: product ? shirts.length > 0 : activeBases().length === 1,
        price: String(product?.basePrices?.[base.id] ?? product?.price ?? ""),
        shirts,
      };
    }
    const sides = product?.printSides && product.printSides !== "none" ? product.printSides : "front";
    return {
      collectionId: product ? product.collectionId || "" : preset.collectionId || activeCollections()[0]?.id || "",
      nameEs: product?.nameEs || product?.name || "",
      name: product && product.name !== product.nameEs ? product.name || "" : "",
      descriptionEs: product?.descriptionEs || "",
      description: product?.description || "",
      isNew: product ? product.tag === "NEW" : true,
      printSides: sides,
      frontDesignUrl: product ? product.frontDesignUrl ?? (sides === "back" ? "" : product.designUrl || "") : "",
      backDesignUrl: product?.backDesignUrl || (sides === "back" ? product?.designUrl || "" : ""),
      selected,
      shirt: product?.shirt || null,
      initialStock: "0",
      lowStockThreshold: "3",
      previewSide: sides === "back" ? "back" : "front",
    };
  }
  function articleDraft(product, preset = {}) {
    const options = product?.shirtOptions || [];
    return {
      nameEs: product?.nameEs || product?.name || "",
      name: product && product.name !== product.nameEs ? product.name || "" : "",
      articleType: product?.articleType || "",
      collectionId: product ? product.collectionId || "" : preset.collectionId || "",
      descriptionEs: product?.descriptionEs || "",
      description: product?.description || "",
      isNew: product ? product.tag === "NEW" : true,
      sizes: options[0]?.sizes ? [...options[0].sizes] : ["Única"],
      customSize: "",
      variants: options.map((option) => ({
        key: uid(),
        shirt: option.shirt,
        name: option.colorName,
        hex: option.hex,
        hexManual: true,
        detected: "",
        imageUrl: option.imageUrl,
      })),
      defaultShirt: product?.shirt || null,
      price: product ? String(product.price) : "",
      initialStock: "0",
      lowStockThreshold: "3",
    };
  }
  const WIZARD_STEPS = {
    shirt: () => [l("Tipo", "Type"), l("Colores", "Colors"), l("Área de impresión", "Print area"), l("Revisar", "Review")],
    collection: () => [l("Nombre", "Name"), l("Cover", "Cover"), l("Videos", "Videos"), l("Revisar", "Review")],
    landing: () => [l("Videos del landing", "Landing videos")],
    payments: () => [l("Pagos", "Payments")],
    product: () => [l("Colección", "Collection"), l("Diseño", "Artwork"), l("Camisetas y precios", "Shirts and prices"), l("Vista previa", "Preview"), l("Publicar", "Publish")],
    article: () => [l("Artículo", "Article"), l("Variantes", "Variants"), l("Precio y stock", "Price and stock"), l("Publicar", "Publish")],
  };
  function openWizard(type, preset = {}, record = null) {
    if (!type) return;
    if (type === "product" && !activeBases().length) {
      announce(l("Primero agrega al menos un tipo de camiseta.", "Add at least one shirt type first."));
      return;
    }
    const draft =
      type === "shirt"
        ? shirtDraft(record)
        : type === "collection"
          ? collectionDraft(record)
          : type === "product"
            ? productDraft(record, preset)
            : articleDraft(record, preset);
    state.wizard = { type, step: 0, draft, record, jobs: new Map(), busy: false, error: "", dirty: false, key: uid(), done: null };
    state.confirm = null;
    changed();
    requestAnimationFrame(() => document.querySelector(".studio-wizard")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }
  function openEdit(name, id) {
    if (name === "shirts") openWizard("shirt", {}, state.bases.find((base) => base.id === id));
    if (name === "collections") openWizard("collection", {}, findCollection(id));
    if (name === "products") openWizard("product", {}, state.products.find((product) => product.id === id));
    if (name === "articles") openWizard("article", {}, state.products.find((product) => product.id === id));
  }
  function openLanding() {
    const landing = state.landing || { slides: [], version: 0 };
    state.wizard = {
      type: "landing",
      step: 0,
      record: null,
      jobs: new Map(),
      busy: false,
      error: "",
      dirty: false,
      key: uid(),
      done: null,
      draft: {
        version: landing.version || 0,
        slides: (landing.slides || []).map((slide) => ({
          key: uid(),
          url: slide.videoUrl,
          posterUrl: slide.posterUrl || "",
          title: slide.title || "",
          titleEn: slide.titleEn || "",
          subtitle: slide.subtitle || "",
          subtitleEn: slide.subtitleEn || "",
          buttonLabel: slide.buttonLabel || "",
          buttonLabelEn: slide.buttonLabelEn || "",
          link: slide.link || "",
        })),
      },
    };
  }
  function openPayments() {
    const settings = state.payments || {};
    state.wizard = {
      type: "payments",
      step: 0,
      record: null,
      jobs: new Map(),
      busy: false,
      error: "",
      dirty: false,
      key: uid(),
      done: null,
      testResult: "",
      draft: {
        version: settings.version || 0,
        enabled: Boolean(settings.enabled),
        apiUser: settings.apiUser || "",
        password: "",
        key: "",
      },
    };
  }
  async function testPayments(wizard) {
    const draft = wizard.draft;
    wizard.busy = true;
    wizard.error = "";
    wizard.testResult = "";
    changed();
    try {
      await request("/admin/settings/payments/test", {
        method: "POST",
        body: { apiUser: draft.apiUser.trim(), ...(draft.password ? { password: draft.password } : {}), ...(draft.key ? { key: draft.key.trim() } : {}) },
      });
      if (state.wizard !== wizard) return;
      wizard.testResult = l("Conexión correcta: Tilopay aceptó el usuario, la contraseña y la key.", "Connection OK: Tilopay accepted the user, password and key.");
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      wizard.error = apiErrorMessage(error);
    } finally {
      if (alive && state.wizard === wizard) {
        wizard.busy = false;
        changed();
      }
    }
  }
  async function savePayments(wizard) {
    const draft = wizard.draft;
    wizard.busy = true;
    wizard.error = "";
    wizard.testResult = "";
    changed();
    try {
      const result = await request("/admin/settings/payments", {
        method: "PUT",
        body: {
          version: draft.version,
          enabled: draft.enabled,
          apiUser: draft.apiUser.trim(),
          ...(draft.password ? { password: draft.password } : {}),
          ...(draft.key ? { key: draft.key.trim() } : {}),
        },
      });
      if (!alive || state.wizard !== wizard) return;
      state.payments = result.payments;
      Object.assign(draft, { version: result.payments.version, enabled: result.payments.enabled, password: "", key: "" });
      wizard.dirty = false;
      announce(
        result.payments.enabled
          ? l("Pagos con Tilopay activados. El checkout ya cobra en línea.", "Tilopay payments enabled. Checkout now charges online.")
          : l("Configuración guardada. Los pagos en línea están desactivados.", "Settings saved. Online payments are off."),
      );
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      wizard.error = apiErrorMessage(error);
    } finally {
      if (alive && state.wizard === wizard) {
        wizard.busy = false;
        changed();
      }
    }
  }
  const closeWizard = () => {
    state.wizard = null;
    changed();
    load({ quiet: true });
  };

  /* ---------- Uploads ---------- */
  function itemFor(wizard, target) {
    const [scope, key] = target.split(":");
    if (scope === "color") return wizard.draft.colors.find((color) => color.key === key);
    if (scope === "variant") return wizard.draft.variants.find((variant) => variant.key === key);
    return null;
  }
  function applyUpload(wizard, target, values) {
    const [scope, , side] = target.split(":");
    const draft = wizard.draft;
    if (scope === "color" || scope === "variant") {
      const item = itemFor(wizard, target);
      if (!item) return;
      const back = side === "back";
      if (values.preview) item[back ? "backPreview" : "imagePreview"] = values.preview;
      if (values.url) item[back ? "backImageUrl" : "imageUrl"] = values.url;
      if (values.color && !back) {
        item.detected = values.color;
        if (!item.hexManual) item.hex = values.color;
        if (!item.name) item.name = colorName(values.color);
      }
    } else if (scope === "cover") {
      if (values.preview) draft.coverPreview = values.preview;
      if (values.url) draft.coverUrl = values.url;
      if (values.color) {
        draft.detected = values.color;
        if (!draft.accentManual) draft.accent = values.color;
      }
    } else if (scope === "design") {
      const field = side === "back" ? "backDesign" : "frontDesign";
      if (values.preview) draft[`${field}Preview`] = values.preview;
      if (values.url) draft[`${field}Url`] = values.url;
    }
  }
  const videoItem = (wizard, target) => {
    const [, scope, key] = target.split(":");
    const list = scope === "slide" ? wizard.draft.slides : wizard.draft.videos;
    return list?.find((item) => item.key === key);
  };
  async function uploadVideoFile(target, file) {
    const wizard = state.wizard;
    const job = { status: "preparing", name: file.name, error: "", note: megabytes(file.size) };
    wizard.jobs.set(target, job);
    wizard.dirty = true;
    wizard.error = "";
    changed();
    try {
      const prepared = await prepareVideo(file);
      objectUrls.add(prepared.previewUrl);
      if (prepared.posterPreview) objectUrls.add(prepared.posterPreview);
      if (state.wizard !== wizard) return;
      const item = videoItem(wizard, target);
      if (!item) return;
      item.preview = prepared.previewUrl;
      item.posterPreview = prepared.posterPreview;
      item.orientation = prepared.height > prepared.width ? "vertical" : "horizontal";
      job.status = "uploading";
      changed();
      if (prepared.poster) {
        const poster = await request("/admin/designs", { method: "POST", body: prepared.poster });
        if (state.wizard !== wizard) return;
        item.posterUrl = poster.designUrl;
      }
      const uploaded = await request("/admin/videos", { method: "POST", body: prepared.blob });
      if (!alive || state.wizard !== wizard) return;
      if (!/^https?:\/\//.test(uploaded?.videoUrl || "")) throw Object.assign(new Error(), { code: "INVALID_RESPONSE" });
      item.url = uploaded.videoUrl;
      wizard.jobs.delete(target);
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      job.status = "error";
      job.error = apiErrorMessage(error);
    }
    changed();
  }
  function addVideoFiles(files, scope) {
    const wizard = state.wizard;
    if (!wizard) return;
    const list = scope === "slide" ? wizard.draft.slides : wizard.draft.videos;
    const room = 6 - list.length;
    if (files.length > room) announce(l("Máximo 6 videos.", "Up to 6 videos."));
    for (const file of files.slice(0, Math.max(0, room))) {
      const item =
        scope === "slide"
          ? { key: uid(), url: "", posterUrl: "", title: "", titleEn: "", subtitle: "", subtitleEn: "", buttonLabel: "", buttonLabelEn: "", link: "#shop" }
          : { key: uid(), url: "", posterUrl: "" };
      list.push(item);
      uploadVideoFile(`video:${scope}:${item.key}`, file);
    }
    wizard.dirty = true;
    changed();
  }
  async function upload(target, file) {
    const wizard = state.wizard;
    if (!wizard || !file) return;
    if (target.startsWith("video:")) return uploadVideoFile(target, file);
    const job = { status: "preparing", name: file.name, error: "" };
    wizard.jobs.set(target, job);
    wizard.dirty = true;
    wizard.error = "";
    changed();
    try {
      const prepared = await preparePng(file);
      objectUrls.add(prepared.previewUrl);
      if (state.wizard !== wizard) return;
      applyUpload(wizard, target, { preview: prepared.previewUrl, color: prepared.color });
      job.status = "uploading";
      job.note = prepared.resized ? l("Ajustado a 5 MB", "Scaled to 5 MB") : "";
      changed();
      const uploaded = await request("/admin/designs", { method: "POST", body: prepared.blob });
      if (!alive || state.wizard !== wizard) return;
      if (!/^https?:\/\//.test(uploaded?.designUrl || "")) throw Object.assign(new Error(), { code: "INVALID_RESPONSE" });
      applyUpload(wizard, target, { url: uploaded.designUrl });
      wizard.jobs.delete(target);
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      job.status = "error";
      job.error = apiErrorMessage(error);
    }
    changed();
  }
  function addColorFiles(files, scope) {
    const wizard = state.wizard;
    if (!wizard) return;
    const list = scope === "variant" ? wizard.draft.variants : wizard.draft.colors;
    const fronts = [];
    const backs = [];
    for (const file of files) (scope === "color" && BACK_WORDS.test(file.name) ? backs : fronts).push(file);
    // Files named "classic-negro.png", "classic-rojo.png"… share a prefix that is not part of the color.
    const words = fronts.map((file) => nameFromFile(file.name).split(" "));
    let shared = 0;
    if (words.length > 1)
      while (words.every((w) => w.length > shared + 1 && w[shared].toLowerCase() === words[0][shared].toLowerCase())) shared++;
    for (const [index, file] of fronts.entries()) {
      const item = { key: uid(), name: words[index].slice(shared).join(" "), hex: "#888888", hexManual: false, detected: "", imageUrl: "" };
      if (scope === "color") item.backImageUrl = "";
      list.push(item);
      upload(`${scope}:${item.key}:front`, file);
    }
    // Pair each back photo with its color by name ("negro-espalda" → "Negro"), then by order.
    const claimed = new Set(list.filter((item) => item.backImageUrl || item.backPreview).map((item) => item.key));
    const strip = (name) => {
      const parts = nameFromFile(name).split(" ");
      const prefix = shared && words[0] ? words[0].slice(0, shared).map((w) => w.toLowerCase()) : [];
      const start = prefix.every((w, i) => (parts[i] || "").toLowerCase() === w) ? prefix.length : 0;
      return parts.slice(start).join(" ").toLocaleLowerCase();
    };
    for (const file of backs) {
      const wanted = strip(file.name);
      const match =
        list.find((item) => !claimed.has(item.key) && item.name.toLocaleLowerCase() === wanted) ||
        list.find((item) => !claimed.has(item.key) && wanted && fileKey(item.name) && wanted.endsWith(fileKey(item.name))) ||
        list.find((item) => !claimed.has(item.key));
      if (match) {
        claimed.add(match.key);
        upload(`color:${match.key}:back`, file);
      } else announce(l("No encontramos el color para {file}.", "No matching color for {file}.", { file: file.name }));
    }
    wizard.dirty = true;
    changed();
  }
  const pendingUploads = () => [...(state.wizard?.jobs.values() || [])].some((job) => job.status !== "error");
  const failedUploads = () => [...(state.wizard?.jobs.values() || [])].some((job) => job.status === "error");

  /* ---------- Validation and saving ---------- */
  function validateStep(wizard = state.wizard, step = wizard.step) {
    const draft = wizard.draft;
    if (pendingUploads()) return l("Espera a que terminen de subir las imágenes.", "Wait for the images to finish uploading.");
    if (wizard.type === "shirt") {
      if (step === 0) {
        if (draft.name.trim().length < 2) return l("Escribe el nombre del tipo de camiseta.", "Enter the shirt type name.");
        if (draft.type.trim().length < 2) return l("Indica el corte o tipo.", "Enter the cut or type.");
        if (draft.weightGsm !== "" && wholeNumber(draft.weightGsm, 2000) === null) return l("El gramaje debe ser un número entre 0 y 2000.", "Weight must be 0 to 2000.");
        if (!draft.sizes.length) return l("Elige al menos una talla.", "Choose at least one size.");
      }
      if (step === 1) {
        if (!draft.colors.length) return l("Agrega al menos un color con su PNG.", "Add at least one color with its PNG.");
        if (draft.colors.some((color) => !color.imageUrl)) return l("Cada color necesita su PNG de frente.", "Each color needs its front PNG.");
        if (draft.colors.some((color) => color.name.trim().length < 1)) return l("Ponle nombre a cada color.", "Name every color.");
        if (draft.colors.some((color) => !HEX.test(color.hex))) return l("Cada color necesita un hex válido.", "Each color needs a valid hex.");
      }
    }
    if (wizard.type === "landing" && wizard.draft.slides.some((slide) => !slide.url))
      return l("Cada diapositiva necesita su video. Vuelve a elegir el que falló o quítalo.", "Each slide needs its video. Choose the failed one again or remove it.");
    if (wizard.type === "collection" && step === 2 && wizard.draft.videos.some((video) => !video.url))
      return l("Un video no se subió. Vuelve a elegirlo o quítalo.", "A video did not upload. Choose it again or remove it.");
    if (wizard.type === "collection") {
      if (step === 0 && draft.nameEs.trim().length < 2) return l("Escribe el nombre de la colección.", "Enter the collection name.");
      if (step === 1 && !draft.coverUrl) return l("Sube el PNG del cover.", "Upload the cover PNG.");
      if (step === 1 && !HEX.test(draft.accent)) return l("Elige un color de acento válido.", "Choose a valid accent color.");
    }
    if (wizard.type === "product") {
      if (step === 0 && draft.nameEs.trim().length < 2) return l("Escribe el nombre del diseño.", "Enter the design name.");
      if (step === 1) {
        if (draft.printSides !== "back" && !draft.frontDesignUrl) return l("Sube el PNG del frente.", "Upload the front PNG.");
        if (draft.printSides !== "front" && !draft.backDesignUrl) return l("Sube el PNG de la espalda.", "Upload the back PNG.");
      }
      if (step === 2) {
        const enabled = activeBases().filter((base) => draft.selected[base.id]?.enabled);
        if (!enabled.length) return l("Elige al menos un tipo de camiseta.", "Choose at least one shirt type.");
        for (const base of enabled) {
          const choice = draft.selected[base.id];
          if (!choice.shirts.length) return l("Elige colores para {base}.", "Choose colors for {base}.", { base: base.name });
          if (priceValue(choice.price) === null) return l("Escribe un precio válido para {base}.", "Enter a valid price for {base}.", { base: base.name });
        }
      }
      if (step === 3 && (wholeNumber(draft.initialStock) === null || wholeNumber(draft.lowStockThreshold) === null))
        return l("Revisa las cantidades de stock.", "Check the stock quantities.");
    }
    if (wizard.type === "article") {
      if (step === 0) {
        if (draft.nameEs.trim().length < 2) return l("Escribe el nombre del artículo.", "Enter the article name.");
        if (draft.articleType.trim().length < 2) return l("Indica qué tipo de artículo es.", "Enter the article type.");
      }
      if (step === 1) {
        if (!draft.variants.length) return l("Agrega al menos una foto del artículo.", "Add at least one article photo.");
        if (draft.variants.some((variant) => !variant.imageUrl)) return l("Cada variante necesita su PNG.", "Each variant needs its PNG.");
        if (draft.variants.some((variant) => !variant.name.trim())) return l("Ponle nombre a cada variante.", "Name every variant.");
        if (draft.variants.some((variant) => !HEX.test(variant.hex))) return l("Cada variante necesita un hex válido.", "Each variant needs a valid hex.");
        if (!draft.sizes.length) return l("Deja al menos una medida (por ejemplo, Única).", "Keep at least one option (for example, One size).");
      }
      if (step === 2) {
        if (priceValue(draft.price) === null) return l("Escribe un precio válido.", "Enter a valid price.");
        if (wholeNumber(draft.initialStock) === null || wholeNumber(draft.lowStockThreshold) === null)
          return l("Revisa las cantidades de stock.", "Check the stock quantities.");
      }
    }
    return "";
  }
  function goToStep(target) {
    const wizard = state.wizard;
    if (!wizard || wizard.busy) return;
    if (target > wizard.step) {
      for (let step = wizard.step; step < target; step++) {
        const message = validateStep(wizard, step);
        if (message) {
          wizard.step = step;
          wizard.error = message;
          changed();
          return;
        }
      }
    }
    wizard.step = Math.max(0, Math.min(target, WIZARD_STEPS[wizard.type]().length - 1));
    wizard.error = "";
    if (wizard.type === "product" && wizard.step >= 3) ensureDefaultShirt(wizard.draft);
    if (wizard.type === "article" && wizard.step >= 2 && !wizard.draft.variants.some((v) => v.shirt === wizard.draft.defaultShirt || v.key === wizard.draft.defaultShirt))
      wizard.draft.defaultShirt = wizard.draft.variants[0]?.shirt ?? wizard.draft.variants[0]?.key ?? null;
    changed();
    document.querySelector(".studio-wizard")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function selectedShirts(draft) {
    return activeBases()
      .filter((base) => draft.selected[base.id]?.enabled)
      .flatMap((base) => base.colors.filter((color) => draft.selected[base.id].shirts.includes(color.shirt)).map((color) => ({ base, color })));
  }
  function ensureDefaultShirt(draft) {
    const shirts = selectedShirts(draft).map(({ color }) => color.shirt);
    if (!shirts.includes(draft.shirt)) draft.shirt = shirts[0] ?? null;
  }
  async function save() {
    const wizard = state.wizard;
    if (!wizard || wizard.busy) return;
    for (let step = 0; step < WIZARD_STEPS[wizard.type]().length; step++) {
      const message = validateStep(wizard, step);
      if (message) {
        wizard.step = step;
        wizard.error = message;
        changed();
        return;
      }
    }
    const draft = wizard.draft;
    const record = wizard.record;
    if (wizard.type === "landing") return saveLanding(wizard);
    if (wizard.type === "payments") return savePayments(wizard);
    let path;
    let method = record ? "PATCH" : "POST";
    let body;
    if (wizard.type === "shirt") {
      path = record ? `/admin/bases/${encodeURIComponent(record.id)}` : "/admin/bases";
      body = {
        name: draft.name.trim(),
        type: draft.type.trim(),
        weightGsm: wholeNumber(draft.weightGsm, 2000) ?? 0,
        sizes: draft.sizes,
        printArea: draft.printArea,
        colors: draft.colors.map((color) => ({
          ...(color.shirt ? { shirt: color.shirt } : {}),
          name: color.name.trim(),
          hex: color.hex.toLowerCase(),
          imageUrl: color.imageUrl,
          ...(color.backImageUrl ? { backImageUrl: color.backImageUrl } : {}),
        })),
      };
    } else if (wizard.type === "collection") {
      path = record ? `/admin/collections/${encodeURIComponent(record.id)}` : "/admin/collections";
      body = {
        name: draft.name.trim() || draft.nameEs.trim(),
        nameEs: draft.nameEs.trim(),
        description: draft.description.trim(),
        descriptionEs: draft.descriptionEs.trim(),
        coverUrl: draft.coverUrl,
        accent: draft.accent.toLowerCase(),
        sortOrder: wholeNumber(draft.sortOrder, 9999) ?? 0,
        videos: draft.videos.map((video) => ({ url: video.url, posterUrl: video.posterUrl || "" })),
        ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
      };
    } else if (wizard.type === "product") {
      ensureDefaultShirt(draft);
      path = record ? `/admin/products/${encodeURIComponent(record.id)}` : "/admin/products";
      const bases = activeBases().filter((base) => draft.selected[base.id]?.enabled);
      body = {
        name: draft.name.trim() || draft.nameEs.trim(),
        nameEs: draft.nameEs.trim(),
        description: draft.description.trim(),
        descriptionEs: draft.descriptionEs.trim(),
        collectionId: draft.collectionId,
        ...(draft.collectionId ? {} : { category: "" }),
        tag: draft.isNew ? "NEW" : "",
        printSides: draft.printSides,
        frontDesignUrl: draft.printSides === "back" ? "" : draft.frontDesignUrl,
        backDesignUrl: draft.printSides === "front" ? "" : draft.backDesignUrl,
        availableShirts: selectedShirts(draft).map(({ color }) => color.shirt),
        shirt: draft.shirt,
        basePrices: Object.fromEntries(bases.map((base) => [base.id, priceValue(draft.selected[base.id].price)])),
        ...(record ? {} : { kind: "apparel", initialStock: wholeNumber(draft.initialStock), lowStockThreshold: wholeNumber(draft.lowStockThreshold) }),
      };
    } else {
      path = record ? `/admin/articles/${encodeURIComponent(record.id)}` : "/admin/articles";
      const defaultIndex = Math.max(0, draft.variants.findIndex((v) => (v.shirt ?? v.key) === draft.defaultShirt));
      body = {
        name: draft.name.trim() || draft.nameEs.trim(),
        nameEs: draft.nameEs.trim(),
        articleType: draft.articleType.trim(),
        description: draft.description.trim(),
        descriptionEs: draft.descriptionEs.trim(),
        collectionId: draft.collectionId,
        ...(draft.collectionId ? {} : { category: "" }),
        tag: draft.isNew ? "NEW" : "",
        price: priceValue(draft.price),
        sizes: draft.sizes,
        defaultVariant: defaultIndex,
        variants: draft.variants.map((variant) => ({
          ...(variant.shirt ? { shirt: variant.shirt } : {}),
          name: variant.name.trim(),
          hex: variant.hex.toLowerCase(),
          imageUrl: variant.imageUrl,
        })),
        ...(record ? {} : { initialStock: wholeNumber(draft.initialStock), lowStockThreshold: wholeNumber(draft.lowStockThreshold) }),
      };
    }
    if (record) body.version = record.version;
    else body.idempotencyKey = wizard.key;
    wizard.busy = true;
    wizard.error = "";
    changed();
    try {
      const result = await request(path, { method, body });
      if (!alive || state.wizard !== wizard) return;
      wizard.done = result.base || result.collection || result.product || {};
      wizard.dirty = false;
      announce(record ? l("Cambios guardados.", "Changes saved.") : l("Listo. Ya forma parte del catálogo.", "Done. It is now part of the catalog."));
      window.dispatchEvent(new CustomEvent(wizard.type === "shirt" ? "zenin:bases-changed" : "zenin:catalog-changed"));
      load({ quiet: false });
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      wizard.error = apiErrorMessage(error);
    } finally {
      if (alive && state.wizard === wizard) {
        wizard.busy = false;
        changed();
      }
    }
  }
  async function saveLanding(wizard) {
    const draft = wizard.draft;
    wizard.busy = true;
    wizard.error = "";
    changed();
    try {
      const result = await request("/admin/settings/landing", {
        method: "PUT",
        body: {
          version: draft.version,
          slides: draft.slides.map((slide) => ({
            videoUrl: slide.url,
            posterUrl: slide.posterUrl || "",
            title: slide.title.trim(),
            titleEn: slide.titleEn.trim(),
            subtitle: slide.subtitle.trim(),
            subtitleEn: slide.subtitleEn.trim(),
            buttonLabel: slide.buttonLabel.trim(),
            buttonLabelEn: slide.buttonLabelEn.trim(),
            link: slide.link,
          })),
        },
      });
      if (!alive || state.wizard !== wizard) return;
      state.landing = result.landing;
      draft.version = result.landing.version;
      wizard.dirty = false;
      announce(l("Landing publicado. Ya se ve en la portada.", "Landing published. It is live on the home page."));
      window.dispatchEvent(new CustomEvent("zenin:catalog-changed"));
    } catch (error) {
      if (!alive || state.wizard !== wizard || error?.code === "STALE_REQUEST") return;
      wizard.error = apiErrorMessage(error);
    } finally {
      if (alive && state.wizard === wizard) {
        wizard.busy = false;
        changed();
      }
    }
  }
  async function archive(kind, id, restore = false) {
    const record =
      kind === "base" ? state.bases.find((b) => b.id === id) : kind === "collection" ? findCollection(id) : state.products.find((p) => p.id === id);
    if (!record) return;
    const path = kind === "base" ? `/admin/bases/${id}` : kind === "collection" ? `/admin/collections/${id}` : `/admin/products/${id}`;
    state.busyId = id;
    state.confirm = null;
    changed();
    try {
      await request(path, { method: restore ? "PATCH" : "DELETE", body: restore ? { version: record.version, active: true } : { version: record.version } });
      announce(restore ? l("Restaurado.", "Restored.") : l("Archivado. Puedes restaurarlo cuando quieras.", "Archived. You can restore it any time."));
      window.dispatchEvent(new CustomEvent(kind === "base" ? "zenin:bases-changed" : "zenin:catalog-changed"));
      await load({ quiet: true });
    } catch (error) {
      if (error?.code !== "STALE_REQUEST") announce(apiErrorMessage(error));
    } finally {
      state.busyId = "";
      changed();
    }
  }

  /* ---------- Shared render helpers ---------- */
  const alertHTML = (message) => (message ? `<div class="admin-alert studio-alert" role="alert"><span>${esc(message)}</span></div>` : "");
  function dropHTML(target, url, { label, hint = "", hex = "", multiple = false, compact = false, wide = false } = {}) {
    const job = state.wizard?.jobs.get(target);
    const status = job
      ? `<span class="studio-drop-status ${job.status === "error" ? "is-error" : ""}">${job.status === "error" ? esc(job.error) : job.status === "preparing" ? l("Preparando…", "Preparing…") : `${l("Subiendo…", "Uploading…")}${job.note ? ` · ${esc(job.note)}` : ""}`}</span>`
      : "";
    return `<label class="studio-drop ${url ? "has-image" : ""} ${compact ? "is-compact" : ""} ${wide ? "is-wide" : ""} ${job?.status === "error" ? "has-error" : ""}" data-drop="${esc(target)}" style="${hex ? stageStyle(hex) : ""}">${url ? `<img src="${esc(url)}" alt="" draggable="false">` : `<span class="studio-drop-icon" aria-hidden="true">＋</span>`}<span class="studio-drop-label"><strong>${esc(url ? l("Cambiar PNG", "Replace PNG") : label)}</strong>${!url && hint ? `<small>${esc(hint)}</small>` : ""}</span>${status}<input type="file" accept="image/png" data-upload="${esc(target)}" ${multiple ? "multiple" : ""}></label>`;
  }
  function videoDropHTML(target, { label, hint = "", multiple = false } = {}) {
    return `<label class="studio-drop is-wide is-video" data-drop="${esc(target)}"><span class="studio-drop-icon" aria-hidden="true">▶</span><span class="studio-drop-label"><strong>${esc(label)}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</span><input type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.mov,.webm" data-upload="${esc(target)}" ${multiple ? "multiple" : ""}></label>`;
  }
  function videoPreviewHTML(scope, item, overlay = "") {
    const job = state.wizard?.jobs.get(`video:${scope}:${item.key}`);
    const src = item.preview || item.url;
    const poster = item.posterPreview || item.posterUrl;
    const status = job
      ? `<span class="studio-drop-status ${job.status === "error" ? "is-error" : ""}">${job.status === "error" ? esc(job.error) : job.status === "preparing" ? l("Revisando video…", "Checking video…") : `${l("Subiendo video…", "Uploading video…")} ${esc(job.note || "")}`}</span>`
      : "";
    return `<div class="studio-video ${item.orientation === "vertical" ? "is-vertical" : ""}">${src ? `<video src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ""} muted loop playsinline controls preload="metadata"></video>` : `<div class="studio-video-empty">▶</div>`}${overlay}${status}</div>`;
  }
  const videoTips = () =>
    l("MP4 (H.264) o WebM · hasta 50 MB · recomendado 1080p, 6–20 s, sin audio. La primera imagen se usa mientras carga.", "MP4 (H.264) or WebM · up to 50 MB · 1080p, 6–20 s, no audio recommended. The first frame shows while loading.");
  function videoOrderButtons(action, index, total, key) {
    return `<div class="studio-order"><button type="button" data-studio="${action}-up" data-key="${key}" ${index === 0 ? "disabled" : ""} aria-label="${l("Subir", "Move up")}">↑</button><button type="button" data-studio="${action}-down" data-key="${key}" ${index === total - 1 ? "disabled" : ""} aria-label="${l("Bajar", "Move down")}">↓</button><button type="button" data-studio="${action}-remove" data-key="${key}" aria-label="${l("Quitar", "Remove")}">×</button></div>`;
  }
  const field = (id, label, input, note = "") =>
    `<div class="studio-field"><label for="${id}">${label}</label>${input}${note ? `<small>${note}</small>` : ""}</div>`;
  const textInput = (id, name, value, attrs = "") =>
    `<input id="${id}" data-field="${name}" value="${esc(value)}" ${attrs}>`;
  const textArea = (id, name, value, attrs = "") => `<textarea id="${id}" data-field="${name}" rows="3" ${attrs}>${esc(value)}</textarea>`;
  function hexControls(scope, item, idPrefix) {
    return `<div class="studio-hex"><input type="color" id="${idPrefix}-picker" data-field="${scope}.hex" data-key="${item.key}" value="${esc(HEX.test(item.hex) ? item.hex : "#888888")}" aria-label="${l("Color", "Color")}"><input id="${idPrefix}-hex" data-field="${scope}.hexText" data-key="${item.key}" value="${esc(item.hex)}" maxlength="7" spellcheck="false" aria-label="Hex">${item.detected && item.detected.toLowerCase() !== item.hex.toLowerCase() ? `<button type="button" class="studio-chip" data-studio="use-detected" data-scope="${scope}" data-key="${item.key}" style="--chip:${esc(item.detected)}">${l("Detectado", "Detected")} ${esc(item.detected)}</button>` : ""}</div>`;
  }
  function sizesHTML(draft, presets, scope) {
    const all = [...new Set([...presets, ...draft.sizes])];
    return `<div class="studio-sizes">${all
      .map(
        (size) =>
          `<button type="button" class="studio-size ${draft.sizes.includes(size) ? "is-on" : ""}" data-studio="toggle-size" data-size="${esc(size)}" aria-pressed="${draft.sizes.includes(size)}">${esc(size)}</button>`,
      )
      .join("")}<span class="studio-size-add"><input id="st-${scope}-custom-size" data-field="customSize" value="${esc(draft.customSize)}" maxlength="24" placeholder="${l("Otra…", "Other…")}"><button type="button" class="admin-button admin-button-light" data-studio="add-size">${l("Agregar", "Add")}</button></span></div>`;
  }
  const composed = (product, side, cls = "") =>
    typeof shirtHTML === "function" ? shirtHTML(product, `studio-art ${cls}`, side) : "";
  function previewProduct(draft, base, color, side) {
    return {
      name: draft.nameEs || "Preview",
      nameEs: draft.nameEs,
      kind: "apparel",
      printSides: draft.printSides,
      frontDesignUrl: draft.frontDesignPreview || draft.frontDesignUrl,
      backDesignUrl: draft.backDesignPreview || draft.backDesignUrl,
      designUrl: draft.frontDesignPreview || draft.frontDesignUrl || draft.backDesignPreview || draft.backDesignUrl,
      shirt: color.shirt,
      availableShirts: [color.shirt],
      shirtOptions: [optionFromColor(base, color)],
      view: side,
    };
  }
  function stepperHTML(wizard) {
    const steps = WIZARD_STEPS[wizard.type]();
    return `<ol class="studio-stepper">${steps
      .map(
        (label, index) =>
          `<li class="${index === wizard.step ? "is-current" : index < wizard.step ? "is-done" : ""}"><button type="button" data-studio="goto" data-step="${index}" ${wizard.busy || wizard.done ? "disabled" : ""}><span>${index < wizard.step ? "✓" : index + 1}</span>${esc(label)}</button></li>`,
      )
      .join("")}</ol>`;
  }

  /* ---------- Wizard bodies ---------- */
  function shirtStep(wizard) {
    const draft = wizard.draft;
    if (wizard.step === 0)
      return `<div class="studio-grid-2">${field("st-shirt-name", l("Nombre del tipo de camiseta", "Shirt type name"), textInput("st-shirt-name", "name", draft.name, `maxlength="120" placeholder="${l("Ej. Camiseta Heavy", "E.g. Heavy Tee")}"`))}${field("st-shirt-type", l("Corte / tipo", "Cut / type"), `${textInput("st-shirt-type", "type", draft.type, `maxlength="80" list="st-fit-presets" placeholder="Regular, Oversize…"`)}<datalist id="st-fit-presets">${FIT_PRESETS.map((fit) => `<option value="${esc(fit)}">`).join("")}</datalist>`)}${field("st-shirt-weight", l("Gramaje (g/m²)", "Fabric weight (g/m²)"), textInput("st-shirt-weight", "weightGsm", draft.weightGsm, `inputmode="numeric" placeholder="180"`), l("Opcional.", "Optional."))}</div><div class="studio-field"><span class="studio-label">${l("Tallas disponibles", "Available sizes")}</span>${sizesHTML(draft, SIZE_PRESETS, "shirt")}${draft.inUse ? `<small>${l("Hay diseños activos con este tipo: para cambiar tallas, archívalos primero.", "Active designs use this type: archive them before changing sizes.")}</small>` : ""}</div>`;
    if (wizard.step === 1)
      return `<p class="studio-lead">${l("Sube un PNG por color (camiseta lisa, fondo transparente, mismo encuadre en todos). El sistema detecta el color y lo usa para el fondo dinámico de las fotos de producto; ajústalo si hace falta. La foto de espalda es opcional y solo se necesita para diseños en la espalda.", "Upload one PNG per color (blank shirt, transparent background, same framing). The color is detected and drives the dynamic product photo backdrop; adjust it if needed. The back photo is optional and only needed for back prints.")}</p>${dropHTML("color-batch", "", { label: l("Arrastra aquí todos los PNG de colores", "Drop all color PNGs here"), hint: l("Puedes soltar varios a la vez · los archivos con “espalda” o “back” en el nombre se asignan como espalda", "Drop several at once · files named “back” or “espalda” become back photos"), multiple: true, wide: true })}<div class="studio-color-list">${draft.colors
        .map(
          (color, index) =>
            `<article class="studio-color-row"><div class="studio-color-images">${dropHTML(`color:${color.key}:front`, color.imagePreview || color.imageUrl, { label: l("Frente", "Front"), hint: "PNG", hex: color.hex, compact: true })}${dropHTML(`color:${color.key}:back`, color.backPreview || color.backImageUrl, { label: l("Espalda", "Back"), hint: l("Opcional", "Optional"), hex: color.hex, compact: true })}</div><div class="studio-color-fields">${field(`st-color-name-${index}`, l("Nombre del color", "Color name"), `<input id="st-color-name-${index}" data-field="color.name" data-key="${color.key}" value="${esc(color.name)}" maxlength="80" placeholder="${l("Ej. Negro", "E.g. Black")}">`)}<div class="studio-field"><span class="studio-label">${l("Color (hex)", "Color (hex)")}</span>${hexControls("color", color, `st-color-${index}`)}</div><span class="studio-bg-note" data-hex-preview="${color.key}" style="${stageStyle(color.hex)}">${l("Fondo en la tienda", "Store backdrop")}</span></div><button type="button" class="studio-remove" data-studio="remove-color" data-key="${color.key}" aria-label="${l("Quitar color", "Remove color")}">×</button></article>`,
        )
        .join("")}</div><button type="button" class="admin-button admin-button-light" data-studio="add-color">+ ${l("Agregar color vacío", "Add empty color")}</button>`;
    if (wizard.step === 2) {
      const first = draft.colors[0];
      const side = draft.previewSide === "back" && (first?.backPreview || first?.backImageUrl) ? "back" : "front";
      const base = { id: "preview", name: draft.name, type: draft.type, weightGsm: draft.weightGsm, sizes: draft.sizes, printArea: draft.printArea };
      const product = first
        ? { name: draft.name, kind: "apparel", printSides: "both", frontDesignUrl: SAMPLE_DESIGN, backDesignUrl: SAMPLE_DESIGN, shirt: 1, availableShirts: [1], shirtOptions: [{ ...optionFromColor(base, first), shirt: 1 }] }
        : null;
      const slider = (key, label, min, max) =>
        `<label class="studio-slider" for="st-area-${key}"><span>${label}</span><input type="range" id="st-area-${key}" data-field="area.${key}" min="${min}" max="${max}" step="0.5" value="${draft.printArea[key]}"><output data-area-output="${key}">${draft.printArea[key]}%</output></label>`;
      return `<div class="studio-area"><div class="studio-area-preview" style="${stageStyle(first?.hex)}">${product ? `<div data-area-art>${composed(product, side)}</div>` : ""}${first?.backPreview || first?.backImageUrl ? `<div class="side-toggle"><button type="button" data-studio="preview-side" data-side="front" aria-pressed="${side === "front"}">${l("Frente", "Front")}</button><button type="button" data-studio="preview-side" data-side="back" aria-pressed="${side === "back"}">${l("Espalda", "Back")}</button></div>` : ""}</div><div class="studio-area-controls"><p class="studio-lead">${l("Define dónde va el diseño sobre este tipo de camiseta. Se usa la misma área para frente y espalda, y para todos los diseños que usen este tipo.", "Set where artwork sits on this shirt type. The same area is used for front and back and for every design using this type.")}</p>${slider("x", l("Desde la izquierda", "From left"), 0, 90)}${slider("y", l("Desde arriba", "From top"), 0, 90)}${slider("w", l("Ancho", "Width"), 5, 100)}${slider("h", l("Alto", "Height"), 5, 100)}<button type="button" class="admin-text-button" data-studio="reset-area">${l("Restablecer área recomendada", "Reset recommended area")}</button></div></div>`;
    }
    return `<div class="studio-review"><dl class="studio-facts"><div><dt>${l("Tipo", "Type")}</dt><dd>${esc(draft.name)} · ${esc(draft.type)}</dd></div><div><dt>${l("Gramaje", "Weight")}</dt><dd>${draft.weightGsm ? `${esc(draft.weightGsm)} g/m²` : "—"}</dd></div><div><dt>${l("Tallas", "Sizes")}</dt><dd>${esc(draft.sizes.join(" · "))}</dd></div><div><dt>${l("Colores", "Colors")}</dt><dd>${draft.colors.length} · ${draft.colors.filter((c) => c.backImageUrl).length} ${l("con espalda", "with back")}</dd></div></dl><div class="studio-swatch-review">${draft.colors.map((color) => `<figure style="${stageStyle(color.hex)}"><img src="${esc(color.imagePreview || color.imageUrl)}" alt=""><figcaption><i style="background:${esc(color.hex)}"></i>${esc(color.name)}</figcaption></figure>`).join("")}</div></div>`;
  }
  function collectionStep(wizard) {
    const draft = wizard.draft;
    if (wizard.step === 0)
      return `<div class="studio-grid-2">${field("st-col-name", l("Nombre de la colección", "Collection name"), textInput("st-col-name", "nameEs", draft.nameEs, `maxlength="80" placeholder="${l("Ej. Verano 2027", "E.g. Summer 2027")}"`))}${field("st-col-name-en", l("Nombre en inglés", "English name"), textInput("st-col-name-en", "name", draft.name, `maxlength="80"`), l("Opcional. Si lo dejas vacío se usa el mismo nombre.", "Optional. Defaults to the same name."))}${field("st-col-desc", l("Descripción", "Description"), textArea("st-col-desc", "descriptionEs", draft.descriptionEs, `maxlength="600"`))}${field("st-col-desc-en", l("Descripción en inglés", "English description"), textArea("st-col-desc-en", "description", draft.description, `maxlength="600"`))}${field("st-col-slug", l("URL de la colección", "Collection URL"), textInput("st-col-slug", "slug", draft.slug, `maxlength="80" placeholder="${esc(draft.nameEs ? draft.nameEs.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "verano-2027")}"`), l("Opcional. Se genera a partir del nombre.", "Optional. Generated from the name."))}${field("st-col-order", l("Orden en el menú", "Menu order"), textInput("st-col-order", "sortOrder", draft.sortOrder, `inputmode="numeric"`))}</div>`;
    if (wizard.step === 1)
      return `<div class="studio-cover"><div>${dropHTML("cover", draft.coverPreview || draft.coverUrl, { label: l("Sube el PNG del cover", "Upload the cover PNG"), hint: l("Se usa en la página y el menú de la colección. PNG transparente recomendado.", "Used on the collection page and tiles. Transparent PNG recommended."), hex: draft.accent, wide: true })}</div><div class="studio-field"><span class="studio-label">${l("Color de acento", "Accent color")}</span>${hexControls("collection", { key: "accent", hex: draft.accent, detected: draft.detected }, "st-accent")}<small>${l("Se detecta del cover y decora el fondo de la página de la colección.", "Detected from the cover; it decorates the collection page background.")}</small></div></div>`;
    if (wizard.step === 2)
      return `<p class="studio-lead">${l("Opcional. Los videos de la colección se muestran en su página, debajo del cover, y se reproducen solos y en silencio al aparecer en pantalla.", "Optional. Collection videos appear on its page below the cover and play muted when they scroll into view.")}</p>${draft.videos.length < 6 ? videoDropHTML("video-batch:collection", { label: l("Arrastra aquí los videos de la colección", "Drop the collection videos here"), hint: videoTips(), multiple: true }) : ""}<div class="studio-video-grid">${draft.videos.map((video, index) => `<article class="studio-video-card">${videoPreviewHTML("collection", video)}${videoOrderButtons("video", index, draft.videos.length, video.key)}</article>`).join("")}</div>`;
    return `<div class="studio-collection-preview collection-hero" style="--accent:${esc(draft.accent)}"><div class="collection-hero-copy"><span class="collection-hero-eyebrow">${l("COLECCIÓN", "COLLECTION")}</span><h1>${esc(draft.nameEs)}</h1>${draft.descriptionEs ? `<p>${esc(draft.descriptionEs)}</p>` : ""}</div><div class="collection-hero-art"><img src="${esc(draft.coverPreview || draft.coverUrl)}" alt=""></div></div>${draft.videos.length ? `<p class="studio-note">${draft.videos.length} ${draft.videos.length === 1 ? l("video en la página de la colección", "video on the collection page") : l("videos en la página de la colección", "videos on the collection page")}</p>` : ""}`;
  }
  function collectionSelect(draft, optional) {
    const options = activeCollections();
    return `<div class="studio-collection-picks">${optional || !options.length ? `<button type="button" class="studio-collection-pick ${!draft.collectionId ? "is-on" : ""}" data-studio="pick-collection" data-id=""><span class="studio-collection-none">—</span><strong>${l("Sin colección", "No collection")}</strong></button>` : ""}${options
      .map(
        (collection) =>
          `<button type="button" class="studio-collection-pick ${draft.collectionId === collection.id ? "is-on" : ""}" data-studio="pick-collection" data-id="${esc(collection.id)}" style="--accent:${esc(collection.accent)}"><img src="${esc(collection.coverUrl)}" alt=""><strong>${esc(collectionTitle(collection))}</strong></button>`,
      )
      .join("")}<a class="studio-collection-pick is-new" href="#admin/collections/new"><span>＋</span><strong>${l("Nueva colección", "New collection")}</strong></a></div>`;
  }
  function productStep(wizard) {
    const draft = wizard.draft;
    if (wizard.step === 0)
      return `<div class="studio-field"><span class="studio-label">${l("¿En qué colección va este diseño?", "Which collection is this design in?")}</span>${collectionSelect(draft, true)}</div><div class="studio-grid-2">${field("st-prod-name", l("Nombre del diseño", "Design name"), textInput("st-prod-name", "nameEs", draft.nameEs, `maxlength="120" placeholder="${l("Ej. Sol de medianoche", "E.g. Midnight Sun")}"`))}${field("st-prod-name-en", l("Nombre en inglés", "English name"), textInput("st-prod-name-en", "name", draft.name, `maxlength="120"`), l("Opcional.", "Optional."))}${field("st-prod-desc", l("Descripción", "Description"), textArea("st-prod-desc", "descriptionEs", draft.descriptionEs, `maxlength="2000"`))}${field("st-prod-desc-en", l("Descripción en inglés", "English description"), textArea("st-prod-desc-en", "description", draft.description, `maxlength="2000"`))}</div><label class="studio-check"><input type="checkbox" data-field="isNew" ${draft.isNew ? "checked" : ""}> ${l("Mostrar en Novedades", "Show in New arrivals")}</label>`;
    if (wizard.step === 1) {
      const sides = [
        ["front", l("Solo frente", "Front only"), l("Un PNG para el pecho.", "One PNG for the chest.")],
        ["back", l("Solo espalda", "Back only"), l("Un PNG para la espalda.", "One PNG for the back.")],
        ["both", l("Frente y espalda", "Front and back"), l("Dos PNG, uno por cara.", "Two PNGs, one per side.")],
      ];
      const sample = activeBases()[0];
      const sampleColor = sample?.colors.find((c) => draft.printSides === "front" || c.backImageUrl) || sample?.colors[0];
      return `<div class="studio-sides">${sides.map(([id, label, hint]) => `<button type="button" class="studio-side ${draft.printSides === id ? "is-on" : ""}" data-studio="print-sides" data-side="${id}" aria-pressed="${draft.printSides === id}"><span class="studio-side-icon is-${id}" aria-hidden="true"></span><strong>${label}</strong><small>${hint}</small></button>`).join("")}</div><div class="studio-design-uploads">${draft.printSides !== "back" ? `<div><span class="studio-label">${l("Diseño del frente", "Front artwork")}</span>${dropHTML("design::front", draft.frontDesignPreview || draft.frontDesignUrl, { label: l("Sube el PNG del frente", "Upload the front PNG"), hint: l("Fondo transparente", "Transparent background"), hex: "#3a3a40" })}</div>` : ""}${draft.printSides !== "front" ? `<div><span class="studio-label">${l("Diseño de la espalda", "Back artwork")}</span>${dropHTML("design::back", draft.backDesignPreview || draft.backDesignUrl, { label: l("Sube el PNG de la espalda", "Upload the back PNG"), hint: l("Fondo transparente", "Transparent background"), hex: "#3a3a40" })}</div>` : ""}${sample && sampleColor ? `<div class="studio-live"><span class="studio-label">${l("Así se verá", "Live preview")}</span><div class="studio-live-row">${(draft.printSides === "both" ? ["front", "back"] : [draft.printSides]).map((side) => `<div class="studio-live-stage" style="${stageStyle(sampleColor.hex)}">${composed(previewProduct(draft, sample, sampleColor, side), side)}<span>${side === "back" ? l("Espalda", "Back") : l("Frente", "Front")}</span></div>`).join("")}</div></div>` : ""}</div>`;
    }
    if (wizard.step === 2) {
      const needsBack = draft.printSides !== "front";
      return `<p class="studio-lead">${l("Elige en qué tipos de camiseta y colores se vende este diseño, y el precio de cada tipo.", "Choose the shirt types and colors for this design and the price of each type.")}${needsBack ? ` ${l("Los colores sin foto de espalda no se pueden elegir para diseños de espalda.", "Colors without a back photo can't be used for back prints.")}` : ""}</p>${activeBases()
        .map((base) => {
          const choice = draft.selected[base.id] || { enabled: false, price: "", shirts: [] };
          return `<section class="studio-base-pick ${choice.enabled ? "is-on" : ""}"><header><label class="studio-check"><input type="checkbox" data-field="base.enabled" data-base="${esc(base.id)}" ${choice.enabled ? "checked" : ""}><strong>${esc(base.name)}</strong><span>${esc([base.type, base.weightGsm ? `${base.weightGsm} g/m²` : "", base.sizes.join(" ")].filter(Boolean).join(" · "))}</span></label>${choice.enabled ? `<label class="studio-price" for="st-price-${esc(base.id)}"><span>${l("Precio USD", "Price USD")}</span><input id="st-price-${esc(base.id)}" data-field="base.price" data-base="${esc(base.id)}" value="${esc(choice.price)}" inputmode="decimal" placeholder="35.00"></label><button type="button" class="admin-text-button" data-studio="all-colors" data-base="${esc(base.id)}">${l("Todos los colores", "All colors")}</button>` : ""}</header>${choice.enabled ? `<div class="studio-color-picks">${base.colors
                .map((color) => {
                  const disabled = needsBack && !color.backImageUrl;
                  const on = choice.shirts.includes(color.shirt);
                  return `<button type="button" class="studio-color-pick ${on ? "is-on" : ""}" data-studio="toggle-color" data-base="${esc(base.id)}" data-shirt="${color.shirt}" ${disabled ? `disabled title="${l("Falta la foto de espalda", "Back photo missing")}"` : ""} aria-pressed="${on}" style="${stageStyle(color.hex)}">${composed(previewProduct(draft, base, color, draft.printSides === "back" ? "back" : "front"), draft.printSides === "back" ? "back" : "front")}<span><i style="background:${esc(color.hex)}"></i>${esc(color.name)}${disabled ? ` · ${l("sin espalda", "no back")}` : ""}</span></button>`;
                })
                .join("")}</div>` : ""}</section>`;
        })
        .join("")}${!activeBases().length ? `<div class="studio-empty-note">${l("No hay tipos de camiseta activos.", "No active shirt types.")} <a href="#admin/shirts/new">${l("Agregar uno", "Add one")}</a></div>` : ""}`;
    }
    if (wizard.step === 3) {
      const combos = selectedShirts(draft);
      const showToggle = draft.printSides === "both";
      const side = showToggle ? draft.previewSide : draft.printSides === "back" ? "back" : "front";
      return `<div class="studio-preview-head"><p class="studio-lead">${l("Así se verá cada combinación en la tienda, con su fondo dinámico. Toca una para que sea la foto principal.", "This is how each combination looks in the store, with its dynamic backdrop. Tap one to make it the main photo.")}</p>${showToggle ? `<div class="side-toggle is-inline"><button type="button" data-studio="preview-side" data-side="front" aria-pressed="${side === "front"}">${l("Frente", "Front")}</button><button type="button" data-studio="preview-side" data-side="back" aria-pressed="${side === "back"}">${l("Espalda", "Back")}</button></div>` : ""}</div><div class="studio-preview-grid">${combos
        .map(
          ({ base, color }) =>
            `<button type="button" class="studio-preview-card ${draft.shirt === color.shirt ? "is-main" : ""}" data-studio="main-shirt" data-shirt="${color.shirt}" style="${stageStyle(color.hex)}">${composed(previewProduct(draft, base, color, side), side)}<span>${esc(base.name)} · ${esc(color.name)}<b>${money(priceValue(draft.selected[base.id].price))}</b></span>${draft.shirt === color.shirt ? `<em>${l("Principal", "Main")}</em>` : ""}</button>`,
        )
        .join("")}</div>${wizard.record ? `<p class="studio-note">${l("Las existencias de un diseño publicado se ajustan en Inventario.", "Stock for a published design is adjusted in Inventory.")}</p>` : `<div class="studio-grid-2 studio-stock">${field("st-prod-stock", l("Unidades iniciales por color y talla", "Opening units per color and size"), textInput("st-prod-stock", "initialStock", draft.initialStock, `inputmode="numeric"`), l("Puedes dejar 0: el stock es informativo y no bloquea ventas.", "0 is fine: stock is informational and never blocks a sale."))}${field("st-prod-threshold", l("Aviso de stock bajo", "Low-stock alert"), textInput("st-prod-threshold", "lowStockThreshold", draft.lowStockThreshold, `inputmode="numeric"`))}</div>`}`;
    }
    const combos = selectedShirts(draft);
    const collection = findCollection(draft.collectionId);
    const bases = activeBases().filter((base) => draft.selected[base.id]?.enabled);
    const main = combos.find(({ color }) => color.shirt === draft.shirt) || combos[0];
    return `<div class="studio-publish"><div class="studio-publish-art" style="${stageStyle(main?.color.hex)}">${main ? composed(previewProduct(draft, main.base, main.color, draft.printSides === "back" ? "back" : "front"), draft.printSides === "back" ? "back" : "front") : ""}</div><dl class="studio-facts"><div><dt>${l("Diseño", "Design")}</dt><dd>${esc(draft.nameEs)}${draft.isNew ? ` · <span class="studio-tag">${l("Nuevo", "New")}</span>` : ""}</dd></div><div><dt>${l("Colección", "Collection")}</dt><dd>${esc(collectionTitle(collection) || l("Sin colección", "No collection"))}</dd></div><div><dt>${l("Impresión", "Print")}</dt><dd>${{ front: l("Frente", "Front"), back: l("Espalda", "Back"), both: l("Frente y espalda", "Front and back") }[draft.printSides]}</dd></div><div><dt>${l("Combinaciones", "Combinations")}</dt><dd>${combos.length} ${l("colores", "colors")} · ${bases.length} ${l("tipos", "types")}</dd></div>${bases.map((base) => `<div><dt>${esc(base.name)}</dt><dd>${money(priceValue(draft.selected[base.id].price))} · ${draft.selected[base.id].shirts.length} ${l("colores", "colors")}</dd></div>`).join("")}${wizard.record ? "" : `<div><dt>${l("Stock inicial", "Opening stock")}</dt><dd>${esc(draft.initialStock)} ${l("por talla", "per size")}</dd></div>`}</dl></div>`;
  }
  function articleStep(wizard) {
    const draft = wizard.draft;
    if (wizard.step === 0)
      return `<div class="studio-grid-2">${field("st-art-name", l("Nombre del artículo", "Article name"), textInput("st-art-name", "nameEs", draft.nameEs, `maxlength="120" placeholder="${l("Ej. Botella Club", "E.g. Club Bottle")}"`))}${field("st-art-type", l("Tipo de artículo", "Article type"), `${textInput("st-art-type", "articleType", draft.articleType, `maxlength="80" list="st-article-types" placeholder="${l("Botella, llavero…", "Bottle, keychain…")}"`)}<datalist id="st-article-types">${ARTICLE_TYPES.map((type) => `<option value="${esc(type)}">`).join("")}</datalist>`)}${field("st-art-name-en", l("Nombre en inglés", "English name"), textInput("st-art-name-en", "name", draft.name, `maxlength="120"`), l("Opcional.", "Optional."))}${field("st-art-desc", l("Descripción", "Description"), textArea("st-art-desc", "descriptionEs", draft.descriptionEs, `maxlength="2000"`))}</div><div class="studio-field"><span class="studio-label">${l("Colección (opcional)", "Collection (optional)")}</span>${collectionSelect(draft, true)}</div><label class="studio-check"><input type="checkbox" data-field="isNew" ${draft.isNew ? "checked" : ""}> ${l("Mostrar en Novedades", "Show in New arrivals")}</label>`;
    if (wizard.step === 1)
      return `<p class="studio-lead">${l("Sube una foto PNG por variante (por ejemplo, cada color de la botella). El color se detecta para el fondo dinámico.", "Upload one PNG photo per variant (for example, each bottle color). The color is detected for the dynamic backdrop.")}</p>${dropHTML("variant-batch", "", { label: l("Arrastra aquí las fotos del artículo", "Drop the article photos here"), hint: l("Una por variante · puedes soltar varias", "One per variant · drop several"), multiple: true, wide: true })}<div class="studio-color-list">${draft.variants
        .map(
          (variant, index) =>
            `<article class="studio-color-row"><div class="studio-color-images">${dropHTML(`variant:${variant.key}:front`, variant.imagePreview || variant.imageUrl, { label: l("Foto", "Photo"), hint: "PNG", hex: variant.hex, compact: true })}</div><div class="studio-color-fields">${field(`st-variant-name-${index}`, l("Nombre de la variante", "Variant name"), `<input id="st-variant-name-${index}" data-field="variant.name" data-key="${variant.key}" value="${esc(variant.name)}" maxlength="80" placeholder="${l("Ej. Negro mate", "E.g. Matte black")}">`)}<div class="studio-field"><span class="studio-label">${l("Color (hex)", "Color (hex)")}</span>${hexControls("variant", variant, `st-variant-${index}`)}</div></div><button type="button" class="studio-remove" data-studio="remove-variant" data-key="${variant.key}" aria-label="${l("Quitar variante", "Remove variant")}">×</button></article>`,
        )
        .join("")}</div><div class="studio-field"><span class="studio-label">${l("Medidas / tallas", "Options / sizes")}</span>${sizesHTML(draft, ["Única"], "article")}<small>${l("Usa “Única” si no tiene tallas. Puedes agregar medidas como 500 ml o 750 ml.", "Use “Única” for one size. Add options like 500 ml or 750 ml.")}</small></div>`;
    if (wizard.step === 2)
      return `<div class="studio-grid-2">${field("st-art-price", l("Precio USD", "Price USD"), textInput("st-art-price", "price", draft.price, `inputmode="decimal" placeholder="18.00"`))}${wizard.record ? "" : field("st-art-stock", l("Unidades iniciales por variante y medida", "Opening units per variant and option"), textInput("st-art-stock", "initialStock", draft.initialStock, `inputmode="numeric"`))}${wizard.record ? "" : field("st-art-threshold", l("Aviso de stock bajo", "Low-stock alert"), textInput("st-art-threshold", "lowStockThreshold", draft.lowStockThreshold, `inputmode="numeric"`))}</div><div class="studio-field"><span class="studio-label">${l("Foto principal", "Main photo")}</span><div class="studio-preview-grid">${draft.variants
        .map((variant) => {
          const id = variant.shirt ?? variant.key;
          return `<button type="button" class="studio-preview-card ${draft.defaultShirt === id ? "is-main" : ""}" data-studio="main-variant" data-id="${esc(id)}" style="${stageStyle(variant.hex)}"><div class="shirt-art is-article"><img class="shirt-base" src="${esc(variant.imagePreview || variant.imageUrl)}" alt=""></div><span>${esc(variant.name)}</span>${draft.defaultShirt === id ? `<em>${l("Principal", "Main")}</em>` : ""}</button>`;
        })
        .join("")}</div></div>`;
    const main = draft.variants.find((v) => (v.shirt ?? v.key) === draft.defaultShirt) || draft.variants[0];
    return `<div class="studio-publish"><div class="studio-publish-art" style="${stageStyle(main?.hex)}">${main ? `<div class="shirt-art is-article"><img class="shirt-base" src="${esc(main.imagePreview || main.imageUrl)}" alt=""></div>` : ""}</div><dl class="studio-facts"><div><dt>${l("Artículo", "Article")}</dt><dd>${esc(draft.nameEs)} · ${esc(draft.articleType)}</dd></div><div><dt>${l("Colección", "Collection")}</dt><dd>${esc(collectionTitle(findCollection(draft.collectionId)) || l("Sin colección", "No collection"))}</dd></div><div><dt>${l("Precio", "Price")}</dt><dd>${money(priceValue(draft.price))}</dd></div><div><dt>${l("Variantes", "Variants")}</dt><dd>${esc(draft.variants.map((v) => v.name).join(", "))}</dd></div><div><dt>${l("Medidas", "Options")}</dt><dd>${esc(draft.sizes.join(" · "))}</dd></div></dl></div>`;
  }
  function doneHTML(wizard) {
    const done = wizard.done;
    const edited = Boolean(wizard.record);
    const actions = {
      shirt: `<button type="button" class="admin-button admin-button-light" data-studio="new" data-type="shirt">+ ${l("Otro tipo de camiseta", "Another shirt type")}</button><a class="admin-button admin-button-primary" href="#admin/collections/new">${l("Siguiente: crear colección", "Next: create a collection")} →</a>`,
      collection: `<button type="button" class="admin-button admin-button-light" data-studio="new" data-type="collection">+ ${l("Otra colección", "Another collection")}</button><a class="admin-button admin-button-primary" href="#admin/products/new:${esc(done.id || "")}">${l("Agregar diseños a esta colección", "Add designs to this collection")} →</a>`,
      product: `<button type="button" class="admin-button admin-button-light" data-studio="new" data-type="product" data-collection="${esc(done.collectionId || "")}">+ ${l("Otro diseño", "Another design")}${done.collectionId ? ` ${l("en esta colección", "in this collection")}` : ""}</button>${done.slug ? `<a class="admin-button admin-button-primary" href="#product/${encodeURIComponent(done.slug)}">${l("Ver en la tienda", "View in store")} ↗</a>` : ""}`,
      article: `<button type="button" class="admin-button admin-button-light" data-studio="new" data-type="article">+ ${l("Otro artículo", "Another article")}</button>${done.slug ? `<a class="admin-button admin-button-primary" href="#product/${encodeURIComponent(done.slug)}">${l("Ver en la tienda", "View in store")} ↗</a>` : ""}`,
    }[wizard.type];
    return `<div class="studio-done"><span class="studio-done-mark" aria-hidden="true">✓</span><h2>${edited ? l("Cambios guardados", "Changes saved") : l("¡Listo!", "Done!")}</h2><p>${esc(done.nameEs || done.name || "")}</p><div class="studio-done-actions">${actions}<button type="button" class="admin-text-button" data-studio="close">${l("Volver a la lista", "Back to the list")}</button></div></div>`;
  }
  function linkOptions(current) {
    const options = [
      ["#shop", l("Toda la tienda", "Shop all")],
      ["#shop/new", l("Novedades", "New arrivals")],
      ...activeCollections().map((collection) => [`#shop/${collection.slug}`, `${l("Colección", "Collection")}: ${collectionTitle(collection)}`]),
      ...(articles().some((product) => product.active) ? [["#shop/articles", l("Artículos", "Articles")]] : []),
      ["#order", l("Seguir mi pedido", "Track my order")],
    ];
    if (current && !options.some(([value]) => value === current)) options.push([current, current]);
    return options.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`).join("");
  }
  function landingHTML(wizard) {
    const draft = wizard.draft;
    const slides = draft.slides;
    return `<section class="studio-landing"><div class="studio-list-head"><h2>${l("Videos del landing", "Landing videos")}</h2><div><a class="admin-button admin-button-light" href="#" target="_blank" rel="noopener">${l("Ver portada", "View home page")} ↗</a></div></div><p class="studio-lead">${l("Cada video es una diapositiva del inicio, con su título, texto y botón. Con varios, la portada rota cada 9 segundos. Si no hay ninguno, se muestra el video original de Zenin Club.", "Each video is a home page slide with its title, text and button. With several, the hero rotates every 9 seconds. With none, the original Zenin Club video is shown.")}</p>${alertHTML(wizard.error)}${slides.length < 6 ? videoDropHTML("video-batch:slide", { label: l("Arrastra aquí los videos del landing", "Drop the landing videos here"), hint: videoTips(), multiple: true }) : ""}<div class="studio-slides">${slides
      .map((slide, index) => {
        const overlay = `<div class="studio-slide-copy">${slide.title ? `<strong>${esc(slide.title)}</strong>` : ""}${slide.subtitle ? `<span>${esc(slide.subtitle)}</span>` : ""}${slide.buttonLabel ? `<em>${esc(slide.buttonLabel)}</em>` : ""}</div>`;
        const input = (name, label, max, placeholder = "") =>
          field(`st-slide-${name}-${index}`, label, `<input id="st-slide-${name}-${index}" data-field="slide.${name}" data-key="${slide.key}" value="${esc(slide[name])}" maxlength="${max}" placeholder="${esc(placeholder)}">`);
        return `<article class="studio-slide"><div class="studio-slide-head"><span class="studio-slide-number">${index + 1}</span><strong>${l("Diapositiva", "Slide")} ${index + 1}</strong>${videoOrderButtons("slide", index, slides.length, slide.key)}</div><div class="studio-slide-body">${videoPreviewHTML("slide", slide, overlay)}<div class="studio-slide-fields">${input("title", l("Título", "Title"), 60, "ZENIN CLUB")}${input("titleEn", l("Título en inglés", "English title"), 60)}${input("subtitle", l("Texto", "Text"), 140, l("Tu próxima camiseta.", "Your next tee."))}${input("subtitleEn", l("Texto en inglés", "English text"), 140)}${input("buttonLabel", l("Botón", "Button"), 30, l("VER CAMISETAS", "SHOP TEES"))}${input("buttonLabelEn", l("Botón en inglés", "English button"), 30)}${field(`st-slide-link-${index}`, l("El botón lleva a", "Button links to"), `<select id="st-slide-link-${index}" data-field="slide.link" data-key="${slide.key}">${linkOptions(slide.link)}</select>`)}</div></div></article>`;
      })
      .join("")}</div>${!slides.length ? `<div class="studio-empty-note">${l("Sin videos propios todavía: la portada usa el video original.", "No custom videos yet: the home page uses the original video.")}</div>` : ""}<footer class="studio-wizard-foot studio-landing-foot"><span class="studio-foot-status">${pendingUploads() ? l("Subiendo videos…", "Uploading videos…") : wizard.dirty ? l("Cambios sin publicar", "Unpublished changes") : draft.version ? l("Publicado", "Published") : l("Sin publicar", "Not published")}</span><button type="button" class="admin-button admin-button-primary" data-studio="save" ${wizard.busy || pendingUploads() || !wizard.dirty ? "disabled" : ""}>${wizard.busy ? l("Publicando…", "Publishing…") : l("Publicar landing", "Publish landing")}</button></footer></section>`;
  }
  function paymentsHTML(wizard) {
    const draft = wizard.draft;
    const saved = state.payments || {};
    const active = saved.enabled;
    const disabled = wizard.busy ? "disabled" : "";
    return `<section class="studio-payments"><div class="studio-pay-status ${active ? "is-on" : ""}"><span class="studio-pay-dot" aria-hidden="true"></span><div><strong>${active ? l("Cobros en línea activos", "Online payments are on") : l("Cobros en línea desactivados", "Online payments are off")}</strong><p>${active ? l("Los clientes pagan con tarjeta o SINPE Móvil en la página segura de Tilopay.", "Customers pay with a card or SINPE Móvil on Tilopay's secure page.") : l("El checkout guarda los pedidos sin cobrar hasta que actives Tilopay.", "Checkout saves orders without charging until you enable Tilopay.")}${saved.verifiedAt ? ` ${l("Verificado el", "Verified on")} ${esc(new Date(saved.verifiedAt).toLocaleString(getLanguage() === "es" ? "es-CR" : "en-US", { dateStyle: "medium", timeStyle: "short" }))}` : ""}</p></div></div><div class="studio-pay-grid"><div class="studio-pay-form admin-panel">${alertHTML(wizard.error)}${wizard.testResult ? `<div class="studio-pay-ok" role="status">✓ ${esc(wizard.testResult)}</div>` : ""}${field("st-pay-user", l("Usuario API", "API user"), `<input id="st-pay-user" data-field="pay.apiUser" value="${esc(draft.apiUser)}" autocomplete="off" spellcheck="false" maxlength="120" ${disabled}>`)}${field("st-pay-password", l("Contraseña API", "API password"), `<input id="st-pay-password" type="password" data-field="pay.password" value="${esc(draft.password)}" autocomplete="new-password" maxlength="200" placeholder="${saved.hasPassword ? l("Guardada · déjala vacía para mantenerla", "Saved · leave empty to keep it") : ""}" ${disabled}>`)}${field("st-pay-key", l("Key de la integración", "Integration key"), `<input id="st-pay-key" type="password" data-field="pay.key" value="${esc(draft.key)}" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${saved.keyHint ? `${l("Guardada", "Saved")} (${esc(saved.keyHint)})` : "XXXX-XXXX-XXXX-XXXX-XXXX"}" ${disabled}>`)}<label class="studio-check studio-pay-toggle"><input type="checkbox" data-field="pay.enabled" ${draft.enabled ? "checked" : ""} ${disabled}> ${l("Cobrar en línea con Tilopay", "Charge online with Tilopay")}</label><p class="studio-note">${l("Al guardar con el cobro activado, probamos las credenciales con Tilopay antes de activarlas. Se guardan cifradas y nunca se vuelven a mostrar.", "When saving with charging on, we test the credentials with Tilopay first. They are stored encrypted and never shown again.")}</p><div class="studio-pay-actions"><button type="button" class="admin-button admin-button-light" data-studio="test-payments" ${disabled}>${wizard.busy && !wizard.dirty ? l("Probando…", "Testing…") : l("Probar conexión", "Test connection")}</button><button type="button" class="admin-button admin-button-primary" data-studio="save" ${disabled || !wizard.dirty ? "disabled" : ""}>${wizard.busy ? l("Guardando…", "Saving…") : l("Guardar", "Save")}</button></div></div><aside class="studio-tips"><h3>${l("Dónde encontrar estos datos", "Where to find these")}</h3><ul><li>${l("Entra a tu cuenta en app.tilopay.com.", "Sign in at app.tilopay.com.")}</li><li>${l("Abre Integración con plataformas y elige tu integración (sirve la de WooCommerce).", "Open Integración con plataformas and choose your integration (the WooCommerce one works).")}</li><li>${l("Copia la Key, el Usuario API y la Contraseña API y pégalos aquí.", "Copy the Key, API user and API password and paste them here.")}</li><li>${l("Para probar, activa el modo Prueba en el panel de Tilopay y paga con sus", "To test, turn on Test mode in the Tilopay dashboard and pay with its")} <a href="https://tilopay.com/developers/tarjetas-de-prueba" target="_blank" rel="noopener">${l("tarjetas de prueba", "test cards")} ↗</a>. ${l("Esos pedidos aparecen con la etiqueta TEST.", "Those orders show a TEST label.")}</li><li>${l("Cuando todo esté bien, cambia la cuenta a producción en Tilopay: no hay que tocar nada aquí.", "When ready, switch the account to production in Tilopay: nothing changes here.")}</li><li>${l("No compartas estas credenciales por chat ni correo.", "Don't share these credentials by chat or email.")}</li></ul></aside></div></section>`;
  }
  function wizardHTML() {
    const wizard = state.wizard;
    if (wizard.type === "landing") return landingHTML(wizard);
    if (wizard.type === "payments") return paymentsHTML(wizard);
    const steps = WIZARD_STEPS[wizard.type]();
    const titles = {
      shirt: wizard.record ? l("Editar tipo de camiseta", "Edit shirt type") : l("Nuevo tipo de camiseta", "New shirt type"),
      collection: wizard.record ? l("Editar colección", "Edit collection") : l("Nueva colección", "New collection"),
      product: wizard.record ? l("Editar diseño", "Edit design") : l("Nuevo diseño", "New design"),
      article: wizard.record ? l("Editar artículo", "Edit article") : l("Nuevo artículo", "New article"),
    };
    const body = wizard.done
      ? doneHTML(wizard)
      : { shirt: shirtStep, collection: collectionStep, product: productStep, article: articleStep }[wizard.type](wizard);
    const last = wizard.step === steps.length - 1;
    const saveLabel = wizard.record
      ? l("Guardar cambios", "Save changes")
      : { shirt: l("Guardar tipo de camiseta", "Save shirt type"), collection: l("Crear colección", "Create collection"), product: l("Publicar diseño", "Publish design"), article: l("Publicar artículo", "Publish article") }[wizard.type];
    return `<section class="studio-wizard admin-panel" aria-label="${esc(titles[wizard.type])}"><header class="studio-wizard-head"><div><span class="admin-eyebrow">${l("ASISTENTE", "WIZARD")}</span><h2>${esc(titles[wizard.type])}</h2></div><button type="button" class="studio-close" data-studio="close" aria-label="${l("Cerrar asistente", "Close wizard")}" ${wizard.busy ? "disabled" : ""}>×</button></header>${wizard.done ? "" : stepperHTML(wizard)}<div class="studio-wizard-body">${alertHTML(wizard.error)}${body}</div>${wizard.done ? "" : `<footer class="studio-wizard-foot"><button type="button" class="admin-button admin-button-light" data-studio="back" ${wizard.step === 0 || wizard.busy ? "disabled" : ""}>← ${l("Atrás", "Back")}</button><span class="studio-foot-status">${pendingUploads() ? l("Subiendo imágenes…", "Uploading images…") : failedUploads() ? l("Una imagen no se pudo subir: vuelve a elegirla.", "An image failed: choose it again.") : `${l("Paso", "Step")} ${wizard.step + 1} / ${steps.length}`}</span>${last ? `<button type="button" class="admin-button admin-button-primary" data-studio="save" ${wizard.busy || pendingUploads() ? "disabled" : ""}>${wizard.busy ? l("Guardando…", "Saving…") : saveLabel}</button>` : `<button type="button" class="admin-button admin-button-primary" data-studio="next" ${wizard.busy ? "disabled" : ""}>${l("Siguiente", "Next")} →</button>`}</footer>`}</section>`;
  }

  /* ---------- Lists ---------- */
  function confirmHTML(kind, id) {
    if (state.confirm?.id !== id) return "";
    return `<div class="studio-confirm" role="alert"><span>${l("¿Archivar? Se oculta de la tienda y puedes restaurarlo después.", "Archive? It is hidden from the store and can be restored later.")}</span><button type="button" class="admin-button admin-button-danger" data-studio="archive" data-kind="${kind}" data-id="${esc(id)}">${l("Archivar", "Archive")}</button><button type="button" class="admin-text-button" data-studio="cancel-confirm">${l("Cancelar", "Cancel")}</button></div>`;
  }
  function cardActions(kind, record, editAction) {
    const busy = state.busyId === record.id ? "disabled" : "";
    return record.active
      ? `<button type="button" class="admin-button admin-button-light" data-studio="${editAction}" data-id="${esc(record.id)}" ${busy}>${l("Editar", "Edit")}</button><button type="button" class="admin-text-button" data-studio="ask-archive" data-kind="${kind}" data-id="${esc(record.id)}" ${busy}>${l("Archivar", "Archive")}</button>`
      : `<button type="button" class="admin-button admin-button-light" data-studio="restore" data-kind="${kind}" data-id="${esc(record.id)}" ${busy}>${l("Restaurar", "Restore")}</button>`;
  }
  const visible = (items) => items.filter((item) => item.active || state.showArchived);
  const archivedToggle = (items) =>
    items.some((item) => !item.active)
      ? `<label class="studio-check studio-archived-toggle"><input type="checkbox" data-field="showArchived" ${state.showArchived ? "checked" : ""}> ${l("Mostrar archivados", "Show archived")} (${items.filter((i) => !i.active).length})</label>`
      : "";
  const listHead = (title, action, label, items, extra = "") =>
    `<div class="studio-list-head"><h2>${title}</h2><div>${archivedToggle(items)}${extra}<button type="button" class="admin-button admin-button-primary" data-studio="new" data-type="${action}">+ ${label}</button></div></div>`;
  const emptyHTML = (title, text, type, label) =>
    `<div class="studio-empty"><h3>${title}</h3><p>${text}</p><button type="button" class="admin-button admin-button-primary" data-studio="new" data-type="${type}">+ ${label}</button></div>`;
  function shirtsHTML() {
    const items = visible(state.bases);
    return `${listHead(l("Tipos de camiseta", "Shirt types"), "shirt", l("Nuevo tipo de camiseta", "New shirt type"), state.bases)}${items.length ? `<div class="studio-cards">${items
      .map((base) => {
        const usage = baseUsage(base.id);
        return `<article class="studio-card ${base.active ? "" : "is-archived"}"><div class="studio-card-strip">${base.colors
          .slice(0, 6)
          .map((color) => `<span style="${stageStyle(color.hex)}"><img src="${esc(color.imageUrl)}" alt="" loading="lazy"></span>`)
          .join("")}</div><div class="studio-card-body"><h3>${esc(base.name)}</h3><p>${esc([base.type, base.weightGsm ? `${base.weightGsm} g/m²` : ""].filter(Boolean).join(" · "))}</p><div class="studio-swatches">${base.colors.map((color) => `<i title="${esc(color.name)}" style="background:${esc(color.hex)}"></i>`).join("")}</div><small>${esc(base.sizes.join(" · "))} · ${base.colors.length} ${l("colores", "colors")} · ${usage} ${usage === 1 ? l("diseño", "design") : l("diseños", "designs")}</small></div><div class="studio-card-actions">${cardActions("base", base, "edit-shirt")}</div>${confirmHTML("base", base.id)}</article>`;
      })
      .join("")}</div>` : emptyHTML(l("Empieza por tus camisetas", "Start with your shirts"), l("Crea cada tipo de camiseta (corte, gramaje, tallas) y sube un PNG por color.", "Create each shirt type (cut, weight, sizes) and upload one PNG per color."), "shirt", l("Nuevo tipo de camiseta", "New shirt type"))}`;
  }
  function collectionsHTML() {
    const items = visible(state.collections);
    return `${listHead(l("Colecciones", "Collections"), "collection", l("Nueva colección", "New collection"), state.collections)}${items.length ? `<div class="studio-cards">${items
      .map(
        (collection) =>
          `<article class="studio-card ${collection.active ? "" : "is-archived"}"><div class="studio-card-cover" style="--accent:${esc(collection.accent)}"><img src="${esc(collection.coverUrl)}" alt="" loading="lazy"></div><div class="studio-card-body"><h3>${esc(collectionTitle(collection))}</h3><p>/${esc(collection.slug)}</p><small>${collection.productCount || 0} ${l("productos activos", "active products")}${collection.videos?.length ? ` · ${collection.videos.length} ${l("videos", "videos")}` : ""}</small></div><div class="studio-card-actions">${collection.active ? `<button type="button" class="admin-button admin-button-primary" data-studio="new" data-type="product" data-collection="${esc(collection.id)}" ${activeBases().length ? "" : "disabled"}>+ ${l("Diseño", "Design")}</button>` : ""}${cardActions("collection", collection, "edit-collection")}</div>${confirmHTML("collection", collection.id)}</article>`,
      )
      .join("")}</div>` : emptyHTML(l("Todavía no hay colecciones", "No collections yet"), l("Cada colección tiene un cover PNG que decora su página en la tienda.", "Each collection has a cover PNG that decorates its store page."), "collection", l("Nueva colección", "New collection"))}`;
  }
  function productCardHTML(product, editAction) {
    const range = getPriceRange(product);
    const option = product.shirtOptions?.find((o) => o.shirt === product.shirt) || product.shirtOptions?.[0];
    const types = new Set((product.shirtOptions || []).map((o) => o.baseId)).size;
    const sides = { front: l("Frente", "Front"), back: l("Espalda", "Back"), both: l("Frente y espalda", "Front and back") }[product.printSides] || "";
    return `<article class="studio-card ${product.active ? "" : "is-archived"}"><a class="studio-card-art" href="${product.active ? `#product/${encodeURIComponent(product.slug)}` : "#admin"}" style="${stageStyle(option?.hex)}" ${product.active ? "" : 'tabindex="-1"'}>${composed(product)}</a><div class="studio-card-body"><h3>${esc(productTitle(product))}</h3><p>${range.min === range.max ? money(range.min) : `${money(range.min)} – ${money(range.max)}`}</p><small>${product.kind === "article" ? `${esc(product.articleType || "")} · ${product.availableShirts.length} ${l("variantes", "variants")}` : `${sides} · ${types} ${types === 1 ? l("tipo", "type") : l("tipos", "types")} · ${product.availableShirts.length} ${l("colores", "colors")}`}${product.active ? "" : ` · ${l("Archivado", "Archived")}`}</small></div><div class="studio-card-actions">${cardActions("product", product, editAction)}</div>${confirmHTML("product", product.id)}</article>`;
  }
  function groupedProducts(items, editAction) {
    const groups = new Map();
    for (const product of items) {
      const key = product.collectionId || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (findCollection(a)?.sortOrder ?? 9999) - (findCollection(b)?.sortOrder ?? 9999))
      .map(
        ([key, list]) =>
          `<section class="studio-group"><h3 class="studio-group-title">${esc(collectionTitle(findCollection(key)) || l("Sin colección", "No collection"))}<span>${list.length}</span></h3><div class="studio-cards">${list.map((product) => productCardHTML(product, editAction)).join("")}</div></section>`,
      )
      .join("");
  }
  function productsHTML() {
    const items = visible(apparel());
    if (!activeBases().length && !items.length)
      return `${listHead(l("Diseños", "Designs"), "product", l("Nuevo diseño", "New design"), apparel())}<div class="studio-empty"><h3>${l("Primero, las camisetas", "Shirts first")}</h3><p>${l("Para publicar un diseño necesitas al menos un tipo de camiseta con sus colores.", "You need at least one shirt type with colors to publish a design.")}</p><a class="admin-button admin-button-primary" href="#admin/shirts/new">+ ${l("Nuevo tipo de camiseta", "New shirt type")}</a></div>`;
    return `${listHead(l("Diseños", "Designs"), "product", l("Nuevo diseño", "New design"), apparel())}${items.length ? groupedProducts(items, "edit-product") : emptyHTML(l("Sin diseños todavía", "No designs yet"), l("Sube el PNG de un diseño, elige frente o espalda, tipos de camiseta, colores y precios.", "Upload a design PNG, choose front or back, shirt types, colors and prices."), "product", l("Nuevo diseño", "New design"))}`;
  }
  function articlesHTML() {
    const items = visible(articles());
    return `${listHead(l("Artículos", "Articles"), "article", l("Nuevo artículo", "New article"), articles())}${items.length ? groupedProducts(items, "edit-article") : emptyHTML(l("Sin artículos todavía", "No articles yet"), l("Botellas, llaveros, tazas… cada uno con sus fotos, variantes, precio y colección opcional.", "Bottles, keychains, mugs… each with photos, variants, price and an optional collection."), "article", l("Nuevo artículo", "New article"))}`;
  }
  function launchHTML() {
    const bases = activeBases();
    const colors = bases.reduce((sum, base) => sum + base.colors.length, 0);
    const collections = activeCollections();
    const designs = apparel().filter((p) => p.active);
    const items = articles().filter((p) => p.active);
    const steps = [
      {
        done: bases.length > 0 && colors > 0,
        title: l("Camisetas y colores", "Shirts and colors"),
        text: l("Crea cada tipo de camiseta y sube un PNG por color. El hex de cada color define el fondo dinámico de las fotos.", "Create each shirt type and upload one PNG per color. Each color hex drives the dynamic photo backdrop."),
        stat: `${bases.length} ${l("tipos", "types")} · ${colors} ${l("colores", "colors")}`,
        href: "#admin/shirts/new",
        cta: l("Agregar tipo de camiseta", "Add shirt type"),
        list: "#admin/shirts",
      },
      {
        done: collections.length > 0,
        title: l("Colección", "Collection"),
        text: l("Nombre, descripción y un cover PNG que decora la página de la colección.", "Name, description and a cover PNG that decorates the collection page."),
        stat: `${collections.length} ${collections.length === 1 ? l("colección", "collection") : l("colecciones", "collections")}`,
        href: "#admin/collections/new",
        cta: l("Crear colección", "Create collection"),
        list: "#admin/collections",
      },
      {
        done: designs.length > 0,
        title: l("Diseños", "Designs"),
        text: l("Sube el PNG del diseño (frente, espalda o ambos), elige tipos de camiseta, colores y precios.", "Upload the design PNG (front, back or both), choose shirt types, colors and prices."),
        stat: `${designs.length} ${designs.length === 1 ? l("publicado", "published") : l("publicados", "published")}`,
        href: collections[0] ? `#admin/products/new:${collections[0].id}` : "#admin/products/new",
        cta: l("Agregar diseño", "Add design"),
        list: "#admin/products",
        blocked: !bases.length ? l("Necesitas camisetas primero.", "Add shirts first.") : "",
      },
      {
        done: items.length > 0,
        optional: true,
        title: l("Artículos", "Articles"),
        text: l("Botellas, llaveros y más, con fotos por variante. Pueden ir dentro de una colección.", "Bottles, keychains and more, with photos per variant. They can belong to a collection."),
        stat: `${items.length} ${items.length === 1 ? l("publicado", "published") : l("publicados", "published")}`,
        href: "#admin/articles/new",
        cta: l("Agregar artículo", "Add article"),
        list: "#admin/articles",
      },
      {
        done: Boolean(state.payments?.enabled),
        optional: true,
        title: l("Pagos en línea", "Online payments"),
        text: l("Conecta la cuenta de Tilopay para cobrar con tarjeta y SINPE Móvil. Mientras tanto, los pedidos se guardan sin cobro.", "Connect the Tilopay account to charge cards and SINPE Móvil. Until then, orders are saved without charging."),
        stat: state.payments?.enabled ? l("Tilopay activo", "Tilopay on") : l("Sin activar", "Not enabled"),
        href: "#admin/payments",
        cta: l("Configurar Tilopay", "Set up Tilopay"),
        list: "#admin/payments",
      },
      {
        done: (state.landing?.slides || []).length > 0,
        optional: true,
        title: l("Videos del landing", "Landing videos"),
        text: l("Los videos de la portada, con título, texto y botón hacia una colección. Cada colección también puede tener sus propios videos.", "Home page videos with title, text and a button to a collection. Each collection can also have its own videos."),
        stat: `${(state.landing?.slides || []).length} ${l("videos", "videos")}`,
        href: "#admin/landing",
        cta: l("Agregar videos", "Add videos"),
        list: "#admin/landing",
      },
    ];
    const required = steps.filter((s) => !s.optional);
    const completed = required.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done && !s.blocked);
    const live = designs.length + items.length;
    return `<section class="studio-launch"><div class="studio-launch-hero"><div><span class="admin-eyebrow">${l("LANZAMIENTO", "LAUNCH")}</span><h2>${live ? l("Tu tienda está publicada", "Your store is live") : l("Lanza tu tienda en 3 pasos", "Launch your store in 3 steps")}</h2><p>${live ? l("{count} productos visibles. Sigue sumando colecciones, diseños y artículos con los mismos asistentes.", "{count} products visible. Keep adding collections, designs and articles with the same wizards.", { count: live }) : l("La tienda está vacía. Cuando publiques el primer diseño aparecerá automáticamente.", "The store is empty. Your first published design appears automatically.")}</p></div><div class="studio-progress" style="--progress:${(completed / required.length) * 100}%"><strong>${completed}/${required.length}</strong><span>${l("pasos", "steps")}</span></div></div><ol class="studio-launch-steps">${steps
      .map(
        (step, index) =>
          `<li class="${step.done ? "is-done" : ""} ${step === next ? "is-next" : ""}"><span class="studio-launch-number">${step.done ? "✓" : index + 1}</span><div class="studio-launch-copy"><h3>${esc(step.title)}${step.optional ? ` <small>${l("opcional", "optional")}</small>` : ""}</h3><p>${esc(step.text)}</p><span class="studio-launch-stat">${esc(step.stat)}</span></div><div class="studio-launch-actions">${step.blocked ? `<span class="studio-blocked">${esc(step.blocked)}</span>` : `<a class="admin-button ${step === next ? "admin-button-primary" : "admin-button-light"}" href="${step.href}">+ ${esc(step.cta)}</a>`}<a class="admin-text-button" href="${step.list}">${l("Ver todo", "View all")}</a></div></li>`,
      )
      .join("")}</ol><aside class="studio-tips"><h3>${l("Antes de subir PNG", "Before uploading PNGs")}</h3><ul><li>${l("Camisetas: una foto por color, lisa, fondo transparente y el mismo encuadre cuadrado en todas.", "Shirts: one photo per color, blank, transparent background, same square framing.")}</li><li>${l("Diseños: PNG con fondo transparente; se colocan dentro del área de impresión de cada tipo.", "Designs: transparent PNG; placed inside each type's print area.")}</li><li>${l("Máximo 5 MB y 16 MP; si el archivo es más grande el asistente lo reduce automáticamente.", "Max 5 MB and 16 MP; larger files are scaled down automatically.")}</li><li>${l("Puedes arrastrar varios PNG a la vez; los que digan “espalda” o “back” se asignan como espalda.", "Drop several PNGs at once; files named “back” or “espalda” become back photos.")}</li></ul></aside></section>`;
  }
  function html() {
    const body = state.wizard
      ? wizardHTML()
      : !state.loaded
        ? state.error
          ? `${alertHTML(state.error)}<button type="button" class="admin-button admin-button-light" data-studio="reload">${l("Reintentar", "Try again")}</button>`
          : `<div class="admin-empty" role="status"><span class="admin-spinner"></span><h2>${l("Cargando catálogo…", "Loading catalog…")}</h2></div>`
        : `${alertHTML(state.error)}${{ launch: launchHTML, shirts: shirtsHTML, collections: collectionsHTML, products: productsHTML, articles: articlesHTML, landing: () => "", payments: () => "" }[section]()}`;
    return `<div class="studio studio-section-${section}">${body}</div>`;
  }
  function heading() {
    return (
      {
        launch: [l("Lanzamiento", "Launch"), l("Configura la tienda paso a paso: camisetas, colecciones, diseños y artículos.", "Set up the store step by step: shirts, collections, designs and articles.")],
        shirts: [l("Camisetas", "Shirts"), l("Tipos de camiseta, tallas, gramajes y un PNG por color.", "Shirt types, sizes, weights and one PNG per color.")],
        collections: [l("Colecciones", "Collections"), l("Agrupa tus diseños y artículos con un cover propio.", "Group designs and articles under their own cover.")],
        products: [l("Diseños", "Designs"), l("Cada diseño con sus caras, tipos de camiseta, colores y precios.", "Each design with its sides, shirt types, colors and prices.")],
        articles: [l("Artículos", "Articles"), l("Botellas, llaveros y otros productos con variantes.", "Bottles, keychains and other products with variants.")],
        landing: [l("Landing", "Landing"), l("Videos y mensajes de la portada.", "Home page videos and messages.")],
        payments: [l("Pagos", "Payments"), l("Conecta la cuenta de Tilopay para cobrar con tarjeta y SINPE Móvil.", "Connect the Tilopay account to charge cards and SINPE Móvil.")],
      }[section] || ["", ""]
    );
  }

  /* ---------- Events ---------- */
  const inStudio = (target) => target?.closest?.(".studio");
  function setDraftField(target) {
    const wizard = state.wizard;
    const name = target.dataset.field;
    if (name === "showArchived") {
      state.showArchived = target.checked;
      changed();
      return true;
    }
    if (!wizard) return false;
    const draft = wizard.draft;
    const value = target.type === "checkbox" ? target.checked : target.value;
    wizard.dirty = true;
    if (name.startsWith("pay.")) {
      draft[name.slice(4)] = value;
      wizard.testResult = "";
      const save = document.querySelector('.studio-pay-actions [data-studio="save"]');
      if (save) save.disabled = false;
      if (target.type === "checkbox") changed();
      return true;
    }
    if (name.startsWith("slide.")) {
      const item = draft.slides.find((entry) => entry.key === target.dataset.key);
      if (!item) return true;
      item[name.slice(6)] = value;
      const copy = target.closest(".studio-slide")?.querySelector(".studio-slide-copy");
      if (copy)
        copy.innerHTML = `${item.title ? `<strong>${esc(item.title)}</strong>` : ""}${item.subtitle ? `<span>${esc(item.subtitle)}</span>` : ""}${item.buttonLabel ? `<em>${esc(item.buttonLabel)}</em>` : ""}`;
      const status = document.querySelector(".studio-landing-foot .studio-foot-status");
      if (status) status.textContent = l("Cambios sin publicar", "Unpublished changes");
      const save = document.querySelector('.studio-landing-foot [data-studio="save"]');
      if (save && !pendingUploads()) save.disabled = false;
      return true;
    }
    if (name.startsWith("color.") || name.startsWith("variant.")) {
      const [scope, key] = name.split(".");
      const item = (scope === "color" ? draft.colors : draft.variants).find((entry) => entry.key === target.dataset.key);
      if (!item) return true;
      if (key === "name") item.name = value;
      if (key === "hex" || key === "hexText") {
        item.hexManual = true;
        const hex = String(value).trim();
        if (HEX.test(hex)) {
          item.hex = hex.toLowerCase();
          syncHex(target, item.hex, item.key);
        } else if (key === "hexText") item.hex = hex;
      }
      return true;
    }
    if (name === "collection.hex" || name === "collection.hexText") {
      draft.accentManual = true;
      const hex = String(value).trim();
      draft.accent = HEX.test(hex) ? hex.toLowerCase() : hex;
      if (HEX.test(hex)) syncHex(target, draft.accent, "accent");
      return true;
    }
    if (name.startsWith("area.")) {
      const key = name.slice(5);
      const area = draft.printArea;
      area[key] = Math.round(Number(value) * 10) / 10;
      if (area.x + area.w > 100) area[key === "x" ? "w" : "x"] = Math.max(0, Math.round((100 - (key === "x" ? area.x : area.w)) * 10) / 10);
      if (area.y + area.h > 100) area[key === "y" ? "h" : "y"] = Math.max(0, Math.round((100 - (key === "y" ? area.y : area.h)) * 10) / 10);
      const art = document.querySelector("[data-area-art] .shirt-art");
      if (art) art.setAttribute("style", printAreaStyle(area));
      for (const part of ["x", "y", "w", "h"]) {
        const output = document.querySelector(`[data-area-output="${part}"]`);
        if (output) output.textContent = `${area[part]}%`;
        const input = document.getElementById(`st-area-${part}`);
        if (input && input !== target) input.value = area[part];
      }
      return true;
    }
    if (name === "base.enabled" || name === "base.price") {
      const choice = draft.selected[target.dataset.base];
      if (!choice) return true;
      if (name === "base.enabled") {
        choice.enabled = value;
        const base = activeBases().find((b) => b.id === target.dataset.base);
        if (value && !choice.shirts.length && base)
          choice.shirts = base.colors.filter((c) => draft.printSides === "front" || c.backImageUrl).map((c) => c.shirt);
        if (value && !choice.price) {
          const other = Object.values(draft.selected).find((entry) => entry !== choice && entry.price);
          if (other) choice.price = other.price;
        }
        changed();
      } else choice.price = value;
      return true;
    }
    if (name in draft) {
      draft[name] = value;
      if (target.type === "checkbox") changed();
      return true;
    }
    return true;
  }
  function syncHex(source, hex, key) {
    const root = source.closest(".studio-hex");
    root?.querySelectorAll("input").forEach((input) => {
      if (input !== source) input.value = hex;
    });
    const row = source.closest(".studio-color-row, .studio-cover");
    row?.querySelectorAll(".studio-drop, [data-hex-preview]").forEach((element) => {
      const style = stageStyle(hex);
      element.setAttribute("style", style);
    });
    if (key === "accent") document.querySelectorAll('[data-drop="cover"]').forEach((el) => el.setAttribute("style", stageStyle(hex)));
  }
  function onInput(event) {
    const target = event.target;
    if (!inStudio(target) || !target.dataset?.field) return false;
    return setDraftField(target);
  }
  function onChangeEvent(event) {
    const target = event.target;
    if (!inStudio(target)) return false;
    if (target.matches("input[type=file][data-upload]")) {
      const files = [...(target.files || [])];
      const name = target.dataset.upload;
      target.value = "";
      if (!files.length) return true;
      if (name === "color-batch") addColorFiles(files, "color");
      else if (name === "variant-batch") addColorFiles(files, "variant");
      else if (name.startsWith("video-batch:")) addVideoFiles(files, name.split(":")[1]);
      else upload(name, files[0]);
      return true;
    }
    if (target.dataset.field) {
      setDraftField(target);
      // Text fields update their previews in place; re-rendering on blur would swallow the next click.
      if (target.tagName === "SELECT" || target.type === "color") changed();
      return true;
    }
    return false;
  }
  function onClick(event) {
    const link = event.target.closest('a[href^="#"]');
    if (link && inStudio(link) && link.target !== "_blank" && state.wizard?.dirty && !state.wizard.done) {
      if (!window.confirm(l("Tienes cambios sin guardar en este asistente. ¿Salir de todos modos?", "You have unsaved changes in this wizard. Leave anyway?"))) {
        event.preventDefault();
        return true;
      }
      state.wizard.dirty = false;
      return false;
    }
    const button = event.target.closest("[data-studio]");
    if (!button || !inStudio(button)) return false;
    if (button.tagName === "BUTTON" && button.disabled) return true;
    const wizard = state.wizard;
    const draft = wizard?.draft;
    const action = button.dataset.studio;
    switch (action) {
      case "reload":
        load();
        break;
      case "new": {
        const type = button.dataset.type;
        const sectionFor = { shirt: "shirts", collection: "collections", product: "products", article: "articles" }[type];
        if (sectionFor !== section) {
          location.hash = `#admin/${sectionFor}/new${button.dataset.collection ? `:${button.dataset.collection}` : ""}`;
          break;
        }
        openWizard(type, { collectionId: button.dataset.collection || "" });
        break;
      }
      case "edit-shirt":
        openEdit("shirts", button.dataset.id);
        break;
      case "edit-collection":
        openEdit("collections", button.dataset.id);
        break;
      case "edit-product":
        openEdit("products", button.dataset.id);
        break;
      case "edit-article":
        openEdit("articles", button.dataset.id);
        break;
      case "ask-archive":
        state.confirm = { kind: button.dataset.kind, id: button.dataset.id };
        changed();
        break;
      case "cancel-confirm":
        state.confirm = null;
        changed();
        break;
      case "archive":
        archive(button.dataset.kind, button.dataset.id);
        break;
      case "restore":
        archive(button.dataset.kind, button.dataset.id, true);
        break;
      case "close":
        if (wizard?.busy) break;
        if (wizard?.dirty && !wizard.done && !window.confirm(l("¿Descartar los cambios de este asistente?", "Discard this wizard's changes?"))) break;
        closeWizard();
        break;
      case "next":
        goToStep(wizard.step + 1);
        break;
      case "back":
        goToStep(wizard.step - 1);
        break;
      case "goto":
        goToStep(Number(button.dataset.step));
        break;
      case "save":
        save();
        break;
      case "toggle-size": {
        const size = button.dataset.size;
        draft.sizes = draft.sizes.includes(size) ? draft.sizes.filter((s) => s !== size) : [...draft.sizes, size];
        wizard.dirty = true;
        changed();
        break;
      }
      case "add-size": {
        const size = String(draft.customSize || "").trim();
        if (size && size.length <= 24 && !draft.sizes.includes(size)) draft.sizes = [...draft.sizes, size];
        draft.customSize = "";
        wizard.dirty = true;
        changed();
        break;
      }
      case "add-color":
        draft.colors.push({ key: uid(), name: "", hex: "#888888", hexManual: false, detected: "", imageUrl: "", backImageUrl: "" });
        wizard.dirty = true;
        changed();
        break;
      case "remove-color":
      case "remove-variant": {
        const list = action === "remove-color" ? draft.colors : draft.variants;
        const index = list.findIndex((item) => item.key === button.dataset.key);
        if (index >= 0) list.splice(index, 1);
        for (const key of [...wizard.jobs.keys()]) if (key.includes(button.dataset.key)) wizard.jobs.delete(key);
        wizard.dirty = true;
        changed();
        break;
      }
      case "use-detected": {
        if (button.dataset.scope === "collection") {
          draft.accent = draft.detected;
          draft.accentManual = true;
        } else {
          const list = button.dataset.scope === "color" ? draft.colors : draft.variants;
          const item = list.find((entry) => entry.key === button.dataset.key);
          if (item) {
            item.hex = item.detected;
            item.hexManual = true;
          }
        }
        wizard.dirty = true;
        changed();
        break;
      }
      case "reset-area":
        draft.printArea = { ...DEFAULT_PRINT_AREA };
        wizard.dirty = true;
        changed();
        break;
      case "preview-side":
        draft.previewSide = button.dataset.side;
        changed();
        break;
      case "pick-collection":
        draft.collectionId = button.dataset.id;
        wizard.dirty = true;
        changed();
        break;
      case "print-sides":
        draft.printSides = button.dataset.side;
        draft.previewSide = draft.printSides === "back" ? "back" : "front";
        if (draft.printSides !== "front")
          for (const base of activeBases()) {
            const choice = draft.selected[base.id];
            if (choice) choice.shirts = choice.shirts.filter((shirt) => base.colors.find((c) => c.shirt === shirt)?.backImageUrl);
          }
        wizard.dirty = true;
        changed();
        break;
      case "toggle-color": {
        const choice = draft.selected[button.dataset.base];
        const shirt = Number(button.dataset.shirt);
        choice.shirts = choice.shirts.includes(shirt) ? choice.shirts.filter((s) => s !== shirt) : [...choice.shirts, shirt];
        wizard.dirty = true;
        changed();
        break;
      }
      case "all-colors": {
        const base = activeBases().find((b) => b.id === button.dataset.base);
        const choice = draft.selected[button.dataset.base];
        const eligible = base.colors.filter((c) => draft.printSides === "front" || c.backImageUrl).map((c) => c.shirt);
        choice.shirts = choice.shirts.length === eligible.length ? [] : eligible;
        wizard.dirty = true;
        changed();
        break;
      }
      case "main-shirt":
        draft.shirt = Number(button.dataset.shirt);
        wizard.dirty = true;
        changed();
        break;
      case "main-variant": {
        const id = button.dataset.id;
        draft.defaultShirt = /^\d+$/.test(id) ? Number(id) : id;
        wizard.dirty = true;
        changed();
        break;
      }
      case "test-payments":
        testPayments(wizard);
        break;
      case "slide-up":
      case "slide-down":
      case "slide-remove":
      case "video-up":
      case "video-down":
      case "video-remove": {
        const list = action.startsWith("slide") ? draft.slides : draft.videos;
        const index = list.findIndex((item) => item.key === button.dataset.key);
        if (index < 0) break;
        if (action.endsWith("remove")) {
          list.splice(index, 1);
          for (const key of [...wizard.jobs.keys()]) if (key.endsWith(button.dataset.key)) wizard.jobs.delete(key);
        } else {
          const next = index + (action.endsWith("up") ? -1 : 1);
          if (next >= 0 && next < list.length) [list[index], list[next]] = [list[next], list[index]];
        }
        wizard.dirty = true;
        changed();
        break;
      }
      default:
        return false;
    }
    return true;
  }
  const onDragOver = (event) => {
    if (!state.wizard || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    const zone = event.target.closest?.("[data-drop]");
    document.querySelectorAll(".studio-drop.is-over").forEach((el) => el !== zone && el.classList.remove("is-over"));
    zone?.classList.add("is-over");
  };
  const onDrop = (event) => {
    if (!state.wizard || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const zone = event.target.closest?.("[data-drop]");
    document.querySelectorAll(".studio-drop.is-over").forEach((el) => el.classList.remove("is-over"));
    if (!zone || !inStudio(zone)) return;
    const name = zone.dataset.drop;
    const wantsVideo = name.startsWith("video");
    const files = [...event.dataTransfer.files].filter((file) =>
      wantsVideo ? isVideoFile(file) : file.type === "image/png" || /\.png$/i.test(file.name),
    );
    if (!files.length) {
      announce(apiErrorMessage({ code: wantsVideo ? "VIDEO_REQUIRED" : "PNG_REQUIRED" }));
      return;
    }
    if (name.startsWith("video-batch:")) addVideoFiles(files, name.split(":")[1]);
    else if (name === "color-batch") addColorFiles(files, "color");
    else if (name === "variant-batch") addColorFiles(files, "variant");
    else upload(name, files[0]);
  };
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);

  return {
    html,
    heading,
    load,
    reset() {
      loadSequence++;
      state.loaded = false;
      state.wizard = null;
      state.bases = [];
      state.collections = [];
      state.products = [];
    },
    cleanup() {
      alive = false;
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.clear();
    },
    hasUnsaved: () => Boolean(state.wizard?.dirty && !state.wizard.done),
    onClick,
    onInput,
    onChange: onChangeEvent,
    onSubmit: () => false,
  };
}
