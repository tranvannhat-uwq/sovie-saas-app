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
    }, { threshold: 0.15 });

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
    this.header = root.querySelector('[data-motion-header], .ref-header');
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

class MockupTiltController {
  constructor(root, reducedMotion) {
    this.root = root;
    this.reducedMotion = reducedMotion;
    this.wrapper = root.querySelector('.ref-mockup-wrapper');
    this.mockup = root.querySelector('.ref-mockup-card');

    this.maxTilt = 7;
    this.maxTranslateY = -6;
    this.maxScale = 1.012;
    this.lerpFactor = 0.1;

    this.targetRotateX = 0;
    this.targetRotateY = 0;
    this.targetTranslateY = 0;
    this.targetScale = 1;

    this.currentRotateX = 0;
    this.currentRotateY = 0;
    this.currentTranslateY = 0;
    this.currentScale = 1;

    this.rafId = null;
    this.isHovering = false;

    this.handleEnter = null;
    this.handleMove = null;
    this.handleLeave = null;
    this.tick = this.tick.bind(this);
  }

  init() {
    if (!this.wrapper || !this.mockup) return;
    if (window.innerWidth <= 768) return;

    this.handleEnter = () => {
      this.isHovering = true;
      this.mockup.classList.add('is-tilting');
      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    };

    this.handleMove = (e) => {
      if (e.pointerType === 'touch') return;

      const rect = this.wrapper.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const normX = Math.max(-1, Math.min(1, (x / rect.width) * 2 - 1));
      const normY = Math.max(-1, Math.min(1, (y / rect.height) * 2 - 1));

      this.targetRotateX = -normY * this.maxTilt;
      this.targetRotateY = normX * this.maxTilt;
      this.targetTranslateY = this.maxTranslateY;
      this.targetScale = this.maxScale;

      if (!this.isHovering) {
        this.isHovering = true;
        this.mockup.classList.add('is-tilting');
      }

      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    };

    this.handleLeave = () => {
      this.isHovering = false;
      this.mockup.classList.remove('is-tilting');

      this.targetRotateX = 0;
      this.targetRotateY = 0;
      this.targetTranslateY = 0;
      this.targetScale = 1;

      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    };

    this.wrapper.addEventListener('mouseenter', this.handleEnter);
    this.wrapper.addEventListener('mousemove', this.handleMove);
    this.wrapper.addEventListener('mouseleave', this.handleLeave);
  }

  tick() {
    this.currentRotateX += (this.targetRotateX - this.currentRotateX) * this.lerpFactor;
    this.currentRotateY += (this.targetRotateY - this.currentRotateY) * this.lerpFactor;
    this.currentTranslateY += (this.targetTranslateY - this.currentTranslateY) * this.lerpFactor;
    this.currentScale += (this.targetScale - this.currentScale) * this.lerpFactor;

    this.mockup.style.transform = `perspective(1200px) rotateX(${this.currentRotateX.toFixed(2)}deg) rotateY(${this.currentRotateY.toFixed(2)}deg) translateY(${this.currentTranslateY.toFixed(2)}px) scale3d(${this.currentScale.toFixed(4)}, ${this.currentScale.toFixed(4)}, 1)`;

    if (!this.isHovering) {
      const remainingDelta = Math.abs(this.targetRotateX - this.currentRotateX)
        + Math.abs(this.targetRotateY - this.currentRotateY)
        + Math.abs(this.targetTranslateY - this.currentTranslateY)
        + Math.abs(this.targetScale - this.currentScale);

      if (remainingDelta < 0.005) {
        this.currentRotateX = 0;
        this.currentRotateY = 0;
        this.currentTranslateY = 0;
        this.currentScale = 1;
        this.mockup.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg) translateY(0px) scale3d(1, 1, 1)';
        this.rafId = null;
        return;
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  }

  destroy() {
    if (this.wrapper) {
      if (this.handleEnter) this.wrapper.removeEventListener('mouseenter', this.handleEnter);
      if (this.handleMove) this.wrapper.removeEventListener('mousemove', this.handleMove);
      if (this.handleLeave) this.wrapper.removeEventListener('mouseleave', this.handleLeave);
    }
    if (this.mockup) {
      this.mockup.classList.remove('is-tilting');
      this.mockup.style.transform = '';
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.isHovering = false;
  }
}

class ProgressController {
  constructor(root, reducedMotion) {
    this.root = root;
    this.reducedMotion = reducedMotion;
    this.observer = null;
  }

  init() {
    const bars = [...this.root.querySelectorAll('.ref-progress-fill')];
    if (!bars.length) return;
    if (this.reducedMotion || !('IntersectionObserver' in window)) return;

    this.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-animated');
        this.observer?.unobserve(entry.target);
      });
    }, { threshold: 0.3 });

    bars.forEach(bar => this.observer.observe(bar));
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
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
  const tiltController = new MockupTiltController(root, reducedMotion);
  const progressController = new ProgressController(root, reducedMotion);

  root.classList.add('motion-ready');
  if (reducedMotion) root.classList.add('motion-reduced');
  revealController.init();
  countController.init();
  headerController.init();
  tiltController.init();
  progressController.init();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.add('motion-enter'));
  });

  return () => {
    revealController.destroy();
    countController.destroy();
    headerController.destroy();
    tiltController.destroy();
    progressController.destroy();
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


