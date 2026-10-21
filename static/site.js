(() => {
  const root = document.documentElement;
  const themeButton = document.getElementById('theme-btn');
  const modes = ['auto', 'light', 'dark'];
  const applyTheme = (mode) => {
    if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    themeButton.textContent = mode;
  };
  let mode = 'auto';
  try { mode = localStorage.getItem('hs-theme') || 'auto'; } catch (e) {}
  if (!modes.includes(mode)) mode = 'auto';
  applyTheme(mode);
  themeButton.addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    applyTheme(mode);
    try { localStorage.setItem('hs-theme', mode); } catch (e) {}
  });
})();
