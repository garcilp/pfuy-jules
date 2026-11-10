/**
 * Platfighters.uy Mobile Navigation & Chrome
 * Provides mobile Top Bar actions (Search & Menu), Bottom Bar navigation,
 * accessible full-sheet Menu (Browse, Hubs, Themes, Languages), and mobile search drawer.
 */

(function () {
  'use strict';

  function initMobileChrome() {
    // Only initialize once
    if (document.getElementById('mobile-bottom-nav')) return;

    // Detect current path / page
    const pathname = window.location.pathname.toLowerCase();
    const isHome = pathname.endsWith('index.html') || pathname === '/' || pathname === '';
    const isPlayers = pathname.includes('players.html');
    const isEvents = pathname.includes('events.html');
    const isRankings = pathname.includes('rankings.html') || pathname.includes('ranking.html');

    // 1. Setup Top Bar Actions (Search + Menu)
    setupTopBar(isHome);

    // 2. Setup Bottom Floating Bar
    setupBottomBar(isHome, isPlayers, isEvents, isRankings);

    // 3. Setup Sheet Menu Modal
    setupMenuSheet();

    // 4. Setup Mobile Search Drawer (for non-home pages)
    if (!isHome) {
      setupSearchDrawer();
    }
  }

  function t(key, fallback) {
    if (window.i18n && window.i18n.t) {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    return fallback;
  }

  function setupTopBar(isHome) {
    const topbar = document.querySelector('.topbar') || document.querySelector('header.topbar');
    if (!topbar) return;

    // Ensure container for mobile buttons
    let mobileActions = topbar.querySelector('.mobile-top-actions');
    if (!mobileActions) {
      mobileActions = document.createElement('div');
      mobileActions.className = 'mobile-top-actions';

      // Search button
      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className = 'mobile-action-btn mobile-search-btn';
      searchBtn.setAttribute('aria-label', t('menu.search', 'Search'));
      searchBtn.setAttribute('data-i18n-aria', 'menu.search');
      searchBtn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      `;

      searchBtn.addEventListener('click', () => {
        if (isHome) {
          const heroSearch = document.getElementById('search') || document.querySelector('.home-search-pill input') || document.querySelector('.hero-search input') || document.getElementById('global-search');
          if (heroSearch) {
            heroSearch.scrollIntoView({ behavior: 'smooth', block: 'center' });
            heroSearch.focus();
          }
        } else {
          toggleSearchDrawer();
        }
      });

      // Menu button
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.id = 'mobile-menu-btn';
      menuBtn.className = 'mobile-action-btn mobile-menu-btn';
      menuBtn.setAttribute('aria-label', t('menu.openMenu', 'Open navigation menu'));
      menuBtn.setAttribute('data-i18n-aria', 'menu.openMenu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-controls', 'mobile-menu-sheet');
      menuBtn.innerHTML = `
        <svg class="icon-menu" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      `;

      menuBtn.addEventListener('click', () => {
        toggleMenuSheet();
      });

      mobileActions.appendChild(searchBtn);
      mobileActions.appendChild(menuBtn);
      topbar.appendChild(mobileActions);
    }
  }

  function setupBottomBar(isHome, isPlayers, isEvents, isRankings) {
    const bottomBar = document.createElement('nav');
    bottomBar.id = 'mobile-bottom-nav';
    bottomBar.className = 'mobile-bottom-bar';
    bottomBar.setAttribute('aria-label', t('menu.primaryNav', 'Mobile primary navigation'));
    bottomBar.setAttribute('data-i18n-aria', 'menu.primaryNav');

    const items = [
      { name: 'Home', i18nKey: 'nav.home', url: 'index.html', active: isHome },
      { name: 'Players', i18nKey: 'nav.players', url: 'players.html', active: isPlayers },
      { name: 'Events', i18nKey: 'nav.events', url: 'events.html', active: isEvents },
      { name: 'Rankings', i18nKey: 'nav.rankings', url: 'rankings.html', active: isRankings },
    ];

    items.forEach(item => {
      const a = document.createElement('a');
      a.href = item.url;
      a.textContent = t(item.i18nKey, item.name);
      a.setAttribute('data-i18n', item.i18nKey);
      if (item.active) {
        a.className = 'active';
        a.setAttribute('aria-current', 'page');
      }
      bottomBar.appendChild(a);
    });

    document.body.appendChild(bottomBar);
  }

  function setupMenuSheet() {
    let sheet = document.getElementById('mobile-menu-sheet');
    if (sheet) return;

    sheet = document.createElement('div');
    sheet.id = 'mobile-menu-sheet';
    sheet.className = 'mobile-menu-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', t('menu.navigationMenu', 'Navigation menu'));
    sheet.setAttribute('data-i18n-aria', 'menu.navigationMenu');

    // Hub metadata (default player counts or dynamic)
    const hubs = [
      { name: 'Smash Ultimate', count: '130+ players', url: 'events.html?game=ultimate' },
      { name: 'Melee', count: '45+ players', url: 'events.html?game=melee' },
      { name: 'Rivals 2', count: '30+ players', url: 'events.html?game=rivals-2' },
      { name: 'Project+', count: '25+ players', url: 'events.html?game=project-plus' },
    ];

    // Theme metadata from authoritative source
    const themes = (window.pfuyTheme && window.pfuyTheme.themes) ? window.pfuyTheme.themes : [
      { id: 'default', name: 'Platfighters', tag: 'Default', dots: ['#050B1F', '#9FD6FF', '#F5C542'] },
      { id: 'daylight', name: 'Daylight', tag: 'Light', dots: ['#EAF2FF', '#0038A8', '#8A6508'] },
      { id: 'high-contrast', name: 'High contrast', tag: 'Contrast', dots: ['#000000', '#BFE6FF', '#FFD84D'] },
      { id: 'oled-black', name: 'OLED black', tag: 'OLED', dots: ['#000000', '#9FD6FF', '#F5C542'] },
      { id: 'dusk', name: 'Dusk', tag: 'Violet', dots: ['#1B0F3D', '#FF8FD0', '#F5C542'] },
      { id: 'yerba', name: 'Yerba', tag: 'Green', dots: ['#06201A', '#8CF0C8', '#F5C542'] }
    ];

    const currentTheme = (window.pfuyTheme && window.pfuyTheme.get) ? window.pfuyTheme.get() : (localStorage.getItem('pfuy-theme') || 'default');
    const currentLang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : (localStorage.getItem('platfighters_lang') || 'en');

    let html = `
      <div class="mobile-menu-header">
        <a href="index.html" class="mobile-menu-brand">
          <img src="assets/logo.jpg" alt="Logo" class="brand-logo" style="width:34px;height:34px;border-radius:10px;object-fit:cover;">
          <span>Platfighters<span class="tld">.uy</span></span>
        </a>
        <button type="button" class="mobile-menu-close-btn" id="mobile-menu-close-btn" aria-label="${t('menu.closeMenu', 'Close navigation menu')}" data-i18n-aria="menu.closeMenu">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="mobile-menu-section">
        <div class="mobile-menu-title" data-i18n="menu.browse">${t('menu.browse', 'Browse')}</div>
        <a href="index.html" class="mobile-menu-row"><span data-i18n="nav.home">${t('nav.home', 'Home')}</span></a>
        <a href="players.html" class="mobile-menu-row"><span data-i18n="nav.players">${t('nav.players', 'Players')}</span></a>
        <a href="events.html" class="mobile-menu-row"><span data-i18n="nav.events">${t('nav.events', 'Events')}</span></a>
        <a href="rankings.html" class="mobile-menu-row"><span data-i18n="nav.rankings">${t('nav.rankings', 'Rankings')}</span></a>
      </div>

      <div class="mobile-menu-section">
        <div class="mobile-menu-title" data-i18n="menu.communityHubs">${t('menu.communityHubs', 'Community Hubs')}</div>
        ${hubs.map(h => `
          <a href="${h.url}" class="mobile-menu-row">
            <span>${h.name}</span>
            <span class="mobile-tag-pill">${h.count}</span>
          </a>
        `).join('')}
      </div>

      <div class="mobile-menu-section">
        <div class="mobile-menu-title" data-i18n="menu.theme">${t('menu.theme', 'Theme')}</div>
        ${themes.map(tItem => {
          const isSelected = (currentTheme === tItem.id);
          return `
            <div class="mobile-menu-row theme-choice-row" data-theme-id="${tItem.id}" tabindex="0" role="button">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="mobile-theme-dots">
                  <span class="mobile-theme-dot" style="background:${tItem.dots[0]}"></span>
                  <span class="mobile-theme-dot" style="background:${tItem.dots[1]}"></span>
                  <span class="mobile-theme-dot" style="background:${tItem.dots[2]}"></span>
                </span>
                <span>${tItem.name}</span>
              </div>
              <div class="row-right">
                <span class="mobile-tag-pill">${tItem.tag}</span>
                ${isSelected ? `<span class="mobile-selected-pill" data-i18n="menu.selected">${t('menu.selected', 'SELECTED')}</span>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="mobile-menu-section" style="margin-bottom: 12px;">
        <div class="mobile-menu-title" data-i18n="menu.language">${t('menu.language', 'Language')}</div>
        <div class="mobile-lang-control">
          <button type="button" class="mobile-lang-btn ${currentLang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
          <button type="button" class="mobile-lang-btn ${currentLang === 'es' ? 'active' : ''}" data-lang="es">ES</button>
        </div>
      </div>
    `;

    sheet.innerHTML = html;
    document.body.appendChild(sheet);

    // Event listeners inside menu
    const closeBtn = document.getElementById('mobile-menu-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        toggleMenuSheet(false);
      });
    }

    sheet.querySelectorAll('.theme-choice-row').forEach(row => {
      row.addEventListener('click', () => {
        const themeId = row.dataset.themeId;
        applyTheme(themeId);
        // Refresh selected pill
        sheet.querySelectorAll('.theme-choice-row').forEach(r => {
          const right = r.querySelector('.row-right');
          const pill = right.querySelector('.mobile-selected-pill');
          if (pill) pill.remove();
          if (r.dataset.themeId === themeId) {
            const newPill = document.createElement('span');
            newPill.className = 'mobile-selected-pill';
            newPill.setAttribute('data-i18n', 'menu.selected');
            newPill.textContent = t('menu.selected', 'SELECTED');
            right.appendChild(newPill);
          }
        });
      });

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });
    });

    sheet.querySelectorAll('.mobile-lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (window.i18n && window.i18n.setLang) {
          window.i18n.setLang(lang);
        } else if (window.i18n && window.i18n.setLanguage) {
          window.i18n.setLanguage(lang);
        } else {
          localStorage.setItem('platfighters_lang', lang);
        }
        sheet.querySelectorAll('.mobile-lang-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Keyboard navigation & Escape key handling
    document.addEventListener('keydown', handleDocumentKeyDown);
  }

  function handleDocumentKeyDown(e) {
    const sheet = document.getElementById('mobile-menu-sheet');
    if (e.key === 'Escape' && sheet && sheet.classList.contains('open')) {
      toggleMenuSheet(false);
    }
  }

  function toggleMenuSheet(force) {
    const sheet = document.getElementById('mobile-menu-sheet');
    const menuBtn = document.getElementById('mobile-menu-btn');
    if (!sheet || !menuBtn) return;

    const isOpen = (typeof force === 'boolean') ? !force : sheet.classList.contains('open');

    if (!isOpen) {
      // OPEN
      sheet.classList.add('open');
      menuBtn.setAttribute('aria-expanded', 'true');
      menuBtn.setAttribute('aria-label', t('menu.closeMenu', 'Close navigation menu'));
      menuBtn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
      document.body.classList.add('mobile-scroll-locked');
      // Close search drawer if open
      toggleSearchDrawer(false);
      // Focus first actionable element
      const firstFocusable = sheet.querySelector('button, a, [tabindex="0"]');
      if (firstFocusable) firstFocusable.focus();
    } else {
      // CLOSE
      sheet.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-label', t('menu.openMenu', 'Open navigation menu'));
      menuBtn.innerHTML = `
        <svg class="icon-menu" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      `;
      document.body.classList.remove('mobile-scroll-locked');
      menuBtn.focus();
    }
  }

  function setupSearchDrawer() {
    let drawer = document.getElementById('mobile-search-drawer');
    if (drawer) return;

    drawer = document.createElement('div');
    drawer.id = 'mobile-search-drawer';
    drawer.className = 'mobile-search-drawer';
    drawer.innerHTML = `
      <input type="search" placeholder="${t('menu.searchPlaceholder', 'Search players, events...')}" data-i18n-placeholder="menu.searchPlaceholder" aria-label="${t('menu.searchPlaceholder', 'Search players and events')}" data-i18n-aria="menu.searchPlaceholder" autocomplete="off">
      <div class="mobile-search-results"></div>
    `;

    document.body.appendChild(drawer);

    const input = drawer.querySelector('input');
    const resultsContainer = drawer.querySelector('.mobile-search-results');

    let playersIndex = null;
    let eventsIndex = null;

    input.addEventListener('input', async () => {
      const query = input.value.trim().toLowerCase();
      if (!query) {
        resultsContainer.innerHTML = '';
        return;
      }

      if (!playersIndex) {
        try {
          const res = await fetch('data/profiles/index.json');
          playersIndex = await res.json();
        } catch (e) {
          playersIndex = [];
        }
      }

      if (!eventsIndex) {
        try {
          const res = await fetch('data/events-index.json');
          eventsIndex = await res.json();
        } catch (e) {
          eventsIndex = [];
        }
      }

      const matchedPlayers = (playersIndex || []).filter(p => (p.tag || '').toLowerCase().includes(query)).slice(0, 4);
      const matchedEvents = (eventsIndex || []).filter(ev => (ev.name || '').toLowerCase().includes(query)).slice(0, 3);

      let out = '';
      matchedPlayers.forEach(p => {
        out += `<a href="player.html?player=${encodeURIComponent(p.playerId || p.slug || p.tag)}" class="mobile-search-item">
          <span><strong>${escapeHTML(p.tag)}</strong></span>
          <span style="font-size:11px; color:#4ea8de;">Player</span>
        </a>`;
      });

      matchedEvents.forEach(ev => {
        out += `<a href="events.html" class="mobile-search-item">
          <span>${escapeHTML(ev.name)}</span>
          <span style="font-size:11px; color:#ffd166;">Event</span>
        </a>`;
      });

      resultsContainer.innerHTML = out || `<div style="padding:10px; font-size:13px; color:#94a3b8; text-align:center;" data-i18n="menu.noResults">${t('menu.noResults', 'No results found')}</div>`;
    });
  }

  function toggleSearchDrawer(force) {
    const drawer = document.getElementById('mobile-search-drawer');
    if (!drawer) return;

    const isOpen = (typeof force === 'boolean') ? !force : drawer.classList.contains('open');

    if (!isOpen) {
      drawer.classList.add('open');
      const input = drawer.querySelector('input');
      if (input) {
        input.value = '';
        input.focus();
      }
      toggleMenuSheet(false);
    } else {
      drawer.classList.remove('open');
    }
  }

  function applyTheme(themeId) {
    if (window.pfuyTheme && window.pfuyTheme.apply) {
      window.pfuyTheme.apply(themeId, true);
    } else {
      localStorage.setItem('pfuy-theme', themeId);
      document.documentElement.dataset.theme = themeId;
    }
  }

  function escapeHTML(str) {
    return (str || '').replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function teardownMobileChrome() {
    document.body.classList.remove('mobile-scroll-locked');
    document.removeEventListener('keydown', handleDocumentKeyDown);

    const topActions = document.querySelectorAll('.mobile-top-actions');
    topActions.forEach(el => el.remove());

    const bottomNav = document.getElementById('mobile-bottom-nav');
    if (bottomNav) bottomNav.remove();

    const sheet = document.getElementById('mobile-menu-sheet');
    if (sheet) sheet.remove();

    const drawer = document.getElementById('mobile-search-drawer');
    if (drawer) drawer.remove();
  }

  const mobileQuery = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;

  function isMobileViewport() {
    return mobileQuery ? mobileQuery.matches : (window.innerWidth <= 640);
  }

  function handleViewportChange() {
    if (isMobileViewport()) {
      initMobileChrome();
    } else {
      teardownMobileChrome();
    }
  }

  if (mobileQuery) {
    if (typeof mobileQuery.addEventListener === 'function') {
      mobileQuery.addEventListener('change', handleViewportChange);
    } else if (typeof mobileQuery.addListener === 'function') {
      mobileQuery.addListener(handleViewportChange);
    }
  } else {
    window.addEventListener('resize', handleViewportChange);
  }

  function initOnReady() {
    if (isMobileViewport()) {
      initMobileChrome();
    }
  }

  // Auto-init on DOMContentLoaded only if in mobile viewport
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOnReady);
  } else {
    initOnReady();
  }

  // React to language changes immediately
  if (window.i18n && window.i18n.onChange) {
    window.i18n.onChange(() => {
      const bottomNav = document.getElementById('mobile-bottom-nav');
      if (bottomNav) {
        bottomNav.setAttribute('aria-label', t('menu.primaryNav', 'Mobile primary navigation'));
        bottomNav.querySelectorAll('a[data-i18n]').forEach(a => {
          const key = a.getAttribute('data-i18n');
          a.textContent = t(key, a.textContent);
        });
      }

      const sheet = document.getElementById('mobile-menu-sheet');
      if (sheet) {
        sheet.setAttribute('aria-label', t('menu.navigationMenu', 'Navigation menu'));
        sheet.querySelectorAll('[data-i18n]').forEach(el => {
          const key = el.getAttribute('data-i18n');
          el.textContent = t(key, el.textContent);
        });

        // Update active language toggle button
        const currentLang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : (localStorage.getItem('platfighters_lang') || 'en');
        sheet.querySelectorAll('.mobile-lang-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.lang === currentLang);
        });
      }

      const topbar = document.querySelector('.topbar') || document.querySelector('header.topbar');
      if (topbar) {
        const searchBtn = topbar.querySelector('.mobile-search-btn');
        if (searchBtn) {
          searchBtn.setAttribute('aria-label', t('menu.search', 'Search'));
        }
        const menuBtn = topbar.querySelector('#mobile-menu-btn');
        if (menuBtn) {
          const isOpen = sheet && sheet.classList.contains('open');
          menuBtn.setAttribute('aria-label', isOpen ? t('menu.closeMenu', 'Close navigation menu') : t('menu.openMenu', 'Open navigation menu'));
        }
      }

      const drawer = document.getElementById('mobile-search-drawer');
      if (drawer) {
        const input = drawer.querySelector('input');
        if (input) {
          input.setAttribute('placeholder', t('menu.searchPlaceholder', 'Search players, events...'));
          input.setAttribute('aria-label', t('menu.searchPlaceholder', 'Search players and events'));
        }
      }
    });
  }
})();
