# plotwell-internal

Internal marketing, content, and operations tools for plotwell. A micro-frontend monorepo with AI-powered content generation and business management tools. Local only, not deployed.

## Architecture

**Module Federation** (via `@originjs/vite-plugin-federation`) with a pnpm workspace monorepo:

```
plotwell-internal/
├── shell/              # Host app (sidebar + routing)
├── tools/              # Remote micro-frontends
│   ├── blog/           # Blog post generator (EN/ES, frontmatter, cover images)
│   ├── social/         # Social media content (TikTok, IG, X, LinkedIn)
│   ├── seo/            # SEO tools (meta tags, keywords, content optimizer)
│   ├── sem/            # Ad copy generator (Google, Meta, LinkedIn Ads)
│   ├── email/          # Email campaigns (single, drip, subject lines)
│   ├── analytics/      # Revenue, traffic, SEO audit dashboard
│   └── accounting/     # Contabilidad espanola (Stripe + modelos fiscales)
└── shared/             # Shared workspace packages
    ├── ai-client/      # Replicate API client (GPT-OSS-120B, GPT-5-Mini)
    ├── components/     # Shared UI components
    └── prompts/        # Brand-aware system prompts
```

Each tool can run standalone on its own port or inside the shell.

## Tech Stack

- React 19 + TypeScript
- Vite 6 + Module Federation
- Tailwind CSS v3
- pnpm workspaces
- Replicate API (GPT-OSS-120B, GPT-5-Mini, Flux 2 Dev for images)
- Stripe API (accounting tool)

## Tools

| Tool | Port | Description |
|------|------|-------------|
| **Shell** | 5180 | Host app with sidebar navigation |
| **Blog** | 5181 | Blog posts with frontmatter, SEO metadata, cover images. EN/ES/both. Outputs .md files for `plotwell-landing/content/blog/` |
| **Social** | 5182 | Platform-specific content for TikTok, Instagram, X, LinkedIn with character counters |
| **SEO** | 5183 | Meta tag generator, keyword ideas, content optimizer, SERP preview, schema markup |
| **SEM** | 5184 | Ad copy for Google Ads, Meta Ads, LinkedIn Ads. 3 variations with char limits |
| **Email** | 5185 | Single emails, drip sequences, subject line A/B tests |
| **Contabilidad** | 5186 | Contabilidad y fiscalidad para PLOTWELL, S.L.U. (ver detalle abajo) |
| **Analytics** | 5187 | Revenue (Stripe), customers, SEO site audit |

### Contabilidad (Accounting)

Dashboard fiscal para una S.L.U. espanola conectado a Stripe. 6 pestanas:

| Pestana | Que hace |
|---------|----------|
| **Resumen** | Metricas trimestrales: facturado, base imponible, IVA repercutido, gastos, resultado neto. Grafico mensual |
| **Modelo 303** | IVA trimestral auto-calculado desde Stripe (casillas 01-07). Boton "Copiar datos" para pegar en AEAT |
| **Modelo 130** | IRPF pago fraccionado (20% rendimiento neto). Toggle para autonomos |
| **Modelo 390** | Resumen anual IVA, agregado de los 4 trimestres |
| **Facturas** | Lista de cobros de Stripe (fecha, cliente, base, IVA, total). Export CSV |
| **Gastos** | Tracker manual en localStorage (categorias: SaaS, hosting, marketing...). Alimenta 303 y 130. Export CSV |

Plazos fiscales: Modelo 303/130 (Q1: 1-20 abril, Q2: 1-20 julio, Q3: 1-20 octubre, Q4: 1-30 enero). Modelo 390: 1-30 enero.

Incluye asistente IA para consultas fiscales ("Consultar IA").

## Shared Packages

### `@shared/ai-client`

Cliente Replicate API. Dos modelos:

- **GPT-OSS-120B** (default) - `generate()` y `stream()`
- **GPT-5-Mini** - via opcion `model: "gpt-5-mini"`

### `@shared/components`

- `ToolPage` - Layout estandar (titulo, descripcion, contenido)
- `PromptInput` - Textarea con boton (Ctrl+Enter)
- `StreamingOutput` - Output con cursor de streaming
- `CopyButton` - Copiar al clipboard

### `@shared/prompts`

System prompts por dominio: `BRAND_CONTEXT`, `BLOG_SYSTEM`, `SOCIAL_SYSTEM`, `SEO_SYSTEM`, `SEM_SYSTEM`, `EMAIL_SYSTEM`.

## Setup

```bash
# Install dependencies
pnpm install

# Copy env and add your keys
cp .env.local.example .env.local
```

### Environment Variables

| Variable | Descripcion | Usado por |
|----------|-------------|-----------|
| `VITE_REPLICATE_API_TOKEN` | Replicate API token (mismo que plotwell-backend) | Blog, Social, SEO, SEM, Email, Contabilidad (IA) |
| `VITE_STRIPE_SECRET_KEY` | Stripe secret key (mismo que plotwell-backend) | Contabilidad, Analytics |

## Development

```bash
# Recommended: unified app (1 process, all tools, port 5180)
pnpm dev:all

# Alternative: all tools as separate processes (Module Federation)
pnpm dev

# Run individual tools standalone
pnpm dev:blog          # Blog (port 5181)
pnpm dev:social        # Social (port 5182)
pnpm dev:seo           # SEO (port 5183)
pnpm dev:sem           # SEM (port 5184)
pnpm dev:email         # Email (port 5185)
pnpm dev:accounting    # Contabilidad (port 5186)
pnpm dev:analytics     # Analytics (port 5187)
```

**`pnpm dev:all`** (recommended) runs a single Vite process with all tools bundled. Fast startup, single port.

`pnpm dev` starts 7+ separate Vite processes (Module Federation). Only needed if developing federation-specific features.

## Adding a New Tool

1. Crear `tools/<name>/` (copiar de un tool existente)
2. Exponer `./App` via Module Federation en `vite.config.ts`
3. Anadir remote en `shell/vite.config.ts`
4. Anadir ruta y nav item en `shell/src/App.tsx`
5. Anadir type declaration en `shell/src/vite-env.d.ts`
6. Anadir script `dev:<name>` en el `package.json` raiz
7. Usar `@shared/ai-client` y `@shared/components` para consistencia
