/**
 * Loads existing blog posts from plotwell-landing and provides
 * content intelligence for auto-suggestions.
 */

export interface ExistingPost {
  slug: string;
  title: string;
  tags: string[];
  lang: string;
  date: string;
  description: string;
}

// Hardcoded inventory of existing posts (updated manually or via script)
// This avoids runtime filesystem access from the browser.
const EXISTING_POSTS: ExistingPost[] = [
  { slug: "estructura-tres-actos-guion", title: "La estructura en tres actos explicada: cómo está construido todo guión que funciona", tags: ["guión","estructura narrativa"], lang: "es", date: "2026-05-06", description: "La estructura en tres actos es la base de casi todo film que funciona. Aquí tienes qué hace cada acto realmente, por qué funciona, y cómo usarla sin que tu guión se sienta formulaico." },
  { slug: "three-act-structure-screenplay", title: "Three-Act Structure Explained: How Every Successful Screenplay Is Built", tags: ["screenwriting","story structure"], lang: "en", date: "2026-05-06", description: "Three-act structure is the foundation of almost every film that works. Here's what each act actually does, why it works, and how to use it without making your script feel formulaic." },
  { slug: "script-doctor-problemas-estructurales", title: "El Script Doctor: Cómo encontrar y corregir problemas estructurales antes de rodar", tags: ["guión","estructura narrativa","desarrollo de guión"], lang: "es", date: "2026-04-25", description: "La mayoría de los problemas que aparecen en el rodaje ya eran visibles en el guión semanas antes. Aquí tienes cómo diagnosticarlos y solucionarlos antes de que llegue el equipo." },
  { slug: "script-doctor-structural-fixes", title: "The Script Doctor: Finding and Fixing Structural Problems Before You Shoot", tags: ["screenwriting","story structure","script development"], lang: "en", date: "2026-04-15", description: "Most screenplay problems that appear on set were visible on the page weeks earlier. Here's how to diagnose and fix them before a crew shows up." },
  { slug: "scene-breakdown-production-plan", title: "Scene Breakdown 101: Turning Your Script into a Production Plan", tags: ["production planning","pre-production","filmmaking"], lang: "en", date: "2026-04-10", description: "A scene breakdown is where your screenplay becomes a production document. Here's what to extract, how to organize it, and how to use it to build a realistic schedule." },
  { slug: "writing-dialogue-that-works", title: "Writing Dialogue That Doesn't Sound Written", tags: ["screenwriting","dialogue","craft"], lang: "en", date: "2026-04-05", description: "The difference between dialogue that reads well and dialogue that plays well comes down to a few core principles. Here's how to write lines that an actor can actually use." },
  { slug: "de-guion-youtube-a-serie", title: "De guion de YouTube a serie completa: como convertir tu canal en contenido episodico", tags: ["screenwriting","series","content creation"], lang: "es", date: "2026-03-14", description: "Guia para creadores de YouTube que quieren hacer la transicion de videos independientes a series con guion episodico. Cubre formato, arcos de historia, planificacion de episodios y flujo de produccion." },
  { slug: "flujo-trabajo-writers-room", title: "Flujo de trabajo en un writers room pequeno: como colaborar en una serie con 2-5 personas", tags: ["screenwriting","collaboration","series"], lang: "es", date: "2026-03-14", description: "Guia practica para gestionar un writers room pequeno para web series y TV indie. Cubre roles, flujo de trabajo, herramientas y como dividir episodios entre escritores." },
  { slug: "guia-estructura-web-serie", title: "Como estructurar una web serie: planificacion de episodios para nuevos creadores", tags: ["screenwriting","series","story structure"], lang: "es", date: "2026-03-14", description: "Aprende a estructurar una web serie desde el concepto hasta el desglose de episodios. Cubre duracion de episodios, arcos de temporada, continuidad de personajes y herramientas para gestionar contenido episodico." },
  { slug: "small-writers-room-workflow", title: "Small Writers Room Workflow: How to Collaborate on a Series with 2-5 People", tags: ["screenwriting","collaboration","series"], lang: "en", date: "2026-03-14", description: "A practical guide to running a small writers room for web series and indie TV. Covers roles, workflow, tools, and how to divide episodes among writers." },
  { slug: "web-series-structure-guide", title: "How to Structure a Web Series: Episode Planning for New Creators", tags: ["screenwriting","series","story structure"], lang: "en", date: "2026-03-14", description: "Learn how to structure a web series from concept to episode breakdown. Covers episode length, season arcs, character continuity, and tools for managing episodic content." },
  { slug: "youtube-script-to-series", title: "From YouTube Script to Full Series: How to Turn Your Channel into Episodic Content", tags: ["screenwriting","series","content creation"], lang: "en", date: "2026-03-14", description: "A guide for YouTube creators who want to transition from standalone videos to scripted episodic series. Covers format, story arcs, episode planning, and production workflow." },
  { slug: "guia-planificacion-produccion", title: "Planificación de producción cinematográfica: Qué hacer y cómo preparar tu proyecto para rodar", tags: ["producción","cine","preproducción","planificación"], lang: "es", date: "2026-03-10", description: "Una guía paso a paso para la planificación de preproducción para cineastas independientes. Desde el desglose de guión hasta el plan de rodaje, aprende qué necesita suceder antes de gritar 'acción' y cómo organizarlo todo." },
  { slug: "production-planning-guide", title: "Film Production Planning: What to Do and How to Get Your Project Camera-Ready", tags: ["production","filmmaking","pre-production","planning"], lang: "en", date: "2026-03-10", description: "A step-by-step guide to pre-production planning for indie filmmakers. From script breakdown to shooting schedule, learn what needs to happen before you call 'action' and how to organize it all." },
  { slug: "character-treatment-breakdown", title: "How to Write a Character Treatment and Breakdown for Your Screenplay", tags: ["screenwriting","characters","production","story structure"], lang: "en", date: "2026-02-26", description: "A practical guide to building deep, consistent characters through treatments and breakdowns. Learn the techniques that make characters feel real and how to organize character work for production." },
  { slug: "tratamiento-desglose-personaje", title: "Cómo escribir un tratamiento y desglose de personaje para tu guión", tags: ["guión","personajes","producción","estructura narrativa"], lang: "es", date: "2026-02-26", description: "Una guía práctica para construir personajes profundos y consistentes a través de tratamientos y desgloses. Aprende las técnicas que hacen que los personajes se sientan reales y cómo organizar el trabajo de personaje para producción." },
  { slug: "como-formatear-guion", title: "Cómo formatear un guión: La guía completa para 2026", tags: ["guión","formato","principiante"], lang: "es", date: "2026-02-12", description: "Aprende el formato estándar de guión cinematográfico, desde encabezados de escena hasta diálogos. Una guía paso a paso con ejemplos que harán que tu guión se vea profesional." },
  { slug: "how-to-format-screenplay", title: "How to Format a Screenplay: The Complete Guide for 2026", tags: ["screenwriting","formatting","beginner"], lang: "en", date: "2026-02-12", description: "Learn the industry-standard screenplay format, from scene headings to dialogue. A step-by-step guide with examples that will help your script look professional." },
  { slug: "beat-sheet-guide", title: "How to Write a Beat Sheet for Your Screenplay", tags: ["screenwriting","story structure","outlining"], lang: "en", date: "2026-01-28", description: "A practical guide to creating a beat sheet that structures your story before you write a single scene. Includes templates and examples for feature films and TV pilots." },
  { slug: "guia-beat-sheet", title: "Cómo escribir un Beat Sheet para tu guión", tags: ["guión","estructura narrativa","planificación"], lang: "es", date: "2026-01-28", description: "Una guía práctica para crear un beat sheet que estructure tu historia antes de escribir una sola escena. Incluye plantillas y ejemplos para largometrajes y pilotos de TV." },
  { slug: "como-hacer-storyboard", title: "Cómo hacer el storyboard de tu película: Guía práctica para cineastas independientes", tags: ["storyboard","producción","cine"], lang: "es", date: "2026-01-15", description: "Aprende a crear storyboards efectivos para tu película, aunque no sepas dibujar. Cubre tipos de plano, movimientos de cámara y cómo comunicar tu visión a tu equipo." },
  { slug: "storyboard-your-film", title: "How to Storyboard Your Film: A Practical Guide for Indie Filmmakers", tags: ["storyboarding","production","filmmaking"], lang: "en", date: "2026-01-15", description: "Learn how to create effective storyboards for your film, even if you can't draw. Covers shot types, camera movements, and how to communicate your vision to your crew." },
];

export function getExistingPosts(lang?: string): ExistingPost[] {
  if (!lang) return EXISTING_POSTS;
  return EXISTING_POSTS.filter((p) => p.lang === lang);
}

export function getExistingSlugs(): Set<string> {
  return new Set(EXISTING_POSTS.map((p) => p.slug));
}

export function getCoveredTags(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of EXISTING_POSTS.filter((p) => p.lang === "en")) {
    for (const t of p.tags) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function getExistingPostsSummary(): string {
  const en = EXISTING_POSTS.filter((p) => p.lang === "en");
  return en.map((p) => `- "${p.title}" (tags: ${p.tags.join(", ")})`).join("\n");
}

/** plotwell features for content ideas */
export const PLOTWELL_FEATURES = [
  "Script Editor with AI-powered formatting and autocomplete",
  "AI Script Doctor for feedback and suggestions",
  "Scene generation from outlines or descriptions",
  "Beat Sheet view for story structure planning",
  "Storyboard editor with AI image generation",
  "Real-time collaboration for writers rooms",
  "TV Series mode: seasons, episodes, per-episode scripts",
  "Production planning: scene breakdowns, call sheets, budgets",
  "Character profiles and development tools",
  "Location management and scouting tools",
  "Cast & crew management",
  "PDF export in industry-standard format",
  "FDX and Fountain import/export",
  "AI brainstorming chat assistant",
  "Version history and script revisions",
];

/** Pre-built content gap topics that don't exist yet */
export const CONTENT_GAPS = {
  blog_en: [
    { topic: "Dialogue writing techniques: how to make characters sound distinct", keyword: "screenplay dialogue tips", tags: ["screenwriting", "characters"] },
    { topic: "Three-act structure explained with modern screenplay examples", keyword: "three act structure screenplay", tags: ["screenwriting", "story structure"] },
    { topic: "How to write a logline that sells your screenplay", keyword: "how to write a logline", tags: ["screenwriting", "story structure"] },
    { topic: "Scene breakdown for indie film production: a step-by-step guide", keyword: "scene breakdown template", tags: ["production", "filmmaking"] },
    { topic: "How to budget an indie film: from micro-budget to low-budget", keyword: "indie film budget", tags: ["production", "budgeting"] },
    { topic: "Location scouting for filmmakers: a practical checklist", keyword: "film location scouting", tags: ["production", "filmmaking"] },
    { topic: "How to use AI tools in your screenwriting workflow without losing your voice", keyword: "AI screenwriting tools", tags: ["screenwriting", "AI tools"] },
    { topic: "Writing for short film: how to tell a complete story in under 15 minutes", keyword: "short film screenplay", tags: ["screenwriting", "filmmaking"] },
    { topic: "Common screenplay formatting mistakes and how to avoid them", keyword: "screenplay format mistakes", tags: ["screenwriting", "formatting"] },
    { topic: "How to get screenplay feedback: coverage, notes, and revision strategies", keyword: "screenplay feedback", tags: ["screenwriting", "story structure"] },
    { topic: "Film festival submission guide for first-time filmmakers", keyword: "film festival submission", tags: ["filmmaking", "production"] },
    { topic: "How to create a shooting schedule for your indie film", keyword: "film shooting schedule", tags: ["production", "filmmaking"] },
    { topic: "Visual storytelling techniques: using shots and framing to tell your story", keyword: "visual storytelling film", tags: ["filmmaking", "storyboarding"] },
    { topic: "How to write compelling character arcs that drive your screenplay", keyword: "character arc screenplay", tags: ["screenwriting", "characters"] },
    { topic: "Adapting a book or true story into a screenplay: rights, structure, and approach", keyword: "book to screenplay adaptation", tags: ["screenwriting", "story structure"] },
  ],
  blog_es: [
    { topic: "Tecnicas de dialogo: como hacer que cada personaje suene unico", keyword: "dialogo guion cinematografico", tags: ["screenwriting", "characters"] },
    { topic: "Estructura de tres actos explicada con ejemplos modernos", keyword: "estructura tres actos guion", tags: ["screenwriting", "story structure"] },
    { topic: "Como escribir un logline que venda tu guion", keyword: "como escribir logline", tags: ["screenwriting", "story structure"] },
    { topic: "Desglose de escenas para produccion indie: guia paso a paso", keyword: "desglose escenas cine", tags: ["production", "filmmaking"] },
    { topic: "Como presupuestar una pelicula indie: de micro-presupuesto a bajo presupuesto", keyword: "presupuesto pelicula indie", tags: ["production", "budgeting"] },
    { topic: "Busqueda de localizaciones para cineastas: checklist practico", keyword: "localizaciones cine", tags: ["production", "filmmaking"] },
    { topic: "Como usar herramientas de IA en tu proceso de escritura de guion", keyword: "IA escritura guion", tags: ["screenwriting", "AI tools"] },
    { topic: "Escribir para cortometraje: como contar una historia completa en menos de 15 minutos", keyword: "guion cortometraje", tags: ["screenwriting", "filmmaking"] },
  ],
  social: [
    { brief: "Tip: the #1 formatting mistake new screenwriters make (and how plotwell auto-fixes it)", platform: "tiktok" },
    { brief: "Behind the scenes: how a real writers room uses plotwell to collaborate on a TV pilot", platform: "linkedin" },
    { brief: "5 AI prompts that will unlock your screenplay's potential (using plotwell's brainstorm feature)", platform: "instagram" },
    { brief: "Hot take: why beat sheets are the most underrated screenwriting tool", platform: "x" },
    { brief: "Before/after: turning a messy Google Doc script into a properly formatted screenplay in 30 seconds", platform: "tiktok" },
    { brief: "The production planning checklist every indie filmmaker needs before day 1 of shooting", platform: "instagram" },
    { brief: "How we built an AI that understands screenplay structure (technical deep-dive for creators)", platform: "linkedin" },
    { brief: "POV: you just discovered your script editor has a storyboard feature with AI image generation", platform: "tiktok" },
    { brief: "3 ways to structure a web series pilot that hooks viewers in the first 2 minutes", platform: "x" },
    { brief: "From outline to shooting script: the plotwell workflow that saves indie filmmakers 40+ hours", platform: "linkedin" },
    { brief: "Quick tutorial: how to generate a full scene from a one-line description using AI", platform: "tiktok" },
    { brief: "Unpopular opinion: you don't need Final Draft. Here's why plotwell is the modern alternative.", platform: "x" },
  ],
};
