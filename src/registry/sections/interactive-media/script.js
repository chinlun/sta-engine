document.addEventListener('DOMContentLoaded', () => {
  const sliders = document.querySelectorAll('.before-after-slider');
  sliders.forEach(slider => {
    const range = slider.querySelector('.before-after-slider__range-input');
    const afterImg = slider.querySelector('.before-after-slider__image-after');
    const handle = slider.querySelector('.before-after-slider__handle');

    if (range && afterImg && handle) {
      range.addEventListener('input', (e) => {
        const val = e.target.value;
        afterImg.style.width = `${val}%`;
        handle.style.left = `${val}%`;
      });
    }
  });
});
