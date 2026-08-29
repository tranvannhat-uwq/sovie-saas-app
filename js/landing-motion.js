const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const REVEAL_SELECTOR = '[data-reveal]';
const COUNT_SELECTOR = '[data-count]';
const REVEAL_THRESHOLD = 0.18;
const EASE_OUT_QUART = t => 1 - ((1 - t) ** 4);

class RevealController {
  constructor(root, reducedMotion) {
    this.root = root;
    this.reducedMotion = reducedMotion;
    this.observer = null;
  }

  init() {
    const elements = [...this.root.querySelectorAll(REVEAL_SELECTOR)];
    elements.forEach(element => {
      const delay = Number(element.dataset.revealDelay || 0);
      element.style.setProperty('--reveal-delay', `${Math.max(0, delay)}ms`);
    });

    if (this.reducedMotion || !('IntersectionObserver' in window)) {
      elements.forEach(element => element.classList.add('is-visible'));
      return;
    }

    this.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        this.observer?.unobserve(entry.target);
      });
    }, {
      threshold: REVEAL_THRESHOLD,
      rootMargin: '0px 0px -8% 0px'
    });

    elements.forEach(element => this.observer.observe(element));
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
  }
}

class CountUpController {
  constructor(root, reducedMotion) {
    this.root = root;
    this.reducedMotion = reducedMotion;
    this.observer = null;
    this.frames = new Set();
  }

  render(element, value) {
    const target = Number(element.dataset.count || 0);
    const decimals = Number(element.dataset.countDecimals || (Number.isInteger(target) ? 0 : 1));
    const pad = Number(element.dataset.countPad || 0);
    const suffix = element.dataset.countSuffix || '';
    const prefix = element.dataset.countPrefix || '';
    let output = Number(value).toLocaleString('vi-VN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    if (pad > 0 && decimals === 0) output = output.padStart(pad, '0');
    element.textContent = `${prefix}${output}${suffix}`;
  }

  animate(element) {
    if (element.dataset.counted === 'true') return;
    element.dataset.counted = 'true';
    const target = Number(element.dataset.count || 0);
    const duration = Math.max(800, Number(element.dataset.countDuration || 1050));

    if (this.reducedMotion || !Number.isFinite(target)) {
      this.render(element, target);
      return;
    }

    const startedAt = performance.now();
    const tick = now => {
      const progress = Math.min(1, (now - startedAt) / duration);
      this.render(element, target * EASE_OUT_QUART(progress));
      if (progress < 1) {
        const frame = requestAnimationFrame(tick);
        this.frames.add(frame);
      }
    };
    const frame = requestAnimationFrame(tick);
    this.frames.add(frame);
  }

  init() {
    const elements = [...this.root.querySelectorAll(COUNT_SELECTOR)];
    if (this.reducedMotion || !('IntersectionObserver' in window)) {
      elements.forEach(element => this.animate(element));
      return;
    }

    this.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        this.animate(entry.target);
        this.observer?.unobserve(entry.target);
      });
    }, { threshold: 0.5 });

    elements.forEach(element => this.observer.observe(element));
  }

  destroy() {
    this.observer?.disconnect();
    this.frames.forEach(frame => cancelAnimationFrame(frame));
    this.frames.clear();
  }
}

class HeaderController {
  constructor(root) {
    this.root = root;
    this.header = root.querySelector('[data-motion-header]');
    this.sentinel = null;
    this.observer = null;
  }

  init() {
    if (!this.header || !('IntersectionObserver' in window)) return;
    this.sentinel = document.createElement('div');
    this.sentinel.className = 'landing-scroll-sentinel';
    this.sentinel.setAttribute('aria-hidden', 'true');
    this.header.before(this.sentinel);
    this.observer = new IntersectionObserver(([entry]) => {
      this.header?.classList.toggle('is-scrolled', !entry.isIntersecting);
    }, { threshold: 0 });
    this.observer.observe(this.sentinel);
  }

  destroy() {
    this.observer?.disconnect();
    this.sentinel?.remove();
    this.observer = null;
    this.sentinel = null;
  }
}

function initLandingMotion() {
  const root = document.getElementById('landing-page');
  if (!root) return () => {};

  const motionPreference = window.matchMedia(MOTION_QUERY);
  const reducedMotion = motionPreference.matches;
  const revealController = new RevealController(root, reducedMotion);
  const countController = new CountUpController(root, reducedMotion);
  const headerController = new HeaderController(root);

  root.classList.add('motion-ready');
  if (reducedMotion) root.classList.add('motion-reduced');
  revealController.init();
  countController.init();
  headerController.init();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.add('motion-enter'));
  });

  return () => {
    revealController.destroy();
    countController.destroy();
    headerController.destroy();
  };
}

let cleanupLandingMotion = () => {};

function startLandingMotion() {
  cleanupLandingMotion();
  cleanupLandingMotion = initLandingMotion();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startLandingMotion, { once: true });
} else {
  startLandingMotion();
}

window.addEventListener('pagehide', () => cleanupLandingMotion(), { once: true });


