const POPUP_I18N = {
  en: {
    title: 'Vidroop Downloader',
    subtitle: 'Settings',
    languageLabel: 'Language',
    saved: 'Language updated.',
  },
  'es-419': {
    title: 'Vidroop Downloader',
    subtitle: 'Configuración',
    languageLabel: 'Idioma',
    saved: 'Idioma actualizado.',
  },
};

/**
 * Resolves supported language keys.
 *
 * @param {string | undefined} value Requested language value.
 * @returns {'en' | 'es-419'}
 */
function normalizeLanguage(value) {
  if (!value) return 'en';

  const normalized = value.toLowerCase();
  if (
    normalized === 'es-419' ||
    normalized === 'es_ar' ||
    normalized === 'es-ar' ||
    normalized.startsWith('es')
  ) {
    return 'es-419';
  }

  return 'en';
}

/**
 * Applies localized UI labels.
 *
 * @param {'en' | 'es-419'} language Active language.
 */
function renderLabels(language) {
  const dictionary = POPUP_I18N[language] ?? POPUP_I18N.en;

  document.getElementById('title').textContent = dictionary.title;
  document.getElementById('subtitle').textContent = dictionary.subtitle;
  document.getElementById('languageLabel').textContent = dictionary.languageLabel;
}

/**
 * Initializes popup settings UI.
 */
async function initPopup() {
  const languageSelect = document.getElementById('languageSelect');
  const status = document.getElementById('status');

  const { language } = await chrome.storage.sync.get(['language']);
  const activeLanguage = normalizeLanguage(language || navigator.language);

  languageSelect.value = activeLanguage;
  renderLabels(activeLanguage);

  languageSelect.addEventListener('change', async () => {
    const selectedLanguage = normalizeLanguage(languageSelect.value);

    await chrome.storage.sync.set({ language: selectedLanguage });
    renderLabels(selectedLanguage);

    status.textContent =
      (POPUP_I18N[selectedLanguage] ?? POPUP_I18N.en).saved;
  });
}

initPopup();
