/**
 * Footer Registry Section Interactivity (Web Component)
 */

if (!customElements.get('footer-section')) {
  class FooterSection extends HTMLElement {
    constructor() {
      super();
      this.newsletterForm = this.querySelector('.footer-newsletter__form');
    }

    connectedCallback() {
      this.initNewsletter();
    }

    initNewsletter() {
      if (!this.newsletterForm) return;
      this.newsletterForm.addEventListener('submit', (e) => {
        const input = this.newsletterForm.querySelector('input[type="email"]');
        const submitBtn = this.newsletterForm.querySelector('.footer-newsletter__submit-btn');
        if (input && input.value) {
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span>Subscribed!</span> <i data-lucide="check"></i>`;
            if (typeof lucide !== 'undefined') lucide.createIcons();
          }
        }
      });
    }
  }

  customElements.define('footer-section', FooterSection);
}
