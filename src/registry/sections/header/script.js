class ShopifyHeader extends HTMLElement {
  constructor() {
    super();
    this.header = this;
    this.isSticky = this.dataset.sticky === 'true';
    this.bgMode = this.dataset.backgroundMode;
    this.lastScroll = 0;
    this.scrollThreshold = 100;

    this.init();
  }

  init() {
    window.addEventListener('scroll', this.onScroll.bind(this), { passive: true });
    this.initDrawers();
    this.initSearch();
    this.initMegaMenu();
  }

  onScroll() {
    const currentScroll = window.pageYOffset;
    
    // Background Mode Handling
    if (this.bgMode !== 'solid') {
      if (currentScroll > this.scrollThreshold) {
        this.header.classList.add('is-scrolled');
      } else {
        this.header.classList.remove('is-scrolled');
      }
    }

    // Sticky behavior: hide on scroll down, show on scroll up
    if (this.isSticky && currentScroll > 400) {
      if (currentScroll > this.lastScroll) {
        this.header.classList.add('is-hidden');
      } else {
        this.header.classList.remove('is-hidden');
      }
    } else {
      this.header.classList.remove('is-hidden');
    }

    this.lastScroll = currentScroll;
  }

  initDrawers() {
    this.querySelectorAll('.js-drawer-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = btn.getAttribute('data-target');
        this.openDrawer(targetId);
      });
    });

    this.querySelectorAll('.js-drawer-close, .js-header-overlay').forEach(btn => {
      btn.addEventListener('click', () => this.closeAllDrawers());
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAllDrawers();
    });
  }

  openDrawer(id) {
    const drawer = document.getElementById(id);
    const overlay = this.querySelector('.js-header-overlay');
    if (!drawer) return;

    drawer.classList.add('is-active');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.classList.add('is-active');
    document.body.classList.add('overflow-hidden');
  }

  closeAllDrawers() {
    this.querySelectorAll('.header-panel, .js-header-overlay').forEach(el => {
      el.classList.remove('is-active');
      if (el.classList.contains('header-panel')) el.setAttribute('aria-hidden', 'true');
    });
    document.body.classList.remove('overflow-hidden');
  }

  initSearch() {
    const searchForm = this.querySelector('.js-header-search-form');
    const searchInput = this.querySelector('.js-header-search-input');
    const resultsContainer = this.querySelector('.js-header-search-results');

    if (!searchForm || !resultsContainer) return;

    if (searchForm.dataset.resultsMode === 'dropdown') {
      searchInput.addEventListener('input', this.debounce((e) => {
        const query = e.target.value.trim();
        if (query.length > 2) {
          this.fetchSearchResults(query, resultsContainer);
        } else {
          resultsContainer.hidden = true;
        }
      }, 300));
    }
  }

  async fetchSearchResults(query, container) {
    try {
      const response = await fetch(`/search/suggest.json?q=${query}&resources[type]=product,collection&resources[limit]=5`);
      const data = await response.json();
      this.renderSearchResults(data, container);
    } catch (e) {
      console.error('Search fetch failed', e);
    }
  }

  renderSearchResults(data, container) {
    const results = data.resources.results;
    const products = results.products || [];
    
    if (products.length === 0) {
      container.hidden = true;
      return;
    }

    let html = '<ul class="search-dropdown-list">';
    products.forEach(product => {
      html += `<li><a href="${product.url}">${product.title}</a></li>`;
    });
    html += '</ul>';

    container.querySelector('.header-search-results__inner').innerHTML = html;
    container.hidden = false;
  }

  initMegaMenu() {
    // Handle click reveal for Level 2 if set to click
    this.querySelectorAll('.header-mega-menu__level1[data-reveal="click"]').forEach(item => {
      const link = item.querySelector('.header-mega-menu__level1-link');
      link.addEventListener('click', (e) => {
        if (item.querySelector('.header-mega-menu__level2')) {
          e.preventDefault();
          item.classList.toggle('is-revealed');
        }
      });
    });
  }

  debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }
}

customElements.define('shopify-header', ShopifyHeader);
