# plotwell-internal Roadmap

## Phase 1: Robustez y fiabilidad

### Parsing resiliente
- [x] **Blog**: Fallback cuando la IA no devuelve `---META---` (inferir meta desde contenido)
- [x] **Social**: Mostrar output raw si no se detectan secciones `##` en vez de tarjetas vacias
- [x] **SEM**: Fallback si no se detectan "Variation 1/2/3" (mostrar texto completo con copy)
- [x] Retry automatico (2 reintentos con backoff exponencial) en `@shared/ai-client` para errores 429/500/502/503/504

### Seguridad Stripe
- [~] Skipped (local-only, no deployed) - Vite proxy en dev es suficiente

### Persistencia de gastos
- [~] Skipped (local-only) - localStorage es suficiente para uso individual

## Phase 2: UX y productividad

### Email tool
- [x] Preview HTML renderizado (iframe sandbox) con toggle Code/Preview
- [x] Boton "Copiar HTML" separado del "Copiar texto plano"
- [ ] Validar compatibilidad basica (inline styles, no CSS grid, tablas para layout)

### Blog tool
- [ ] Verificar slug duplicado antes de guardar (leer directorio `plotwell-landing/content/blog/`)
- [x] Preview markdown renderizado (toggle Markdown/Preview con iframe)
- [ ] Guardar historial de posts generados (localStorage) para no perder borradores

### Social tool
- [ ] Generar 2-3 variantes por plataforma (A/B testing de contenido)
- [x] Selector de idioma (EN/ES)
- [ ] Preview visual tipo mockup por plataforma (frame de TikTok, card de LinkedIn, etc.)

### SEM tool
- [ ] Modo "campana completa": generar ad copy + keywords + extensiones en una sola generacion
- [x] Export a CSV compatible con Google Ads Editor

### SEO tool
- [ ] Integrar con Search Console API para datos reales de keywords
- [ ] Analisis de competencia (input: URL competidor, output: gap analysis)

### General UX
- [x] Toast notifications compartido (ToastProvider en ToolPage, CopyButton integrado)
- [ ] Skeleton loaders mientras se carga contenido de IA
- [ ] Ctrl+Z / historial de generaciones por sesion
- [ ] Dark mode (respetar `prefers-color-scheme`)

## Phase 3: Nuevas herramientas

### Analytics dashboard
- [ ] Conectar Amplitude/Plausible API para ver metricas de plotwell-landing y plotwell-app
- [ ] Metricas clave: signups, conversiones, churn, MRR
- [ ] Graficos con recharts o similar

### CRM basico
- [ ] Vista de usuarios con datos de Supabase + Stripe (plan, MRR, fecha signup, ultimo login)
- [ ] Filtros: plan, estado, actividad reciente
- [ ] Acciones rapidas: enviar email, extender trial, aplicar descuento

### Content calendar
- [ ] Calendario visual para planificar publicaciones (blog + social)
- [ ] Drag & drop para reprogramar
- [ ] Estado: borrador, en revision, programado, publicado
- [ ] Conectar con Blog y Social tools para generar contenido desde el calendario

### Legal / compliance
- [ ] Generador de textos legales (politica de privacidad, terminos, cookies) adaptados a RGPD
- [ ] Tracker de consentimientos y actualizaciones necesarias

## Phase 4: Infraestructura

### Backend ligero
- [ ] Mini servidor Express/Hono para:
  - Proxy seguro de Stripe API (eliminar secret key del frontend)
  - Persistencia de datos (gastos, calendario, historial de generaciones)
  - Endpoints para integraciones (Search Console, Amplitude)
- [ ] SQLite como base de datos (fichero local, cero config)

### Testing
- [ ] Tests de parsing para cada tool (blog meta, social sections, SEM variations, etc.)
- [ ] Tests de integracion para `@shared/ai-client`
- [ ] Playwright e2e para flujos criticos (generar blog post, crear gasto)

### DX
- [ ] Script `pnpm new-tool <name>` que scaffoldea un tool nuevo con todo el boilerplate
- [ ] Hot reload mejorado: actualmente al cambiar shared packages hay que reiniciar
- [ ] Linting y formatting compartido (eslint + prettier config en raiz)

## Prioridades

**Completado** (Phase 1 + Phase 2):
1. ~~Parsing resiliente~~ - Blog, Social, SEM fallbacks + retry en ai-client
2. ~~Email HTML preview~~ - iframe sandbox + Code/Preview toggle + "Copy HTML"
3. ~~Social idioma EN/ES~~ - Selector de idioma
4. ~~Toast notifications~~ - Sistema compartido via ToastProvider
5. ~~Blog markdown preview~~ - Toggle Markdown/Preview con mini parser
6. ~~SEM CSV export~~ - Descarga CSV compatible con Google Ads Editor
7. ~~Blog auto-suggest topics~~ - Content gaps pre-built + "Ask AI for Ideas" basado en posts existentes
8. ~~Social auto-brief~~ - Quick briefs pre-built por plataforma + AI suggestions
9. ~~Unified app~~ - `pnpm dev:all` (1 proceso, todas las tools, port 5180)
10. ~~@shared/content~~ - Inventario de posts existentes, content gaps, features de plotwell
11. ~~Social video asset generator~~ - Video clips (Hailuo 2.3 / Kling V3) + voiceover (MiniMax Speech 2.8 HD) + screenshots de producto como b-roll

**Siguiente** (Phase 2 restante):
1. Blog slug validation + historial de borradores
2. Social variantes A/B
3. Skeleton loaders

**Medio plazo**:
1. Content calendar
2. CRM basico
3. Dark mode

**Largo plazo**:
1. Analytics dashboard
2. Search Console integration
3. Backend ligero (Express/Hono + SQLite)
