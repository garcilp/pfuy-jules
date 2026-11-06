// Platfighters.uy — Ranking Image Export
// Generates a 1080x1350 PNG in the site's Liquid Glass style using Canvas 2D API directly.

const EXPORT_THEME = {
  bg: '#050B1F',
  text: '#F2F5FA',
  muted: '#AEB6C7',
  accent: '#9FD6FF',
  gold: '#F5C542',
  silver: '#C9D1DC',
  bronze: '#CD7F32'
};

const SHOW_SAMPLE_LABEL = true;

// Preload fonts
async function preloadExportFonts() {
  const fontSpecs = [
    '700 56px "Space Grotesk"',
    '700 46px "Space Grotesk"',
    '700 24px "Space Grotesk"',
    '500 18px "Space Grotesk"',
    '400 16px "Space Grotesk"',
    '500 16px "JetBrains Mono"',
    '700 16px "JetBrains Mono"',
    '500 14px "JetBrains Mono"',
    '500 12px "JetBrains Mono"'
  ];

  if (document.fonts && document.fonts.load) {
    await Promise.allSettled(fontSpecs.map(f => document.fonts.load(f)));
    await document.fonts.ready;
  }
}

// Helper to load an image source
function loadExportImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('No image src'));
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// Draw rounded rectangle path
function drawRoundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Elliptical radial gradient background
function drawExportBackground(ctx, width, height) {
  // Base fill
  ctx.fillStyle = EXPORT_THEME.bg;
  ctx.fillRect(0, 0, width, height);

  // Helper for elliptical gradient
  // Center (cx, cy) in px, radii (rx, ry) in px, stops array [[offset, color], ...]
  function drawEllipseGradient(cx, cy, rx, ry, colorStop0, colorStop1) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, colorStop0);
    grad.addColorStop(0.7, colorStop1);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 1. radial-gradient(60% 50% at 12% 6%, rgba(0,56,168,.70), transparent 70%)
  drawEllipseGradient(
    width * 0.12, height * 0.06,
    width * 0.60, height * 0.50,
    'rgba(0, 56, 168, 0.70)', 'rgba(0, 56, 168, 0)'
  );

  // 2. radial-gradient(50% 45% at 92% 18%, rgba(245,197,66,.22), transparent 70%)
  drawEllipseGradient(
    width * 0.92, height * 0.18,
    width * 0.50, height * 0.45,
    'rgba(245, 197, 66, 0.22)', 'rgba(245, 197, 66, 0)'
  );

  // 3. radial-gradient(55% 50% at 68% 96%, rgba(120,190,255,.30), transparent 70%)
  drawEllipseGradient(
    width * 0.68, height * 0.96,
    width * 0.55, height * 0.50,
    'rgba(120, 190, 255, 0.30)', 'rgba(120, 190, 255, 0)'
  );
}

// Glass card styling
function drawGlassCard(ctx, x, y, width, height, radius, placement) {
  ctx.save();

  // Glass fill
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
  ctx.fill();

  // 135deg sheen gradient: rgba(255,255,255,.16) at 0, transparent at .4 and .7, rgba(255,255,255,.06) at 1
  const sheenGrad = ctx.createLinearGradient(x, y, x + width, y + height);
  sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
  sheenGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0)');
  sheenGrad.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
  sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0.06)');
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = sheenGrad;
  ctx.fill();

  // Top 3 radial glow: placement color at 22% alpha from top left
  let placementColor = null;
  if (placement === 1) placementColor = EXPORT_THEME.gold;
  else if (placement === 2) placementColor = EXPORT_THEME.silver;
  else if (placement === 3) placementColor = EXPORT_THEME.bronze;

  if (placementColor) {
    ctx.save();
    drawRoundRectPath(ctx, x, y, width, height, radius);
    ctx.clip();

    // Parse hex to rgba for glow
    const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(width, height) * 0.7);
    if (placement === 1) {
      glowGrad.addColorStop(0, 'rgba(245, 197, 66, 0.22)');
      glowGrad.addColorStop(1, 'rgba(245, 197, 66, 0)');
    } else if (placement === 2) {
      glowGrad.addColorStop(0, 'rgba(201, 209, 220, 0.22)');
      glowGrad.addColorStop(1, 'rgba(201, 209, 220, 0)');
    } else if (placement === 3) {
      glowGrad.addColorStop(0, 'rgba(205, 127, 50, 0.22)');
      glowGrad.addColorStop(1, 'rgba(205, 127, 50, 0)');
    }
    ctx.fillStyle = glowGrad;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }

  // Border: 1px border rgba(255,255,255,.22) or placement color at 45% alpha for top 3
  drawRoundRectPath(ctx, x, y, width, height, radius);
  if (placementColor) {
    if (placement === 1) ctx.strokeStyle = 'rgba(245, 197, 66, 0.45)';
    else if (placement === 2) ctx.strokeStyle = 'rgba(201, 209, 220, 0.45)';
    else if (placement === 3) ctx.strokeStyle = 'rgba(205, 127, 50, 0.45)';
  } else {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  }
  ctx.lineWidth = 1;
  ctx.stroke();

  // 1px inner top highlight rgba(255,255,255,.45)
  ctx.save();
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(x + radius, y + 0.5);
  ctx.lineTo(x + width - radius, y + 0.5);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

// Draw picture tile with cover cropping or placeholder initial
function drawPictureTile(ctx, img, initial, x, y, size) {
  const radius = size * 0.24;

  ctx.save();
  drawRoundRectPath(ctx, x, y, size, size, radius);
  ctx.clip();

  if (img) {
    // Cover crop
    const imgRatio = img.width / img.height;
    let sW, sH, sX, sY;
    if (imgRatio > 1) {
      sH = img.height;
      sW = img.height;
      sX = (img.width - sW) / 2;
      sY = 0;
    } else {
      sW = img.width;
      sH = img.width;
      sX = 0;
      sY = (img.height - sH) / 2;
    }
    ctx.drawImage(img, sX, sY, sW, sH, x, y, size, size);
  } else {
    // Placeholder initial tile: faint gradient with initial
    const bgGrad = ctx.createLinearGradient(x, y, x + size, y + size);
    bgGrad.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
    bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0.04)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
    ctx.font = `700 ${Math.round(size * 0.46)}px "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((initial || '?').toUpperCase(), x + size / 2, y + size / 2);
  }

  ctx.restore();

  // 1px border rgba(255,255,255,.22)
  ctx.save();
  drawRoundRectPath(ctx, x, y, size, size, radius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Truncate text with ellipsis
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t ? t + '…' : '';
}

// Generate the 1080x1350 canvas for a ranking
async function renderRankingCanvas(rankingData, options = {}) {
  const width = 1080;
  const height = 1350;
  const paddingX = 48;
  const paddingY = 44;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  await preloadExportFonts();

  // Load logo
  let logoImg = null;
  try {
    logoImg = await loadExportImage('assets/logo.jpg');
  } catch (e) {
    console.warn('Could not load logo:', e);
  }

  const allPlayers = Array.isArray(rankingData.players) ? rankingData.players : [];
  const M = allPlayers.length;
  const N = Math.min(M, 10);
  const topPlayers = allPlayers.slice(0, N);

  // Determine image sources to load for players
  const isAdminMode = options.isAdmin === true;
  const imageSources = topPlayers.map(p => {
    if (isAdminMode) {
      if (p._preview) return p._preview;
      if (p.photo) return p.photo;
      if (p.playerId) return `assets/players/${p.playerId}.png`;
    }
    // Non-admin / default: leftmost main character portrait
    if (p._resolvedPortrait) return p._resolvedPortrait;
    if (p.mains && p.mains.length) {
      const gslug = rankingData.game?.slug || 'ultimate';
      const cslug = (typeof charStockSlug === 'function') ? charStockSlug(p.mains[0]) : p.mains[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return `assets/renders/${gslug}/portraits/${cslug}.webp`;
    }
    return '';
  });

  const playerImgResults = await Promise.allSettled(imageSources.map(src => loadExportImage(src)));
  const playerImages = playerImgResults.map(res => res.status === 'fulfilled' ? res.value : null);

  // 1. Draw Background
  drawExportBackground(ctx, width, height);

  // 2. Header row (y ≈ 44)
  const headerY = paddingY;
  if (logoImg) {
    ctx.save();
    drawRoundRectPath(ctx, paddingX, headerY, 52, 52, 14);
    ctx.clip();
    ctx.drawImage(logoImg, paddingX, headerY, 52, 52);
    ctx.restore();
  }

  // Platfighters.uy text next to logo
  const brandX = paddingX + 52 + 16;
  const brandY = headerY + 34;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 24px "Space Grotesk", sans-serif';
  ctx.fillStyle = EXPORT_THEME.text;
  ctx.fillText('Platfighters', brandX, brandY);
  const pfWidth = ctx.measureText('Platfighters').width;
  ctx.fillStyle = EXPORT_THEME.accent;
  ctx.fillText('.uy', brandX + pfWidth, brandY);

  // Right side: "POWER RANKINGS" in mono 14px muted
  ctx.textAlign = 'right';
  ctx.font = '500 14px "JetBrains Mono", monospace';
  ctx.fillStyle = EXPORT_THEME.muted;
  ctx.fillText('POWER RANKINGS', width - paddingX, brandY);

  // 3. Title: ranking title, 56px bold, one line (shrink font until it fits)
  const titleY = 158;
  const maxTitleWidth = width - (paddingX * 2);
  let titleFontSize = 56;
  const rawTitle = (rankingData.title || 'Power Rankings').trim();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  while (titleFontSize > 24) {
    ctx.font = `700 ${titleFontSize}px "Space Grotesk", sans-serif`;
    if (ctx.measureText(rawTitle).width <= maxTitleWidth) break;
    titleFontSize -= 2;
  }
  ctx.fillStyle = EXPORT_THEME.text;
  ctx.fillText(rawTitle, paddingX, titleY);

  // 4. Chips row (y ≈ 208)
  const chipsY = 196;
  let curChipX = paddingX;

  // Game pill: glass pill with game name (18px)
  const gameName = (rankingData.game && rankingData.game.name) ? rankingData.game.name : 'Platform Fighter';
  ctx.font = '500 18px "Space Grotesk", sans-serif';
  const gameTextWidth = ctx.measureText(gameName).width;
  const pillPaddingX = 16;
  const pillHeight = 36;
  const pillWidth = gameTextWidth + (pillPaddingX * 2);
  const pillRadius = pillHeight / 2;

  // Draw game glass pill
  ctx.save();
  drawRoundRectPath(ctx, curChipX, chipsY, pillWidth, pillHeight, pillRadius);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = EXPORT_THEME.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(gameName, curChipX + pillPaddingX, chipsY + pillHeight / 2);
  ctx.restore();

  curChipX += pillWidth + 16;

  // Period text
  let periodText = '';
  if (rankingData.period && rankingData.period.start && rankingData.period.end) {
    if (typeof period === 'function') {
      periodText = period(rankingData.period.start, rankingData.period.end);
    } else {
      periodText = `${rankingData.period.start} – ${rankingData.period.end}`;
    }
  }
  if (periodText) {
    ctx.save();
    ctx.font = '500 18px "Space Grotesk", sans-serif';
    ctx.fillStyle = EXPORT_THEME.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(periodText, curChipX, chipsY + pillHeight / 2);
    curChipX += ctx.measureText(periodText).width + 12;

    ctx.fillText('·', curChipX, chipsY + pillHeight / 2);
    curChipX += ctx.measureText('·').width + 12;
    ctx.restore();
  }

  // "TOP N OF M" in mono 16px accent
  ctx.save();
  ctx.font = '500 16px "JetBrains Mono", monospace';
  ctx.fillStyle = EXPORT_THEME.accent;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`TOP ${N} OF ${M}`, curChipX, chipsY + pillHeight / 2);
  ctx.restore();

  // 5. List: rows 10px apart, in zone y=250 to y=1250
  // Formula: h = min(150, floor((1000 - 10*(N-1) - 28*min(N,3)) / N))
  const gap = 10;
  const topCount = Math.min(N, 3);
  const baseH = (N > 0)
    ? Math.min(150, Math.floor((1000 - gap * (N - 1) - 28 * topCount) / N))
    : 150;

  let currentY = 250;
  const rowWidth = width - (paddingX * 2);

  // Interpolation factor between h=80 (factor 0) and h=150 (factor 1)
  const tH = Math.max(0, Math.min(1, (baseH - 80) / (150 - 80)));

  for (let i = 0; i < N; i++) {
    const p = topPlayers[i];
    const placement = p.placement !== undefined ? p.placement : (i + 1);
    const isTopThree = placement <= 3;
    const rowH = isTopThree ? (baseH + 28) : baseH;
    const cardRadius = isTopThree ? 26 : 22;

    // Draw glass card
    drawGlassCard(ctx, paddingX, currentY, rowWidth, rowH, cardRadius, isTopThree ? placement : null);

    // Dynamic row typography & dimensions
    const rankFontSize = Math.round(38 + (76 - 38) * tH);
    const rankColWidth = Math.round(rankFontSize * 1.35);

    // Rank number
    ctx.save();
    ctx.font = `700 ${rankFontSize}px "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (placement === 1) ctx.fillStyle = EXPORT_THEME.gold;
    else if (placement === 2) ctx.fillStyle = EXPORT_THEME.silver;
    else if (placement === 3) ctx.fillStyle = EXPORT_THEME.bronze;
    else ctx.fillStyle = EXPORT_THEME.accent;

    const rankCenterX = paddingX + (rankColWidth / 2) + 12;
    ctx.fillText(String(placement), rankCenterX, currentY + (rowH / 2));
    ctx.restore();

    // Picture tile
    const picSize = Math.round(rowH * 0.74);
    const picX = paddingX + rankColWidth + 24;
    const picY = currentY + ((rowH - picSize) / 2);
    const initialChar = (p.tag || '?').trim().charAt(0);
    drawPictureTile(ctx, playerImages[i], initialChar, picX, picY, picSize);

    // Points calculation (far right)
    const hasPoints = p.points !== null && p.points !== undefined && p.points !== '';
    let pointsWidth = 0;
    const pointsRightMargin = 28;
    const pointsRightX = paddingX + rowWidth - pointsRightMargin;

    if (hasPoints) {
      const ptsNum = Number(p.points);
      const ptsFormatted = isNaN(ptsNum) ? String(p.points) : ptsNum.toLocaleString('en-US');
      const ptsFontSize = Math.round(20 + (28 - 20) * tH);

      ctx.save();
      ctx.font = `700 ${ptsFontSize}px "JetBrains Mono", monospace`;
      const numWidth = ctx.measureText(ptsFormatted).width;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      const ptsLabelWidth = ctx.measureText('PTS').width;
      pointsWidth = Math.max(numWidth, ptsLabelWidth);

      // Points block height
      const ptsBlockHeight = ptsFontSize + 14;
      const ptsTopY = currentY + (rowH - ptsBlockHeight) / 2;

      // Draw number
      ctx.font = `700 ${ptsFontSize}px "JetBrains Mono", monospace`;
      ctx.fillStyle = EXPORT_THEME.accent;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(ptsFormatted, pointsRightX, ptsTopY);

      // Draw "PTS"
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.fillStyle = EXPORT_THEME.muted;
      ctx.fillText('PTS', pointsRightX, ptsTopY + ptsFontSize + 4);
      ctx.restore();
    }

    // Player text column (sponsor, tag, real name)
    const textStartX = picX + picSize + 22;
    const textMaxRight = hasPoints ? (pointsRightX - pointsWidth - 32) : (paddingX + rowWidth - 28);
    const maxTagWidth = Math.max(60, textMaxRight - textStartX);

    const hasSponsor = Boolean(p.sponsor && String(p.sponsor).trim());
    const hasRealName = Boolean(p.realName && String(p.realName).trim());

    // Font sizes
    const tagFontSize = Math.min(46, Math.round(rowH * 0.31));
    const sponsorFontSize = Math.round(tagFontSize * 0.50);
    const realNameFontSize = Math.round(rowH * 0.15);

    // Measure line heights
    const tagLineH = tagFontSize * 1.15;
    const sponsorLineH = hasSponsor ? (sponsorFontSize * 1.25) : 0;
    const realNameLineH = hasRealName ? (realNameFontSize * 1.25) : 0;

    const totalTextHeight = sponsorLineH + tagLineH + realNameLineH;
    let textCursorY = currentY + (rowH - totalTextHeight) / 2;

    // 1. Sponsor (mono, muted)
    if (hasSponsor) {
      ctx.save();
      ctx.font = `500 ${sponsorFontSize}px "JetBrains Mono", monospace`;
      ctx.fillStyle = EXPORT_THEME.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const fittedSponsor = fitText(ctx, String(p.sponsor).trim().toUpperCase(), maxTagWidth);
      ctx.fillText(fittedSponsor, textStartX, textCursorY);
      ctx.restore();
      textCursorY += sponsorLineH;
    }

    // 2. Tag (bold, white)
    ctx.save();
    ctx.font = `700 ${tagFontSize}px "Space Grotesk", sans-serif`;
    ctx.fillStyle = EXPORT_THEME.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const fittedTag = fitText(ctx, String(p.tag || '').trim(), maxTagWidth);
    ctx.fillText(fittedTag, textStartX, textCursorY);
    ctx.restore();
    textCursorY += tagLineH;

    // 3. Real name (muted)
    if (hasRealName) {
      ctx.save();
      ctx.font = `400 ${realNameFontSize}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = EXPORT_THEME.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const fittedRealName = fitText(ctx, String(p.realName).trim(), maxTagWidth);
      ctx.fillText(fittedRealName, textStartX, textCursorY);
      ctx.restore();
    }

    currentY += rowH + gap;
  }

  // 6. Footer (y ≈ 1306)
  const footerY = height - paddingY + 6;
  ctx.save();
  ctx.font = '500 14px "JetBrains Mono", monospace';
  ctx.fillStyle = EXPORT_THEME.muted;
  ctx.textBaseline = 'alphabetic';

  // Left: "Full ranking at platfighters.uy"
  ctx.textAlign = 'left';
  ctx.fillText('Full ranking at platfighters.uy', paddingX, footerY);

  // Right: "SAMPLE DATA" while SHOW_SAMPLE_LABEL is true
  if (SHOW_SAMPLE_LABEL) {
    ctx.textAlign = 'right';
    ctx.fillText('SAMPLE DATA', width - paddingX, footerY);
  }
  ctx.restore();

  return canvas;
}

// Download exported canvas as PNG
async function exportRankingImage(rankingData, options = {}) {
  const canvas = await renderRankingCanvas(rankingData, options);
  const titleSlug = (typeof slug === 'function')
    ? slug(rankingData.title || 'power-ranking')
    : (rankingData.title || 'power-ranking').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const a = document.createElement('a');
  a.download = `${titleSlug}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}
