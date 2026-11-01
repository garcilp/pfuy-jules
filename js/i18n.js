// Centralized Internationalization (i18n) for Platfighters.uy
(function() {
  const STORAGE_KEY = 'platfighters_lang';

  const translations = {
    en: {
      // Global navigation & common
      'nav.players': 'Players',
      'nav.events': 'Events',
      'nav.rankings': 'Rankings',
      'badge.sample': 'SAMPLE DATA',
      'badge.admin': 'ADMIN',
      'badge.events': 'EVENT DIRECTORY',
      'badge.players': 'PLAYER DIRECTORY',
      'badge.rankings': 'RANKINGS ENGINE',
      'badge.historical': 'HISTORICAL RANKING',
      'badge.eventPage': 'EVENT PAGE',
      'footer.source': 'Source: start.gg API · Served from local cache · Last synced',
      'footer.creator': 'Platfighters.uy · Community Rankings',
      'footer.players': 'Platfighters.uy · Player directory',
      'footer.events': 'Platfighters.uy · Event details',
      'footer.historical': 'Platfighters.uy · Historical Rankings',

      // Home page
      'home.hero.eyebrow': 'The Uruguayan platfighter scene',
      'home.hero.title': 'Every platfighter community, one scene.',
      'home.hero.lead': 'Results, rankings and events from every game and community in Uruguay, built from start.gg history.',
      'home.search.placeholder': 'Search players or tournaments…',
      'home.search.button': 'Search',
      'home.upcoming.title': 'Upcoming events',
      'home.upcoming.viewAll': 'View all events →',
      'home.results.title': 'Recent results',
      'home.results.viewAll': 'All tournaments →',
      'home.history.title': 'On this week',
      'home.history.sub': 'Tournaments played this week ({today}) in past years',
      'home.rankings.title': 'Top players',
      'home.rankings.viewAll': 'All rankings →',
      'home.rankings.sub': 'Current #1 on each community\'s ranking',
      'home.steps.title': 'New to the scene?',
      'home.steps.sub': 'Four steps from curious to competing.',
      'home.hubs.title': 'Community hubs',
      'home.hubs.sub': 'One scene, many communities. Discover where each game lives.',
      'home.stats.games': 'Active games',
      'home.stats.tournaments': 'Tournaments tracked',
      'home.stats.players': 'Ranked players',
      'home.stats.sets': 'Total sets logged',
      'home.rivalry.title': 'Historic rivalry',
      'home.steps.step1.title': 'Pick your game',
      'home.steps.step1.desc': 'Check out the active Uruguayan communities below and find the scene for your game.',
      'home.steps.step2.title': 'Join the Discord',
      'home.steps.step2.desc': 'Every community coordinates friendlies, weekly events, and travel in their Discord server.',
      'home.steps.step3.title': 'Enter a weekly',
      'home.steps.step3.desc': 'Sign up on start.gg when the next bracket opens. First-timers are always welcomed.',
      'home.steps.step4.title': 'Claim your profile',
      'home.steps.step4.desc': 'Your results sync automatically here once your start.gg account participates in Uruguayan events.',

      // Directory pages (players / events)
      'players.eyebrow': 'START.GG PLAYER DATA',
      'players.title': 'Players',
      'players.desc': 'Browse competitors across the games we follow.',
      'players.search.placeholder': 'Search players or tags',
      'players.filter.allGames': 'All games',
      'players.view.condensed': 'Condensed list',
      'players.view.cards': 'Cards',
      'players.loading': 'Loading player profiles…',
      'players.empty.title': 'No matches',
      'players.empty.desc': 'Try another player name, tag, sponsor or game.',
      'players.emptyInit.title': 'No player profiles yet',
      'players.emptyInit.desc': 'Import tournament data and generate player profiles to populate this directory.',

      'events.eyebrow': 'START.GG TOURNAMENT DATA',
      'events.title': 'Events',
      'events.desc': 'Browse tournaments across the games we follow.',
      'events.search.placeholder': 'Search tournaments or events',
      'events.loading': 'Loading tournaments…',
      'events.empty.title': 'No matches',
      'events.empty.desc': 'Try another tournament name or select a different game.',
      'events.emptyInit.title': 'No events yet',
      'events.emptyInit.desc': 'Import tournament data to populate this directory.',
      'events.entrants': '{n} entrants',
      'events.status.upcoming': 'UPCOMING',
      'events.status.past': 'PAST',

      // Event details
      'event.back': 'Return to Event Directory',
      'event.unavailable': 'Event unavailable',
      'event.loading': 'Loading event details…',
      'event.standings': 'Standings',
      'event.openStartgg': 'Open on start.gg ↗',
      'event.entrantsCount': '{n} entrant{s}',
      'event.mainEvent': 'Main event',

      // Player details
      'player.loading': 'Loading player…',
      'player.note': 'Game tabs are generated from the games found in this player’s start.gg entries.',
      'player.overview': 'Overview',
      'player.attendance': 'Attendance',
      'player.winRate': 'Win Rate',
      'player.matchCount': 'Total Matches',
      'player.h2h': 'Head-to-head',
      'player.notableWins': 'Notable wins',
      'player.recentMatches': 'Recent matches',
      'player.characters': 'Characters',
      'player.characterUsage': 'Character usage',

      // Rankings Hub & System views
      'rankings.eyebrow': 'HISTORICAL & POWER RANKINGS',
      'rankings.title': 'Rankings',
      'rankings.desc': 'Competitive rankings and leaderboard systems across Uruguay platform fighters.',
      'rankings.tab.systems': 'Ranking Systems',
      'rankings.tab.powerRankings': 'Power Rankings',
      'rankings.tab.historical': 'Historical Rankings',
      'rankings.subtab.overview': 'Overview',
      'rankings.subtab.glicko2': 'Glicko-2',
      'rankings.subtab.sof': 'Strength of Field',
      'rankings.subtab.qualityWins': 'Quality Wins',
      'rankings.subtab.lossQuality': 'Consistency',
      'rankings.subtab.custom': 'Custom Formula',
      'rankings.filter.game': 'Game',
      'rankings.filter.mode': 'Calculation mode',
      'rankings.filter.modeHistorical': 'Historical (All time)',
      'rankings.filter.modeCurrent': 'Current (Recent period)',
      'rankings.filter.start': 'Start date',
      'rankings.filter.end': 'End date',
      'rankings.filter.search': 'Search player tag…',
      'rankings.preset.all': 'All time',
      'rankings.preset.2025': '2025',
      'rankings.preset.2024': '2024',
      'rankings.preset.6m': 'Last 6 months',
      'rankings.status.calculating': 'Calculating rankings…',
      'rankings.status.ranked': '{n} player{s} ranked in {sys}',
      'rankings.status.overview': 'Displaying rankings overview for {game}',
      'rankings.status.pr': 'Displaying Power Rankings for {game}',
      'rankings.status.empty': 'No ranking data available.',
      'rankings.col.rank': 'RANK',
      'rankings.col.player': 'PLAYER',
      'rankings.col.score': 'SCORE',
      'rankings.col.winRate': 'WIN %',
      'rankings.col.matches': 'MATCHES / EVENTS',
      'rankings.col.actions': 'ACTIONS',
      'rankings.col.glicko2': 'GLICKO-2',
      'rankings.col.qualityWins': 'QUALITY WINS',
      'rankings.col.sof': 'STRENGTH OF FIELD',
      'rankings.col.consistency': 'CONSISTENCY',
      'rankings.btn.diagnostic': 'Diagnostic',
      'rankings.btn.createPR': 'Create PR',
      'rankings.btn.resetDefaults': 'Reset to Defaults (55/20/15/10)',
      'rankings.pr.header': 'Linked Weights & Formula Budget',
      'rankings.pr.eyebrow': 'CUSTOM POWER RANKINGS CREATOR',
      'rankings.pr.totalWeight': 'TOTAL WEIGHT:',
      'rankings.pr.desc': 'Adjust percentage shares to balance component systems. Increasing one component automatically scales down others proportionally to maintain an exact 100% total.',
      'rankings.pr.recommended': '💡 Recommended Starting Formula: 55% Glicko-2 · 20% Quality Wins · 15% Strength of Field · 10% Consistency',
      'rankings.pr.inspector': 'PLAYER CONTRIBUTION INSPECTOR',
      'rankings.pr.inspectPlayer': 'INSPECT PLAYER:',
      'rankings.pr.finalScore': 'FINAL SCORE:',
      'rankings.pr.formulaGuide': '💡 Formula Distinction: Weight vs. Normalized Score vs. Weighted Contribution',
      'rankings.pr.formulaGuideText': '• Weight (%): How important a ranking system is in the custom formula configuration budget.<br>• Normalized Score (0–100): How a particular player performs on that system relative to the eligible player population.<br>• Weighted Contribution (pts): (Normalized Score × Weight) / 100. How much that component contributes to the player\'s final custom score.',
      'rankings.empty.noMatch': 'No players match the search filter.',
      'rankings.empty.invalidDate': 'Invalid Date Range',
      'rankings.empty.invalidDateDesc': 'Start date cannot be after end date.',
      'rankings.empty.calcError': 'Calculation Error',
      'rankings.scroll.showing': 'Showing {count} of {total} players (scroll down to load more…)',
      'rankings.scroll.showingAll': 'Showing all {total} players',
      'rankings.overview.title': 'Rankings Overview',
      'rankings.overview.desc': 'Side-by-side player ranks and scores across all 4 distinct systems. Each metric measures a different competitive dimension and raw values are presented on their native scales.',

      // Historical Rankings View
      'historical.eyebrow': 'HISTORICAL POWER RANKINGS',
      'historical.titleAll': 'All games power rankings',
      'historical.titleGame': '{game} power rankings',
      'historical.lead': 'Rankings are published by each game’s community. Newest first.',
      'historical.create': 'Create',
      'historical.allGames': 'All games',
      'historical.viewRanking': 'View Ranking →',
      'historical.empty': 'No rankings published for this selection yet.',
      'historical.playersCount': '{n} players',
      'historical.current': 'CURRENT',
      'historical.final': 'FINAL',

      // Ranking Article View
      'ranking.notFound': 'Ranking not found.',
      'ranking.back': 'Back to all rankings',
      'ranking.rankedCount': '{n} players ranked',
      'ranking.publishedBy': 'Published by {name}',
      'ranking.notableWins': 'NOTABLE WINS',
      'ranking.notableResults': 'NOTABLE RESULTS',
      'ranking.times': '{n} times',
      'ranking.entrants': '{n} entrants',

      // Ranking Creator
      'creator.crumb.rankings': 'Rankings',
      'creator.crumb.new': 'New ranking',
      'creator.title': 'New power ranking',
      'creator.draft': 'DRAFT',
      'creator.saveDraft': 'Save draft',
      'creator.preview': 'Preview',
      'creator.publish': 'Publish',
      'creator.publishTitle': 'Publishing needs a backend',
      'creator.details.title': 'Ranking details',
      'creator.details.sub': 'Shown in the archive and at the top of the article.',
      'creator.field.name': 'NAME',
      'creator.field.game': 'GAME',
      'creator.field.start': 'PERIOD START',
      'creator.field.end': 'PERIOD END',
      'creator.field.status': 'STATUS',
      'creator.field.publishedBy': 'PUBLISHED BY',
      'creator.field.intro': 'INTRO',
      'creator.field.placement': 'PLACEMENT',
      'creator.field.tag': 'TAG',
      'creator.field.points': 'POINTS',
      'creator.field.realName': 'Real name',
      'creator.field.mains': 'Mains',
      'creator.field.yearText': 'Year text',
      'creator.field.notableWins': 'Notable wins',
      'creator.field.notableResults': 'Notable results',
      'creator.field.opponent': 'OPPONENT',
      'creator.field.format': 'FORMAT',
      'creator.field.times': 'TIMES',
      'creator.field.tournament': 'TOURNAMENT',
      'creator.field.event': 'EVENT',
      'creator.field.entrants': 'ENTRANTS',
      'creator.action.addPlayer': '+ Add player',
      'creator.action.removePlayer': 'Remove player',
      'creator.action.sortPoints': 'Sort by points',
      'creator.action.addMain': '+ Add main',
      'creator.action.addWin': '+ Add notable win',
      'creator.action.addResult': '+ Add notable result',
      'creator.action.replacePic': 'Replace picture',
      'creator.note.drag': 'Drag to reorder. Placements follow the order.',
      'creator.note.format': 'JPG or PNG',
      'creator.note.placementHint': 'Placement is set by the player’s position in the list.',
      'creator.note.mainsHint': 'Shown on the ranking as stock icons.',
      'creator.beforePublish': 'Before publishing',
      'creator.check.details': 'Name, game and period',
      'creator.check.players': 'Placement, tag and points for all {n} players',
      'creator.check.pics': 'Pictures',
      'creator.status.done': 'DONE',
      'creator.status.missing': 'MISSING',
      'creator.status.of': '{n} OF {total}',
      'creator.required': 'REQUIRED',
      'creator.optional': 'OPTIONAL',
      'creator.characters': '{n} characters',
      'creator.unsaved': 'Unsaved changes',
      'creator.savedAt': 'Saved at {time}',
      'creator.noChanges': 'No changes yet',
      'creator.community': '{game} community',
      'creator.addN': 'Add {n}',
      'creator.prSnapshotControls': 'Quick Populate from Power Rankings',

      // Admin Interface
      'admin.eyebrow': 'PLAYER MANAGEMENT',
      'admin.title': 'Player data',
      'admin.desc': 'Update the profile details shown on Platfighters.uy.',
      'admin.login.title': 'Administrator sign in',
      'admin.login.desc': 'Sign in to edit player profile information.',
      'admin.login.password': 'Admin password',
      'admin.login.submit': 'Sign in',
      'admin.editor.title': 'Edit player',
      'admin.editor.desc': 'Edit every profile field, game summary, character, matchup, and result in the full JSON document. The start.gg player ID stays fixed.',
      'admin.editor.signout': 'Sign out',
      'admin.editor.profile': 'Player profile',
      'admin.editor.gameVis': 'Game visibility',
      'admin.editor.gameVisDesc': 'Check games to hide this player’s activity from those games across the site.',
      'admin.editor.quickEdit': 'Quick player edits',
      'admin.editor.save': 'Save player',
      'admin.editor.reset': 'Reset',
      'admin.editor.reload': 'Reload',
      'admin.editor.delete': 'Delete'
    },
    es: {
      // Navegación global y común
      'nav.players': 'Jugadores',
      'nav.events': 'Torneos',
      'nav.rankings': 'Rankings',
      'badge.sample': 'DATOS DE MUESTRA',
      'badge.admin': 'ADMINISTRACIÓN',
      'badge.events': 'DIRECTORIO DE TORNEOS',
      'badge.players': 'DIRECTORIO DE JUGADORES',
      'badge.rankings': 'MOTOR DE RANKINGS',
      'badge.historical': 'RANKING HISTÓRICO',
      'badge.eventPage': 'PÁGINA DE EVENTO',
      'footer.source': 'Fuente: API de start.gg · Servido desde caché local · Última sincronización',
      'footer.creator': 'Platfighters.uy · Rankings de la Comunidad',
      'footer.players': 'Platfighters.uy · Directorio de jugadores',
      'footer.events': 'Platfighters.uy · Detalles del evento',
      'footer.historical': 'Platfighters.uy · Rankings históricos',

      // Página de inicio
      'home.hero.eyebrow': 'La escena uruguaya de platform fighters',
      'home.hero.title': 'Todas las comunidades, una sola escena.',
      'home.hero.lead': 'Resultados, rankings y torneos de cada juego y comunidad en Uruguay, recopilados del historial de start.gg.',
      'home.search.placeholder': 'Buscar jugadores o torneos…',
      'home.search.button': 'Buscar',
      'home.upcoming.title': 'Próximos torneos',
      'home.upcoming.viewAll': 'Ver todos los torneos →',
      'home.results.title': 'Resultados recientes',
      'home.results.viewAll': 'Todos los torneos →',
      'home.history.title': 'En esta semana',
      'home.history.sub': 'Torneos jugados esta semana ({today}) en años anteriores',
      'home.rankings.title': 'Mejores jugadores',
      'home.rankings.viewAll': 'Todos los rankings →',
      'home.rankings.sub': '#1 actual en el ranking de cada comunidad',
      'home.steps.title': '¿Nuevo en la escena?',
      'home.steps.sub': 'Cuatro pasos de curioso a competidor.',
      'home.hubs.title': 'Comunidades',
      'home.hubs.sub': 'Una escena, muchas comunidades. Descubre dónde vive cada juego.',
      'home.stats.games': 'Juegos activos',
      'home.stats.tournaments': 'Torneos registrados',
      'home.stats.players': 'Jugadores rankeados',
      'home.stats.sets': 'Sets totales jugados',
      'home.rivalry.title': 'Rivalidad histórica',
      'home.steps.step1.title': 'Elige tu juego',
      'home.steps.step1.desc': 'Descubre las comunidades uruguayas activas abajo y encuentra la escena de tu juego.',
      'home.steps.step2.title': 'Únete al Discord',
      'home.steps.step2.desc': 'Cada comunidad organiza partidas amistosas, torneos semanales y viajes en su servidor de Discord.',
      'home.steps.step3.title': 'Inscríbete a un semanal',
      'home.steps.step3.desc': 'Regístrate en start.gg cuando abra el próximo torneo. Los principiantes siempre son bienvenidos.',
      'home.steps.step4.title': 'Reclama tu perfil',
      'home.steps.step4.desc': 'Tus resultados se sincronizan automáticamente aquí una vez que participas con tu cuenta de start.gg en torneos uruguayos.',

      // Páginas de directorio
      'players.eyebrow': 'DATOS DE JUGADORES DE START.GG',
      'players.title': 'Jugadores',
      'players.desc': 'Explora competidores de todos los juegos que seguimos.',
      'players.search.placeholder': 'Buscar jugadores o tags',
      'players.filter.allGames': 'Todos los juegos',
      'players.view.condensed': 'Lista condensada',
      'players.view.cards': 'Tarjetas',
      'players.loading': 'Cargando perfiles de jugadores…',
      'players.empty.title': 'Sin resultados',
      'players.empty.desc': 'Prueba con otro nombre, tag, sponsor o juego.',
      'players.emptyInit.title': 'Aún no hay perfiles',
      'players.emptyInit.desc': 'Importa datos de torneos y genera perfiles para poblar este directorio.',

      'events.eyebrow': 'DATOS DE TORNEOS DE START.GG',
      'events.title': 'Torneos',
      'events.desc': 'Explora torneos de todos los juegos que seguimos.',
      'events.search.placeholder': 'Buscar torneos o eventos',
      'events.loading': 'Cargando torneos…',
      'events.empty.title': 'Sin resultados',
      'events.empty.desc': 'Prueba con otro nombre de torneo o selecciona un juego diferente.',
      'events.emptyInit.title': 'Aún no hay torneos',
      'events.emptyInit.desc': 'Importa datos de torneos para poblar este directorio.',
      'events.entrants': '{n} participantes',
      'events.status.upcoming': 'PRÓXIMO',
      'events.status.past': 'PASADO',

      // Detalles del evento
      'event.back': 'Volver al directorio de torneos',
      'event.unavailable': 'Evento no disponible',
      'event.loading': 'Cargando detalles del evento…',
      'event.standings': 'Posiciones',
      'event.openStartgg': 'Abrir en start.gg ↗',
      'event.entrantsCount': '{n} participante{s}',
      'event.mainEvent': 'Evento principal',

      // Perfil del jugador
      'player.loading': 'Cargando jugador…',
      'player.note': 'Las pestañas de juegos se generan a partir de los eventos encontrados en start.gg para este jugador.',
      'player.overview': 'Resumen',
      'player.attendance': 'Asistencias',
      'player.winRate': '% de Victorias',
      'player.matchCount': 'Partidas Totales',
      'player.h2h': 'Frente a frente',
      'player.notableWins': 'Victorias destacadas',
      'player.recentMatches': 'Partidas recientes',
      'player.characters': 'Personajes',
      'player.characterUsage': 'Uso de personajes',

      // Rankings Hub & Sistemas
      'rankings.eyebrow': 'RANKINGS HISTÓRICOS Y DE PODER',
      'rankings.title': 'Rankings',
      'rankings.desc': 'Sistemas de clasificación y tablas de posiciones de platform fighters en Uruguay.',
      'rankings.tab.systems': 'Sistemas de Ranking',
      'rankings.tab.powerRankings': 'Power Rankings',
      'rankings.tab.historical': 'Rankings Históricos',
      'rankings.subtab.overview': 'Resumen',
      'rankings.subtab.glicko2': 'Glicko-2',
      'rankings.subtab.sof': 'Fuerza de Campo',
      'rankings.subtab.qualityWins': 'Victorias de Calidad',
      'rankings.subtab.lossQuality': 'Consistencia',
      'rankings.subtab.custom': 'Fórmula Personalizada',
      'rankings.filter.game': 'Juego',
      'rankings.filter.mode': 'Modo de cálculo',
      'rankings.filter.modeHistorical': 'Histórico (Historial completo)',
      'rankings.filter.modeCurrent': 'Actual (Periodo reciente)',
      'rankings.filter.start': 'Fecha inicial',
      'rankings.filter.end': 'Fecha final',
      'rankings.filter.search': 'Buscar tag de jugador…',
      'rankings.preset.all': 'Todo el tiempo',
      'rankings.preset.2025': '2025',
      'rankings.preset.2024': '2024',
      'rankings.preset.6m': 'Últimos 6 meses',
      'rankings.status.calculating': 'Calculando rankings…',
      'rankings.status.ranked': '{n} jugador{es} clasificado{s} en {sys}',
      'rankings.status.overview': 'Mostrando resumen de rankings para {game}',
      'rankings.status.pr': 'Mostrando Power Rankings para {game}',
      'rankings.status.empty': 'No hay datos de ranking disponibles.',
      'rankings.col.rank': 'PUESTO',
      'rankings.col.player': 'JUGADOR',
      'rankings.col.score': 'PUNTAJE',
      'rankings.col.winRate': '% VICTORIAS',
      'rankings.col.matches': 'PARTIDAS / TORNEOS',
      'rankings.col.actions': 'ACCIONES',
      'rankings.col.glicko2': 'GLICKO-2',
      'rankings.col.qualityWins': 'VICTORIAS DE CALIDAD',
      'rankings.col.sof': 'FUERZA DE CAMPO',
      'rankings.col.consistency': 'CONSISTENCIA',
      'rankings.btn.diagnostic': 'Diagnóstico',
      'rankings.btn.createPR': 'Crear PR',
      'rankings.btn.resetDefaults': 'Restablecer Valores (55/20/15/10)',
      'rankings.pr.header': 'Ponderación y Presupuesto de Fórmula',
      'rankings.pr.eyebrow': 'CREADOR DE POWER RANKINGS PERSONALIZADOS',
      'rankings.pr.totalWeight': 'PESO TOTAL:',
      'rankings.pr.desc': 'Ajusta los porcentajes para balancear los sistemas. Aumentar un componente reduce automáticamente los demás de manera proporcional para mantener exactamente el 100%.',
      'rankings.pr.recommended': '💡 Fórmula Recomendada de Inicio: 55% Glicko-2 · 20% Victorias de Calidad · 15% Fuerza de Campo · 10% Consistencia',
      'rankings.pr.inspector': 'INSPECTOR DE CONTRIBUCIÓN DE JUGADOR',
      'rankings.pr.inspectPlayer': 'INSPECCIONAR JUGADOR:',
      'rankings.pr.finalScore': 'PUNTAJE FINAL:',
      'rankings.pr.formulaGuide': '💡 Distinción de la Fórmula: Peso vs. Puntaje Normalizado vs. Contribución Ponderada',
      'rankings.pr.formulaGuideText': '• Peso (%): Qué tan importante es un sistema en el presupuesto de la fórmula.<br>• Puntaje Normalizado (0–100): Desempeño del jugador en ese sistema relativo a los demás jugadores elegibles.<br>• Contribución Ponderada (pts): (Puntaje Normalizado × Peso) / 100. Cuántos puntos aporta ese componente al puntaje final.',
      'rankings.empty.noMatch': 'Ningún jugador coincide con el filtro.',
      'rankings.empty.invalidDate': 'Rango de Fechas Inválido',
      'rankings.empty.invalidDateDesc': 'La fecha inicial no puede ser posterior a la fecha final.',
      'rankings.empty.calcError': 'Error de Cálculo',
      'rankings.scroll.showing': 'Mostrando {count} de {total} jugadores (desplaza hacia abajo para cargar más…)',
      'rankings.scroll.showingAll': 'Mostrando los {total} jugadores',
      'rankings.overview.title': 'Resumen de Rankings',
      'rankings.overview.desc': 'Puestos y puntajes comparados en los 4 sistemas. Cada métrica evalúa una dimensión competitiva diferente en sus escalas nativas.',

      // Histórico
      'historical.eyebrow': 'POWER RANKINGS HISTÓRICOS',
      'historical.titleAll': 'Power rankings de todos los juegos',
      'historical.titleGame': 'Power rankings de {game}',
      'historical.lead': 'Los rankings son publicados por la comunidad de cada juego. Más recientes primero.',
      'historical.create': 'Crear',
      'historical.allGames': 'Todos los juegos',
      'historical.viewRanking': 'Ver Ranking →',
      'historical.empty': 'Aún no se han publicado rankings para esta selección.',
      'historical.playersCount': '{n} jugadores',
      'historical.current': 'ACTUAL',
      'historical.final': 'FINAL',

      // Artículo de ranking
      'ranking.notFound': 'Ranking no encontrado.',
      'ranking.back': 'Volver a todos los rankings',
      'ranking.rankedCount': '{n} jugadores rankeados',
      'ranking.publishedBy': 'Publicado por {name}',
      'ranking.notableWins': 'VICTORIAS DESTACADAS',
      'ranking.notableResults': 'RESULTADOS DESTACADOS',
      'ranking.times': '{n} veces',
      'ranking.entrants': '{n} participantes',

      // Creador de ranking
      'creator.crumb.rankings': 'Rankings',
      'creator.crumb.new': 'Nuevo ranking',
      'creator.title': 'Nuevo power ranking',
      'creator.draft': 'BORRADOR',
      'creator.saveDraft': 'Guardar borrador',
      'creator.preview': 'Vista previa',
      'creator.publish': 'Publicar',
      'creator.publishTitle': 'Publicar requiere un backend',
      'creator.details.title': 'Detalles del ranking',
      'creator.details.sub': 'Se muestra en el archivo y al inicio del artículo.',
      'creator.field.name': 'NOMBRE',
      'creator.field.game': 'JUEGO',
      'creator.field.start': 'INICIO DEL PERIODO',
      'creator.field.end': 'FIN DEL PERIODO',
      'creator.field.status': 'ESTADO',
      'creator.field.publishedBy': 'PUBLICADO POR',
      'creator.field.intro': 'INTRODUCCIÓN',
      'creator.field.placement': 'PUESTO',
      'creator.field.tag': 'TAG',
      'creator.field.points': 'PUNTOS',
      'creator.field.realName': 'Nombre real',
      'creator.field.mains': 'Mains',
      'creator.field.yearText': 'Texto del año',
      'creator.field.notableWins': 'Victorias destacadas',
      'creator.field.notableResults': 'Resultados destacados',
      'creator.field.opponent': 'RIVAL',
      'creator.field.format': 'FORMATO',
      'creator.field.times': 'VECES',
      'creator.field.tournament': 'TORNEO',
      'creator.field.event': 'EVENTO',
      'creator.field.entrants': 'PARTICIPANTES',
      'creator.action.addPlayer': '+ Agregar jugador',
      'creator.action.removePlayer': 'Eliminar jugador',
      'creator.action.sortPoints': 'Ordenar por puntos',
      'creator.action.addMain': '+ Agregar main',
      'creator.action.addWin': '+ Agregar victoria destacada',
      'creator.action.addResult': '+ Agregar resultado destacado',
      'creator.action.replacePic': 'Cambiar imagen',
      'creator.note.drag': 'Arrastra para reordenar. Los puestos siguen el orden.',
      'creator.note.format': 'JPG o PNG',
      'creator.note.placementHint': 'El puesto está determinado por la posición en la lista.',
      'creator.note.mainsHint': 'Aparecen en el ranking como íconos de stock.',
      'creator.beforePublish': 'Antes de publicar',
      'creator.check.details': 'Nombre, juego y periodo',
      'creator.check.players': 'Puesto, tag y puntos para los {n} jugadores',
      'creator.check.pics': 'Imágenes',
      'creator.status.done': 'LISTO',
      'creator.status.missing': 'FALTA',
      'creator.status.of': '{n} DE {total}',
      'creator.required': 'REQUERIDO',
      'creator.optional': 'OPCIONAL',
      'creator.characters': '{n} caracteres',
      'creator.unsaved': 'Cambios sin guardar',
      'creator.savedAt': 'Guardado a las {time}',
      'creator.noChanges': 'Sin cambios aún',
      'creator.community': 'Comunidad de {game}',
      'creator.addN': 'Agregar {n}',
      'creator.prSnapshotControls': 'Población rápida desde Power Rankings',

      // Administración
      'admin.eyebrow': 'GESTIÓN DE JUGADORES',
      'admin.title': 'Datos de jugadores',
      'admin.desc': 'Actualiza los detalles del perfil mostrados en Platfighters.uy.',
      'admin.login.title': 'Inicio de sesión de administrador',
      'admin.login.desc': 'Inicia sesión para editar información de perfiles.',
      'admin.login.password': 'Contraseña de administrador',
      'admin.login.submit': 'Iniciar sesión',
      'admin.editor.title': 'Editar jugador',
      'admin.editor.desc': 'Edita cada campo de perfil, resumen de juego, personaje, enfrentamiento y resultado en el documento JSON completo. El ID de jugador de start.gg permanece fijo.',
      'admin.editor.signout': 'Cerrar sesión',
      'admin.editor.profile': 'Perfil del jugador',
      'admin.editor.gameVis': 'Visibilidad de juegos',
      'admin.editor.gameVisDesc': 'Marca los juegos para ocultar la actividad de este jugador en esos juegos en todo el sitio.',
      'admin.editor.quickEdit': 'Edición rápida del jugador',
      'admin.editor.save': 'Guardar jugador',
      'admin.editor.reset': 'Restablecer',
      'admin.editor.reload': 'Recargar',
      'admin.editor.delete': 'Eliminar'
    }
  };

  let currentLang = 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'es' || saved === 'en') {
      currentLang = saved;
    }
  } catch (e) {}

  const listeners = [];

  function t(key, params = {}) {
    let str = (translations[currentLang] && translations[currentLang][key]) ||
              (translations.en && translations.en[key]) ||
              key;
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(k => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
      });
    }
    return str;
  }

  function applyTranslations(root = document) {
    if (!root) return;
    document.documentElement.lang = currentLang;

    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        if (el.hasAttribute('data-i18n-html')) {
          el.innerHTML = t(key);
        } else {
          el.textContent = t(key);
        }
      }
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.setAttribute('placeholder', t(key));
      }
    });

    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.setAttribute('title', t(key));
      }
    });

    root.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) {
        el.setAttribute('aria-label', t(key));
      }
    });

    // Update state of all lang toggle buttons on the page
    document.querySelectorAll('.lang-btn').forEach(btn => {
      const btnLang = btn.getAttribute('data-lang');
      btn.classList.toggle('on', btnLang === currentLang);
    });
  }

  function setLang(lang) {
    if (lang !== 'en' && lang !== 'es') return;
    if (lang === currentLang) {
      applyTranslations();
      return;
    }
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}

    applyTranslations();
    listeners.forEach(cb => {
      try { cb(currentLang); } catch (e) { console.error(e); }
    });
  }

  function getLang() {
    return currentLang;
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  // Global click delegation for language toggle buttons
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.lang-btn');
    if (btn) {
      const lang = btn.getAttribute('data-lang');
      if (lang) {
        e.preventDefault();
        setLang(lang);
      }
    }
  });

  // Apply on DOM load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyTranslations());
  } else {
    applyTranslations();
  }

  window.i18n = {
    t,
    setLang,
    getLang,
    applyTranslations,
    onChange
  };
})();
