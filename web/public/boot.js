// Paint the right background before the bundle loads, so a new window never flashes.
(function () {
  var mode = 'system';
  try {
    mode = localStorage.getItem('sumi.appearance') || 'system';
  } catch (e) {}
  var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.appearance = dark ? 'dark' : 'light';
})();
