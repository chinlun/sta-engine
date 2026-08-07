/**
 * Product Grid Registry Section Interactivity (Web Component)
 */

if (!customElements.get('product-grid-section')) {
  class ProductGridSection extends HTMLElement {
    constructor() {
      super();
      this.quickViewModal = this.querySelector('[id^="QuickView-Modal"]');
      this.loadMoreBtn = this.querySelector('[data-load-more-btn]');
    }

    connectedCallback() {
      this.initQuickView();
      this.initTabs();
      this.initLoadMore();
    }

    initQuickView() {
      const quickViewBtns = this.querySelectorAll('[data-quick-view-btn]');
      quickViewBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const handle = btn.getAttribute('data-product-handle');
          this.openQuickView(handle);
        });
      });

      if (this.quickViewModal) {
        const closeBtn = this.quickViewModal.querySelector('[data-quick-view-close]');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => this.quickViewModal.close());
        }
        this.quickViewModal.addEventListener('click', (e) => {
          if (e.target === this.quickViewModal) this.quickViewModal.close();
        });
      }
    }

    openQuickView(handle) {
      if (!this.quickViewModal) return;
      this.quickViewModal.showModal();
      const content = this.quickViewModal.querySelector('[data-quick-view-content]');
      if (content) {
        content.innerHTML = `
          <div style="display: flex; gap: 24px; align-items: center;">
            <div style="width: 50%; aspect-ratio: 4/5; background: #f4f4f4; border-radius: 4px; overflow: hidden;">
              <img src="unsplash://luxury-product-lifestyle" style="width: 100%; height: 100%; object-fit: cover;">
            </div>
            <div style="width: 50%;">
              <span style="font-size: 0.75rem; text-transform: uppercase; color: #888;">Signature Series</span>
              <h2 style="margin: 8px 0 16px 0; font-size: 1.5rem;">Quick View - ${handle || 'Product Details'}</h2>
              <p style="font-size: 1.25rem; font-weight: 600; margin-bottom: 16px;">$148.00</p>
              <p style="color: #666; font-size: 0.9375rem; line-height: 1.6; margin-bottom: 24px;">
                Crafted with intention using premium sustainable materials. Features precision engineering and refined finishes.
              </p>
              <button type="button" style="width: 100%; padding: 14px; background: #000; color: #fff; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;">
                Add to Cart
              </button>
            </div>
          </div>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    }

    initTabs() {
      const tabBtns = this.querySelectorAll('.product-grid__tab-btn');
      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          tabBtns.forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
        });
      });
    }

    initLoadMore() {
      if (!this.loadMoreBtn) return;
      this.loadMoreBtn.addEventListener('click', () => {
        this.loadMoreBtn.textContent = 'Loading...';
        setTimeout(() => {
          this.loadMoreBtn.textContent = 'All Products Loaded';
          this.loadMoreBtn.disabled = true;
          this.loadMoreBtn.style.opacity = '0.6';
        }, 800);
      });
    }
  }

  customElements.define('product-grid-section', ProductGridSection);
}
