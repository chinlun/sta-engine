document.addEventListener('DOMContentLoaded', () => {
  const thumbnailBtns = document.querySelectorAll('.featured-product__thumbnail-btn');
  thumbnailBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetSrc = btn.getAttribute('data-target-image');
      const section = btn.closest('.featured-product-section');
      if (section && targetSrc) {
        const mainImage = section.querySelector('.featured-product__main-image');
        if (mainImage) mainImage.src = targetSrc;
        section.querySelectorAll('.featured-product__thumbnail-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
      }
    });
  });

  const optionBtns = document.querySelectorAll('.featured-product__pill-btn');
  optionBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.closest('.featured-product__option-values');
      if (parent) {
        parent.querySelectorAll('.featured-product__pill-btn').forEach(b => b.classList.remove('is-selected'));
        btn.classList.add('is-selected');
      }
    });
  });
});
