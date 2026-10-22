import {l} from './i18n.js?v=40';
const SORT_KEYS = new Set(['featured', 'price-asc', 'price-desc', 'name']);
let storefrontUI;

/** Header, navigation, sorting, and the home-page campaign carousel. */
export function initStorefrontUI({ onSort } = {}) {
  if (storefrontUI) return storefrontUI;
  const globalController = new AbortController();
  const globalOptions = { signal: globalController.signal };
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || { matches: false };
  let home = null;
  let restoringNavFocus = false;

  const refreshHeader = () => {
    document.querySelector('.site-header')?.classList.toggle('scrolled', !document.body.classList.contains('home-page') || window.scrollY > 40);
  };
  const dropdowns = () => [...document.querySelectorAll('.nav-dropdown')];
  const closeDropdowns = (dismiss = true) => {
    for (const dropdown of dropdowns()) {
      dropdown.classList.remove('is-open');
      dropdown.classList.toggle('is-dismissed', dismiss);
      dropdown.querySelector('[data-nav-toggle]')?.setAttribute('aria-expanded', 'false');
    }
  };
  const closeSort = (restoreFocus = false) => {
    const toggle = document.getElementById('sort-toggle');
    const menu = document.getElementById('sort-menu');
    toggle?.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
    if (restoreFocus) toggle?.focus();
  };
  const openSort = () => {
    const toggle = document.getElementById('sort-toggle');
    const menu = document.getElementById('sort-menu');
    if (!toggle || !menu) return;
    closeDropdowns();
    toggle.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
  };
  const playVideo = (video) => {
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    try { video.play()?.catch(() => {}); } catch { /* Browser autoplay settings may require a user interaction. */ }
  };
  const syncVideos = () => {
    if (!home) return;
    const canPlay = !home.paused && !motionQuery.matches && !document.hidden;
    home.slides.forEach((slide, index) => {
      for (const video of slide.querySelectorAll('video')) {
        const active = index === home.index && canPlay;
        video.autoplay = active;
        if (active) playVideo(video);
        else video.pause();
      }
    });
  };
  const syncPauseControl = () => {
    if (!home) return;
    const paused = home.paused || motionQuery.matches;
    const label = motionQuery.matches ? l('Carrusel pausado por movimiento reducido','Slideshow paused for reduced motion') : paused ? l('Reanudar carrusel','Resume slideshow') : l('Pausar carrusel','Pause slideshow');
    for (const button of home.carousel.querySelectorAll('[data-hero-pause]')) {
      button.setAttribute('aria-pressed', String(paused));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.disabled = motionQuery.matches;
      button.classList.toggle('is-paused', paused);
    }
  };
  const mayAdvance = () => home && !home.paused && !motionQuery.matches && !document.hidden && !home.hovered && !home.carousel.contains(document.activeElement);
  const selectSlide = (nextIndex) => {
    if (!home?.slides.length) return;
    home.index = (nextIndex + home.slides.length) % home.slides.length;
    home.slides.forEach((slide, index) => {
      const active = index === home.index;
      slide.classList.toggle('is-active', active);
      slide.hidden = !active;
      slide.setAttribute('aria-hidden', String(!active));
      slide.style.display = active ? home.originals[index].display : 'none';
    });
    for (const button of home.carousel.querySelectorAll('[data-hero-index]')) {
      const active = Number(button.dataset.heroIndex) === home.index;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    home.carousel.dataset.activeCampaign = String(home.index);
    syncVideos();
  };
  const resetTimer = () => {
    if (!home) return;
    window.clearInterval(home.timer);
    home.timer = window.setInterval(() => {
      if (mayAdvance()) selectSlide(home.index + 1);
    }, 9000);
  };
  const destroyHome = () => {
    if (!home) return;
    const previous = home;
    home = null;
    window.clearInterval(previous.timer);
    previous.controller.abort();
    previous.removeMotionListener?.();
    previous.slides.forEach((slide, index) => {
      for (const video of slide.querySelectorAll('video')) {
        video.autoplay = false;
        video.pause();
      }
      const original = previous.originals[index];
      slide.style.display = original.display;
      slide.hidden = original.hidden;
      slide.classList.toggle('is-active', original.active);
      if (original.ariaHidden === null) slide.removeAttribute('aria-hidden');
      else slide.setAttribute('aria-hidden', original.ariaHidden);
    });
  };
  const mountHome = () => {
    destroyHome();
    refreshHeader();
    const carousel = document.querySelector('.hero-carousel');
    if (!carousel) return;
    const slides = [...carousel.querySelectorAll('.campaign-slide')];
    if (!slides.length) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    home = {
      carousel, slides, controller, index: 0, paused: false, hovered: carousel.matches(':hover'), timer: null,
      originals: slides.map((slide) => ({ display: slide.style.display, hidden: slide.hidden, active: slide.classList.contains('is-active'), ariaHidden: slide.getAttribute('aria-hidden') })),
    };
    carousel.addEventListener('click', (event) => {
      if (!home || !(event.target instanceof Element)) return;
      const pause = event.target.closest('[data-hero-pause]');
      if (pause) {
        if (motionQuery.matches) return;
        home.paused = !home.paused;
        syncPauseControl();
        syncVideos();
        resetTimer();
        return;
      }
      const previous = event.target.closest('[data-hero-prev]');
      const next = event.target.closest('[data-hero-next]');
      const indexButton = event.target.closest('[data-hero-index]');
      if (!previous && !next && !indexButton) return;
      const index = indexButton ? Number(indexButton.dataset.heroIndex) : home.index + (next ? 1 : -1);
      if (!Number.isInteger(index) || (indexButton && (index < 0 || index >= home.slides.length))) return;
      selectSlide(index);
      resetTimer();
    }, options);
    carousel.addEventListener('mouseenter', () => { if (home) home.hovered = true; }, options);
    carousel.addEventListener('mouseleave', () => { if (home) { home.hovered = false; resetTimer(); } }, options);
    carousel.addEventListener('focusin', resetTimer, options);
    carousel.addEventListener('focusout', resetTimer, options);
    document.addEventListener('visibilitychange', () => { syncVideos(); resetTimer(); }, options);
    const onMotionChange = () => { syncPauseControl(); syncVideos(); resetTimer(); };
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange, options);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
      home.removeMotionListener = () => motionQuery.removeListener(onMotionChange);
    }
    selectSlide(0);
    syncPauseControl();
    resetTimer();
  };

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const navToggle = event.target.closest('[data-nav-toggle]');
    if (navToggle) {
      const dropdown = navToggle.closest('.nav-dropdown');
      if (!dropdown) return;
      const expanded = navToggle.getAttribute('aria-expanded') === 'true';
      closeSort();
      closeDropdowns();
      if (!expanded) {
        dropdown.classList.remove('is-dismissed');
        dropdown.classList.add('is-open');
        navToggle.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    const sortToggle = event.target.closest('#sort-toggle');
    if (sortToggle) {
      if (sortToggle.getAttribute('aria-expanded') === 'true') closeSort();
      else openSort();
      return;
    }
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton && document.getElementById('sort-menu')?.contains(sortButton)) {
      const key = sortButton.dataset.sort;
      if (!SORT_KEYS.has(key)) return;
      closeSort();
      try { if (typeof onSort === 'function') onSort(key); }
      finally { document.getElementById('sort-toggle')?.focus(); }
      return;
    }
    if (!event.target.closest('.nav-dropdown') || event.target.closest('.nav-dropdown-panel a')) closeDropdowns();
    if (!event.target.closest('#sort-menu')) closeSort();
  }, globalOptions);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const sortWasOpen = document.getElementById('sort-toggle')?.getAttribute('aria-expanded') === 'true';
      const openDropdown = dropdowns().find((dropdown) => dropdown.classList.contains('is-open'));
      closeSort(sortWasOpen);
      closeDropdowns();
      if (!sortWasOpen && openDropdown) {
        restoringNavFocus = true;
        openDropdown.querySelector('[data-nav-toggle]')?.focus();
        restoringNavFocus = false;
      }
      return;
    }
    if (event.key === 'ArrowDown' && event.target?.id === 'sort-toggle') {
      event.preventDefault();
      openSort();
      document.querySelector('#sort-menu [data-sort]')?.focus();
      return;
    }
    if (!(event.target instanceof Element) || !event.target.closest('#sort-menu')) return;
    const buttons = [...document.querySelectorAll('#sort-menu [data-sort]')];
    const index = buttons.indexOf(document.activeElement);
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }, globalOptions);
  document.addEventListener('pointerover', (event) => {
    if (!(event.target instanceof Element)) return;
    const dropdown = event.target.closest('.nav-dropdown');
    if (dropdown && !(event.relatedTarget instanceof Node && dropdown.contains(event.relatedTarget))) dropdown.classList.remove('is-dismissed');
  }, globalOptions);
  document.addEventListener('focusin', (event) => {
    if (!restoringNavFocus && event.target instanceof Element) event.target.closest('.nav-dropdown')?.classList.remove('is-dismissed');
  }, globalOptions);
  window.addEventListener('scroll', refreshHeader, { passive: true, signal: globalController.signal });
  closeDropdowns(false);
  closeSort();
  refreshHeader();
  storefrontUI = { mountHome, destroyHome, refreshHeader };
  return storefrontUI;
}
