// Presentation only: read the existing app theme without changing preferences.
(() => {
  const root = document.documentElement;
  const tokens = ['bg','text','text-secondary','rail-bg','rail-border','hero-card-bg',
    'card-secondary-fill','tab-bg','tab-text','tab-active-bg','tab-active-text','tab-hover-bg']
    .map(name => '--theme-' + name);
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  let parentDocument = null;
  try { if (parent !== window && parent.location.origin === location.origin) parentDocument = parent.document; } catch {}
  const sync = () => {
    let values, light;
    if (parentDocument) {
      const style = parent.getComputedStyle(parentDocument.documentElement);
      values = Object.fromEntries(tokens.map(key => [key, style.getPropertyValue(key).trim()]));
      light = parentDocument.body?.classList.contains('theme-light');
    } else {
      const app = read('nowplaying.clientSettings.v1')?.app || {};
      values = app.themeTokens && Object.keys(app.themeTokens).length ? app.themeTokens : read('nowplaying.themeTokens.v1') || {};
      let mode = app.themeMode;
      try { mode ||= localStorage.getItem('np-theme'); } catch {}
      light = mode === 'light';
    }
    for (const key of tokens) {
      const value = values?.[key];
      if (typeof value === 'string' && value.trim()) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
    root.style.colorScheme = light ? 'light' : 'dark';
    root.classList.toggle('theme-light', Boolean(light));
    document.body?.classList.toggle('theme-light', Boolean(light));
  };
  sync();
  const observer = parentDocument ? new MutationObserver(sync) : null;
  if (observer) {
    observer.observe(parentDocument.documentElement, {attributes:true, attributeFilter:['style','class']});
    if (parentDocument.body) observer.observe(parentDocument.body, {attributes:true, attributeFilter:['class']});
  }
  addEventListener('storage', sync);
  addEventListener('message', event => {
    if (parentDocument && event.source === parent && event.origin === location.origin && event.data?.type === 'np-theme-sync') sync();
  });
  addEventListener('pagehide', () => observer?.disconnect(), {once:true});
})();
