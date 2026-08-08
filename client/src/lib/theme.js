const THEME_KEY = 'michel-theme';

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

export function applyTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
