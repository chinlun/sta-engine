/**
 * Hero Registry Section Interactivity (Web Component)
 */
if (!customElements.get('hero-section')) {
  customElements.define('hero-section', class HeroSection extends HTMLElement {
    connectedCallback() {
      this.initVideo();
      this.initParallax();
    }

    initVideo() {
      const video = this.querySelector('.hero-media__video');
      if (video) {
        video.play().catch(() => {
          // Fallback if browser blocks autoplay without user gesture
          console.warn('[HeroSection] Autoplay muted video was restricted by browser.');
        });
      }
    }

    initParallax() {
      const isParallaxEnabled = this.dataset.parallax === 'true';
      if (!isParallaxEnabled) return;

      const mediaImg = this.querySelector('.hero-media__image');
      if (!mediaImg) return;

      window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const rate = scrolled * 0.3;
        if (scrolled < window.innerHeight) {
          mediaImg.style.transform = `translate3d(0px, ${rate}px, 0px)`;
        }
      }, { passive: true });
    }
  });
}
