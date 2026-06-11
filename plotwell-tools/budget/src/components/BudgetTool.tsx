import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useFileImport } from '@/hooks/useFileImport'
import { getTopSheet, getFullBreakdown, callOnboard } from '@/lib/api'
import type { TopSheet, FullBreakdown, BudgetFormData } from '@/lib/api'
import { AuthModal } from './AuthModal'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://app.plotwell.co'
const BREAKDOWN_CREDITS = 5

const COUNTRIES = ['USA', 'UK', 'Canada', 'Spain', 'France', 'Germany', 'Italy', 'Australia', 'Mexico', 'Argentina', 'Brazil', 'India', 'Other']
const GENRES = ['Drama', 'Comedy', 'Thriller', 'Horror', 'Sci-Fi', 'Action', 'Romance', 'Documentary', 'Animation']
const FORMATS = ['Feature Film', 'TV Pilot', 'Short Film', 'Web Series Episode', 'Documentary']

type Step =
  | { id: 'form' }
  | { id: 'estimating' }
  | { id: 'topsheet'; data: BudgetFormData; estimate: TopSheet }
  | { id: 'generating_breakdown'; data: BudgetFormData; estimate: TopSheet }
  | { id: 'breakdown'; data: BudgetFormData; estimate: TopSheet; breakdown: FullBreakdown; creditsUsed: number; creditsRemaining: number }

function fmt(n: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
}

export function BudgetTool() {
  const { user } = useAuth()
  const [step, setStep] = useState<Step>({ id: 'form' })
  const [showAuth, setShowAuth] = useState(false)
  const [error, setError] = useState('')
  const [onboarding, setOnboarding] = useState(false)
  const [showScriptInput, setShowScriptInput] = useState(false)
  const [scriptText, setScriptText] = useState('')
  const [importedFilename, setImportedFilename] = useState('')

  const { open: openFileDialog, inputEl } = useFileImport((text, filename) => {
    setScriptText(text)
    setImportedFilename(filename)
    setShowScriptInput(true)
  })

  const [formData, setFormData] = useState<BudgetFormData>({
    description: '',
    country: 'USA',
    union: 'Non-union',
    shooting_days: 15,
    cast_size: 5,
    genre: 'Drama',
    format: 'Feature Film',
  })

  function update(field: keyof BudgetFormData, value: string | number) {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  function buildDescription() {
    // Merge the script text into the description for better AI context
    if (scriptText.trim()) {
      return scriptText.slice(0, 1200) + (formData.description.trim() ? `\n\nAdditional notes: ${formData.description}` : '')
    }
    return formData.description
  }

  async function handleEstimate() {
    const description = buildDescription()
    if (description.trim().length < 30) {
      setError('Please add a project description or import a script/treatment.')
      return
    }
    setError('')
    setStep({ id: 'estimating' })
    try {
      const { estimate } = await getTopSheet({ ...formData, description })
      setStep({ id: 'topsheet', data: { ...formData, description }, estimate })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate estimate')
      setStep({ id: 'form' })
    }
  }

  async function handleBreakdown(data: BudgetFormData, estimate: TopSheet) {
    if (!user) {
      setShowAuth(true)
      return
    }
    await doBreakdown(data, estimate)
  }

  async function doBreakdown(data: BudgetFormData, estimate: TopSheet) {
    setStep({ id: 'generating_breakdown', data, estimate })
    try {
      const { breakdown, credits_used, credits_remaining } = await getFullBreakdown(data)
      setStep({ id: 'breakdown', data, estimate, breakdown, creditsUsed: credits_used, creditsRemaining: credits_remaining })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate breakdown')
      setStep({ id: 'topsheet', data, estimate })
    }
  }

  async function handleAuthSuccess() {
    setShowAuth(false)
    if (step.id === 'topsheet') {
      await doBreakdown(step.data, step.estimate)
    }
  }

  async function handleOpenInPlotwell() {
    if (!user) {
      setShowAuth(true)
      return
    }
    await doOpenInPlotwell()
  }

  async function doOpenInPlotwell() {
    setOnboarding(true)
    try {
      const projectName = importedFilename ? importedFilename.replace(/\.[^.]+$/, '') : undefined
      const { projectId } = await callOnboard({ source: 'budget-tool', projectName })
      window.location.href = `${APP_URL}/dashboard/${projectId}?section=budget`
    } catch {
      window.location.href = `${APP_URL}/projects`
    } finally {
      setOnboarding(false)
    }
  }

  return (
    <>
      {inputEl}
      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={handleAuthSuccess}
          reason={`Sign up free to generate the full department breakdown. Costs ${BREAKDOWN_CREDITS} credits. New accounts get starter credits.`}
        />
      )}

      <div className="max-w-2xl mx-auto px-4 py-10 md:py-16">

        {/* Hero */}
        {step.id === 'form' && (
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
              Top-sheet estimate — free
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">Film Budget Estimator</h1>
            <p className="text-slate-500 text-base max-w-lg mx-auto">
              Get a realistic budget range for your film project. Free top-sheet. Full department breakdown for {BREAKDOWN_CREDITS} credits.
            </p>
          </div>
        )}

        {/* Form */}
        {step.id === 'form' && (
          <div className="space-y-4">
            {/* Optional: import script */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setShowScriptInput(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
              >
                <span className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Script or treatment
                  <span className="text-xs text-slate-400 font-normal">(optional — improves accuracy)</span>
                </span>
                <svg className={`w-4 h-4 text-slate-400 transition-transform ${showScriptInput ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showScriptInput && (
                <div className="p-4 border-t border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">Paste your script, treatment, or synopsis for a more accurate estimate.</p>
                    <button
                      type="button"
                      onClick={openFileDialog}
                      className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import file
                    </button>
                  </div>
                  {importedFilename && (
                    <p className="text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      {importedFilename} imported
                    </p>
                  )}
                  <textarea
                    value={scriptText}
                    onChange={e => setScriptText(e.target.value)}
                    placeholder="Paste your script, treatment, or synopsis here..."
                    rows={8}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono"
                  />
                </div>
              )}
            </div>

            {/* Project description */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {scriptText.trim() ? 'Additional notes (optional)' : 'Project description'}
              </label>
              <textarea
                value={formData.description}
                onChange={e => update('description', e.target.value)}
                placeholder={scriptText.trim()
                  ? "Any additional context — special effects, stunts, specific locations..."
                  : "Describe your film project — genre, story, locations, number of characters, special effects, production scope..."}
                rows={scriptText.trim() ? 3 : 5}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Country</label>
                <select value={formData.country} onChange={e => update('country', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {COUNTRIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Production type</label>
                <select value={formData.union} onChange={e => update('union', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {['Non-union', 'Union / SAG-AFTRA', 'Student film'].map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Genre</label>
                <select value={formData.genre} onChange={e => update('genre', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {GENRES.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Format</label>
                <select value={formData.format} onChange={e => update('format', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {FORMATS.map(f => <option key={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Shooting days</label>
                <input type="number" min={1} max={120} value={formData.shooting_days}
                  onChange={e => update('shooting_days', parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Principal cast size</label>
                <input type="number" min={1} max={50} value={formData.cast_size}
                  onChange={e => update('cast_size', parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg">{error}</p>}

            <button
              onClick={handleEstimate}
              disabled={buildDescription().trim().length < 30}
              className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl text-sm transition-colors"
            >
              Generate budget estimate — free →
            </button>
          </div>
        )}

        {/* Loading */}
        {(step.id === 'estimating' || step.id === 'generating_breakdown') && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-10 h-10 rounded-full border-4 border-amber-200 border-t-amber-600 animate-spin mb-4" />
            <p className="text-sm font-medium text-slate-700">
              {step.id === 'estimating' ? 'Calculating your budget estimate...' : 'Generating full department breakdown...'}
            </p>
          </div>
        )}

        {/* Top-sheet */}
        {step.id === 'topsheet' && (
          <TopSheetView
            estimate={step.estimate}
            onBreakdown={() => handleBreakdown(step.data, step.estimate)}
            onReset={() => setStep({ id: 'form' })}
            error={error}
            user={!!user}
          />
        )}

        {/* Full breakdown */}
        {step.id === 'breakdown' && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Full budget breakdown</h2>
                <p className="text-sm text-slate-500">
                  {step.creditsUsed} credits used · {step.creditsRemaining} remaining
                </p>
              </div>
              <button onClick={() => window.print()} className="text-sm font-medium text-slate-600 hover:text-slate-800 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors">
                Print / PDF
              </button>
            </div>

            <TotalBadge low={step.breakdown.total_low} high={step.breakdown.total_high} currency={step.breakdown.currency} />

            <div className="mt-6 space-y-3">
              {step.breakdown.departments.map((dept, i) => {
                const deptLow = dept.line_items.reduce((s, l) => s + l.qty * l.rate_low, 0)
                const deptHigh = dept.line_items.reduce((s, l) => s + l.qty * l.rate_high, 0)
                return (
                  <details key={i} className="border border-slate-200 rounded-xl overflow-hidden" open={i === 0}>
                    <summary className="flex items-center justify-between px-4 py-3 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors list-none">
                      <span className="text-sm font-semibold text-slate-800">{dept.name}</span>
                      <span className="text-sm font-mono text-slate-600 shrink-0 ml-4">
                        {fmt(deptLow, step.breakdown.currency)} – {fmt(deptHigh, step.breakdown.currency)}
                      </span>
                    </summary>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <th className="text-left px-4 py-2 font-medium text-slate-500">Item</th>
                          <th className="text-right px-3 py-2 font-medium text-slate-500">Qty</th>
                          <th className="text-right px-3 py-2 font-medium text-slate-500">Unit</th>
                          <th className="text-right px-4 py-2 font-medium text-slate-500">Range</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dept.line_items.map((li, j) => (
                          <tr key={j} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-4 py-2 text-slate-700">{li.item}{li.note ? <span className="text-slate-400 ml-1">({li.note})</span> : null}</td>
                            <td className="px-3 py-2 text-right text-slate-600 font-mono">{li.qty}</td>
                            <td className="px-3 py-2 text-right text-slate-500">{li.unit}</td>
                            <td className="px-4 py-2 text-right text-slate-600 font-mono whitespace-nowrap">
                              {fmt(li.qty * li.rate_low, step.breakdown.currency)} – {fmt(li.qty * li.rate_high, step.breakdown.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )
              })}
            </div>

            {/* Open in plotwell CTA */}
            <div className="mt-8 rounded-2xl overflow-hidden">
              <div className="bg-gradient-to-r from-blue-600 to-blue-500 p-6 text-center">
                <p className="text-white font-semibold text-base mb-1">Track this budget in plotwell</p>
                <p className="text-blue-100 text-sm mb-5">
                  Full budget management, cost reports, and production planning in one place.
                </p>
                <button
                  onClick={handleOpenInPlotwell}
                  disabled={onboarding}
                  className="bg-white text-blue-700 hover:bg-blue-50 font-semibold px-8 py-3 rounded-xl text-sm transition-colors disabled:opacity-70"
                >
                  {onboarding ? 'Creating your project...' : 'Open in plotwell →'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function TopSheetView({ estimate, onBreakdown, onReset, error, user }: {
  estimate: TopSheet; onBreakdown: () => void; onReset: () => void; error: string; user: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-slate-900">Budget estimate</h2>
        <button onClick={onReset} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">← Adjust inputs</button>
      </div>

      <TotalBadge low={estimate.total_low} high={estimate.total_high} currency={estimate.currency} />
      <p className="text-xs text-slate-400 mt-2 mb-5">
        Estimated {estimate.shooting_days_estimate} shooting days
      </p>

      <div className="space-y-2.5 mb-6">
        {estimate.categories.map((cat, i) => {
          const pct = estimate.total_high > 0 ? Math.round((cat.high / estimate.total_high) * 100) : 0
          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-700">{cat.name}</span>
                <span className="text-xs font-mono text-slate-500">
                  {fmt(cat.low, estimate.currency)} – {fmt(cat.high, estimate.currency)}
                </span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
              </div>
              {cat.note && <p className="text-xs text-slate-400 mt-0.5">{cat.note}</p>}
            </div>
          )
        })}
      </div>

      {estimate.assumptions.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6">
          <p className="text-xs font-semibold text-slate-600 mb-2">Assumptions</p>
          <ul className="space-y-1">
            {estimate.assumptions.map((a, i) => (
              <li key={i} className="text-xs text-slate-500 flex gap-2">
                <span className="text-slate-300 shrink-0">·</span>{a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg mb-4">{error}</p>}

      <div className="bg-slate-900 rounded-2xl p-6 text-center">
        <h3 className="text-white font-semibold text-base mb-1">Full department breakdown</h3>
        <p className="text-slate-400 text-sm mb-5">
          Line-by-line budget per department with rate assumptions · {BREAKDOWN_CREDITS} credits
          {!user ? ' · Free account gets starter credits' : ''}
        </p>
        <button onClick={onBreakdown}
          className="bg-amber-500 hover:bg-amber-600 text-white font-semibold px-8 py-3 rounded-xl text-sm transition-colors">
          {user ? 'Generate full breakdown →' : 'Sign up free & generate →'}
        </button>
      </div>
    </div>
  )
}

function TotalBadge({ low, high, currency }: { low: number; high: number; currency: string }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex items-center justify-between">
      <div>
        <p className="text-xs font-medium text-amber-700 mb-0.5">Estimated total budget</p>
        <p className="text-2xl font-bold text-slate-900 font-mono">
          {fmt(low, currency)} <span className="text-slate-400 font-normal text-lg">–</span> {fmt(high, currency)}
        </p>
      </div>
      <span className="text-xs bg-amber-100 text-amber-700 font-semibold px-3 py-1.5 rounded-full">{currency}</span>
    </div>
  )
}
