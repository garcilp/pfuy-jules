/**
 * Platfighters.uy Theme Management and Selector
 * Follows Theme Guide v1.0
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'pfuy-theme';

  const THEMES = [
    {
      id: 'default',
      name: 'Platfighters',
      tag: 'Default',
      bg: '#050B1F',
      dots: ['#050B1F', '#9FD6FF', '#F5C542']
    },
    {
      id: 'daylight',
      name: 'Daylight',
      tag: 'Light',
      bg: '#EAF2FF',
      dots: ['#EAF2FF', '#0038A8', '#8A6508']
    },
    {
      id: 'high-contrast',
      name: 'High contrast',
      tag: 'Contrast',
      bg: '#000000',
      dots: ['#000000', '#BFE6FF', '#FFD84D']
    },
    {
      id: 'oled-black',
      name: 'OLED black',
      tag: 'OLED',
      bg: '#000000',
      dots: ['#000000', '#9FD6FF', '#F5C542']
    },
    {
      id: 'dusk',
      name: 'Dusk',
      tag: 'Violet',
      bg: '#1B0F3D',
      dots: ['#1B0F3D', '#FF8FD0', '#F5C542']
    },
    {
      id: 'yerba',
      name: 'Yerba',
      tag: 'Green',
      bg: '#06201A',
      dots: ['#06201A', '#8CF0C8', '#F5C542']
    }
  ];

  function getSystemDefaultTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches) {
      return 'high-contrast';
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'daylight';
    }
    return 'default';
  }

  function getActiveThemeId() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && THEMES.some(t => t.id === stored)) {
        return stored;
      }
    } catch (e) {
      // localStorage may fail in private mode
    }
    return getSystemDefaultTheme();
  }

  function syncThemeColorMeta(themeId) {
    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', theme.bg);
  }

  let transitionTimer = null;
  function applyTheme(themeId, persist = true) {
    if (document.body) {
      document.body.classList.add('theme-transitioning');
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(() => {
        document.body.classList.remove('theme-transitioning');
      }, 200);
    }
    document.documentElement.dataset.theme = themeId;
    syncThemeColorMeta(themeId);
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, themeId);
      } catch (e) {}
    }
    updateWidgetState(themeId);
  }

  function updateWidgetState(activeId) {
    const options = document.querySelectorAll('.theme-option');
    options.forEach(opt => {
      const isSelected = opt.dataset.themeId === activeId;
      opt.classList.toggle('selected', isSelected);
      opt.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      opt.setAttribute('tabindex', isSelected ? '0' : '-1');
    });
  }

  function initThemeSelectorWidget() {
    if (document.getElementById('theme-selector-widget')) {
      return;
    }

    const currentThemeId = getActiveThemeId();
    syncThemeColorMeta(currentThemeId);

    const container = document.createElement('aside');
    container.id = 'theme-selector-widget';
    container.className = 'theme-selector-container';
    container.setAttribute('aria-label', (window.i18n && window.i18n.t) ? window.i18n.t('theme.selector') : 'Theme Selector');

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'theme-toggle-btn glass pill';
    toggleBtn.setAttribute('aria-haspopup', 'true');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', (window.i18n && window.i18n.t) ? window.i18n.t('theme.selector') : 'Theme selector');
    toggleBtn.innerHTML = `
      <span class="theme-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 3a9 9 0 0 1 9 9 9 9 0 0 1-9 9V3z"/>
        </svg>
      </span>
      <span class="theme-label-text">${(window.i18n && window.i18n.t) ? window.i18n.t('theme.button') : 'Theme'}</span>
    `;

    const dropdown = document.createElement('div');
    dropdown.className = 'theme-dropdown glass';
    dropdown.setAttribute('role', 'radiogroup');
    dropdown.setAttribute('aria-label', (window.i18n && window.i18n.t) ? window.i18n.t('theme.choose') : 'Choose color theme');

    THEMES.forEach((theme) => {
      const isSelected = theme.id === currentThemeId;
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = `theme-option ${isSelected ? 'selected' : ''}`;
      opt.setAttribute('role', 'radio');
      opt.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      opt.setAttribute('tabindex', isSelected ? '0' : '-1');
      opt.dataset.themeId = theme.id;

      const dotsHtml = theme.dots.map(color => `<span class="theme-dot" style="background:${color}" aria-hidden="true"></span>`).join('');

      opt.innerHTML = `
        <span class="theme-dots" aria-hidden="true">${dotsHtml}</span>
        <span class="theme-name">${theme.name}</span>
        <span class="theme-tag">${theme.tag}</span>
        <span class="theme-check" aria-hidden="true">✓</span>
      `;

      opt.addEventListener('click', () => {
        applyTheme(theme.id, true);
        closeDropdown();
        toggleBtn.focus();
      });

      opt.addEventListener('keydown', (e) => {
        const optionList = Array.from(dropdown.querySelectorAll('.theme-option'));
        const index = optionList.indexOf(opt);
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          const nextIndex = (index + 1) % optionList.length;
          optionList[nextIndex].focus();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevIndex = (index - 1 + optionList.length) % optionList.length;
          optionList[prevIndex].focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeDropdown();
          toggleBtn.focus();
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          opt.click();
        }
      });

      dropdown.appendChild(opt);
    });

    function openDropdown() {
      dropdown.classList.add('open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      const selected = dropdown.querySelector('.theme-option.selected') || dropdown.querySelector('.theme-option');
      if (selected) {
        selected.focus();
      }
    }

    function closeDropdown() {
      dropdown.classList.remove('open');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('open');
      if (isOpen) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    toggleBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        if (!dropdown.classList.contains('open')) {
          e.preventDefault();
          openDropdown();
        }
      } else if (e.key === 'Escape') {
        closeDropdown();
      }
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        closeDropdown();
      }
    });

    container.appendChild(dropdown);
    container.appendChild(toggleBtn);
    document.body.appendChild(container);
  }

  // Listen to system preference changes if user hasn't explicitly chosen a theme
  if (window.matchMedia) {
    const contrastQuery = window.matchMedia('(prefers-contrast: more)');
    const schemeQuery = window.matchMedia('(prefers-color-scheme: light)');

    const handleSysChange = () => {
      try {
        if (!localStorage.getItem(STORAGE_KEY)) {
          applyTheme(getSystemDefaultTheme(), false);
        }
      } catch (e) {}
    };

    if (contrastQuery.addEventListener) {
      contrastQuery.addEventListener('change', handleSysChange);
      schemeQuery.addEventListener('change', handleSysChange);
    } else if (contrastQuery.addListener) {
      contrastQuery.addListener(handleSysChange);
      schemeQuery.addListener(handleSysChange);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeSelectorWidget);
  } else {
    initThemeSelectorWidget();
  }

  if (window.i18n && window.i18n.onChange) {
    window.i18n.onChange(() => {
      const w = document.getElementById('theme-selector-widget');
      if (w) {
        w.remove();
        initThemeSelectorWidget();
      }
    });
  }

  // Expose helper API globally
  window.pfuyTheme = {
    themes: THEMES,
    apply: applyTheme,
    get: getActiveThemeId
  };
})();
