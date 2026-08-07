/**
 * Automatic BEM CSS Selector Normalizer for Registry Assemblers
 * Ensures LLM delta_css output automatically matches registry Liquid template class names.
 */

function normalizeFooterCss(css = '') {
    if (!css || typeof css !== 'string') return '';
    return css
        .replace(/\.footer__heading|\.footer-heading|\.footer__title/g, '.footer-column__title, .footer-newsletter__title, .footer-pre-cta__title, .footer__heading')
        .replace(/\.footer__link|\.footer-link/g, '.footer-nav-list a, .footer__link')
        .replace(/\.footer__social-icon|\.social-icon/g, '.footer-social-link, .footer__social-icon')
        .replace(/\.footer__newsletter-input|\.newsletter-input/g, '.footer-newsletter__input, .footer__newsletter-input')
        .replace(/\.footer__newsletter-button|\.footer__newsletter-btn|\.newsletter-btn/g, '.footer-newsletter__submit-btn, .footer-pre-cta__btn, .footer__newsletter-button')
        .replace(/\.footer__pre-footer|\.pre-footer-band/g, '.footer-pre-cta, .footer__pre-footer')
        .replace(/\.footer__bottom|\.footer-bottom/g, '.footer-bottom-bar, .footer__bottom');
}

function normalizeHeroCss(css = '') {
    if (!css || typeof css !== 'string') return '';
    return css
        .replace(/\.hero__title|\.hero-heading|\.hero-title/g, '.hero-content__heading, .hero-title, .hero__title')
        .replace(/\.hero__subtitle|\.hero-subheading|\.hero-subtext|\.hero-subtitle/g, '.hero-content__subheading, .hero-subtitle, .hero-subheading, .hero__subtitle')
        .replace(/\.hero__button|\.hero-btn|\.hero__btn|\.hero-button/g, '.hero-button, .hero-btn, .hero-cta, .hero__button')
        .replace(/\.hero__image|\.hero-img|\.hero-image/g, '.hero-media__image, .hero-image, .hero__image');
}

function normalizeProductGridCss(css = '') {
    if (!css || typeof css !== 'string') return '';
    return css
        .replace(/\.product-title|\.card-title/g, '.product-card__title, .product-title')
        .replace(/\.product-price|\.card-price/g, '.product-card__price-wrapper, .product-card__price')
        .replace(/\.product-card-image|\.card-image/g, '.product-card__image, .product-card-image')
        .replace(/\.quick-view-btn|\.quick-add-btn/g, '.product-card__action-btn, .quick-view-btn');
}

function normalizeHeaderCss(css = '') {
    if (!css || typeof css !== 'string') return '';
    return css
        .replace(/\.site-logo|\.header-logo|\.header__logo/g, '.header-logo, .site-logo, .header__logo')
        .replace(/\.nav-link|\.menu-item-link|\.header-nav-link/g, '.header-nav__link, .nav-link, .header__menu-link')
        .replace(/\.announcement-text/g, '.header-status-bar__text, .announcement-bar__text, .announcement-text');
}

module.exports = {
    normalizeFooterCss,
    normalizeHeroCss,
    normalizeProductGridCss,
    normalizeHeaderCss
};
