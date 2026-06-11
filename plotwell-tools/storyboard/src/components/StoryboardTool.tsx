import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useFileImport } from '@/hooks/useFileImport'
import { parseScript, generatePreview, generateFull, callOnboard } from '@/lib/api'
import type { SceneItem, Panel } from '@/lib/api'
import { AuthModal } from './AuthModal'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://app.plotwell.co'
const PANEL_CREDIT_COST = 10
const PREVIEW_USED_KEY = 'pw_storyboard_preview_used'

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Horror', 'Sci-Fi', 'Action', 'Romance', 'Animation']
const STYLES = ['Realistic', 'Sketch', 'Noir', 'Anime', 'Painterly']

type Step =
  | { id: 'input' }
  | { id: 'parsing' }
  | { id: 'scene_list'; scenes: SceneItem[] }
  | { id: 'generating_preview'; scenes: SceneItem[] }
  | { id: 'preview'; scenes: SceneItem[]; panels: Panel[] }
  | { id: 'generating_full'; scenes: SceneItem[]; panels: Panel[] }
  | { id: 'full'; panels: Panel[]; creditsUsed: number; creditsRemaining: number }

export function StoryboardTool() {
  const { user } = useAuth()
  const [step, setStep] = useState<Step>({ id: 'input' })
  const [script, setScript] = useState('')
  const [importedFilename, setImportedFilename] = useState('')
  const [genre, setGenre] = useState('Drama')
  const [style, setStyle] = useState('Realistic')
  const [error, setError] = useState('')
  const [showAuth, setShowAuth] = useState(false)
  const [authReason, setAuthReason] = useState('')
  const [pendingAction, setPendingAction] = useState<'generate_full' | 'open_in_plotwell' | null>(null)
  const [pendingScenes, setPendingScenes] = useState<SceneItem[]>([])
  const [pendingPanels, setPendingPanels] = useState<Panel[]>([])
  const [onboarding, setOnboarding] = useState(false)

  const { open: openFileDialog, inputEl } = useFileImport((text, filename) => {
    setScript(text)
    setImportedFilename(filename)
  })

  function hasUsedPreview() { return localStorage.getItem(PREVIEW_USED_KEY) === 'true' }
  function markPreviewUsed() { localStorage.setItem(PREVIEW_USED_KEY, 'true') }

  async function handleParse() {
    if (script.trim().length < 50) {
      setError('Please paste at least a few lines of your screenplay.')
      return
    }
    setError('')
    setStep({ id: 'parsing' })
    try {
      const { scenes } = await parseScript(script)
      setStep({ id: 'scene_list', scenes })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse script')
      setStep({ id: 'input' })
    }
  }

  async function handlePreview(scenes: SceneItem[]) {
    if (hasUsedPreview() && !user) {
      setAuthReason('Log in to generate more storyboard panels.')
      setPendingAction('generate_full')
      setPendingScenes(scenes)
      setPendingPanels([])
      setShowAuth(true)
      return
    }
    setStep({ id: 'generating_preview', scenes })
    try {
      const { panels } = await generatePreview(scenes, genre, style)
      markPreviewUsed()
      setStep({ id: 'preview', scenes, panels })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate preview')
      setStep({ id: 'scene_list', scenes })
    }
  }

  async function handleGenerateFull(scenes: SceneItem[], previewPanels: Panel[]) {
    if (!user) {
      setPendingAction('generate_full')
      setPendingScenes(scenes)
      setPendingPanels(previewPanels)
      setAuthReason(`Sign up free to generate the full storyboard — ${scenes.length * PANEL_CREDIT_COST} credits for ${scenes.length} panels. New accounts get starter credits.`)
      setShowAuth(true)
      return
    }
    await doGenerateFull(scenes, previewPanels)
  }

  async function doGenerateFull(scenes: SceneItem[], previewPanels: Panel[]) {
    setStep({ id: 'generating_full', scenes, panels: previewPanels })
    try {
      const { panels, credits_used, credits_remaining } = await generateFull(scenes, genre, style)
      setStep({ id: 'full', panels, creditsUsed: credits_used, creditsRemaining: credits_remaining })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate storyboard')
      setStep({ id: 'preview', scenes, panels: previewPanels })
    }
  }

  async function handleOpenInPlotwell() {
    if (!user) {
      setPendingAction('open_in_plotwell')
      setAuthReason('Create a free account to save your storyboard as a project in plotwell.')
      setShowAuth(true)
      return
    }
    await doOpenInPlotwell()
  }

  async function doOpenInPlotwell() {
    setOnboarding(true)
    try {
      const { projectId } = await callOnboard({ source: 'storyboard-tool', projectName: importedFilename ? importedFilename.replace(/\.[^.]+$/, '') : undefined })
      window.location.href = `${APP_URL}/dashboard/${projectId}?section=storyboard`
    } catch {
      window.location.href = `${APP_URL}/projects`
    } finally {
      setOnboarding(false)
    }
  }

  async function handleAuthSuccess() {
    setShowAuth(false)
    if (pendingAction === 'generate_full') {
      await doGenerateFull(pendingScenes, pendingPanels)
    } else if (pendingAction === 'open_in_plotwell') {
      await doOpenInPlotwell()
    }
    setPendingAction(null)
  }

  const scenes = (step.id === 'scene_list' || step.id === 'generating_preview' || step.id === 'preview' || step.id === 'generating_full')
    ? step.scenes : []

  return (
    <>
      {inputEl}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={handleAuthSuccess} reason={authReason} />}

      <div className="max-w-3xl mx-auto px-4 py-10 md:py-16">

        {/* Hero */}
        {step.id === 'input' && (
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
              3 panels free — no signup
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">Script to Storyboard</h1>
            <p className="text-slate-500 text-base max-w-lg mx-auto">
              Paste your screenplay or import a file. Get AI-generated storyboard panels with proper cinematic framing.
            </p>
          </div>
        )}

        {/* Input */}
        {step.id === 'input' && (
          <div className="space-y-4">
            {/* Import button */}
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Your screenplay</label>
              <button
                type="button"
                onClick={openFileDialog}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
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
              value={script}
              onChange={e => setScript(e.target.value)}
              placeholder={"INT. COFFEE SHOP - DAY\n\nSarah enters, scanning the room. She spots a familiar face...\n\nSARAH\nI didn't expect to see you here.\n\nPaste your screenplay here or use Import file above."}
              rows={12}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono"
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Genre</label>
                <select value={genre} onChange={e => setGenre(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {GENRES.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Visual style</label>
                <select value={style} onChange={e => setStyle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {STYLES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg">{error}</p>}
            <button onClick={handleParse} disabled={script.trim().length < 50}
              className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl text-sm transition-colors">
              Analyse scenes →
            </button>
            <p className="text-xs text-slate-400 text-center">
              Scene analysis is free. First 3 panels free. Full storyboard costs {PANEL_CREDIT_COST} credits per panel.
            </p>
          </div>
        )}

        {/* Parsing */}
        {step.id === 'parsing' && <Spinner message="Analysing your screenplay into scenes..." />}

        {/* Scene list */}
        {(step.id === 'scene_list' || step.id === 'generating_preview') && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{scenes.length} scenes found</h2>
                <p className="text-sm text-slate-500">Generate the first 3 panels free to preview the visual style.</p>
              </div>
              <button onClick={() => setStep({ id: 'input' })} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">← Back</button>
            </div>

            <div className="space-y-2 mb-6 max-h-64 overflow-y-auto">
              {scenes.map((s, i) => (
                <div key={i} className={`flex gap-3 p-2.5 rounded-lg border ${i < 3 ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-white'}`}>
                  <span className="text-xs font-mono font-bold text-slate-400 shrink-0 mt-0.5 w-5">{s.number}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-mono font-semibold text-slate-600 uppercase truncate">{s.heading}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{s.summary}</p>
                  </div>
                  {i < 3 && <span className="ml-auto text-xs bg-amber-100 text-amber-700 font-semibold px-2 py-0.5 rounded shrink-0 self-start">Free</span>}
                </div>
              ))}
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg mb-4">{error}</p>}

            {step.id === 'generating_preview'
              ? <Spinner message="Generating storyboard panels... this takes ~30 seconds." />
              : (
                <button onClick={() => handlePreview(scenes)}
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white font-semibold py-3.5 rounded-xl text-sm transition-colors">
                  Generate 3 preview panels (free) →
                </button>
              )
            }
          </div>
        )}

        {/* Preview */}
        {(step.id === 'preview' || step.id === 'generating_full') && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Preview — first 3 panels</h2>
                <p className="text-sm text-slate-500">{style} · {genre}</p>
              </div>
              <button onClick={() => setStep({ id: 'scene_list', scenes: step.scenes })}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors">← Scenes</button>
            </div>

            <PanelGrid panels={step.panels} />

            {step.id === 'generating_full'
              ? <Spinner message={`Generating all ${step.scenes.length} panels... this takes a while.`} />
              : (
                <div className="mt-8 bg-slate-900 rounded-2xl p-6 text-center">
                  <h3 className="text-white font-semibold text-base mb-1">Generate the full storyboard</h3>
                  <p className="text-slate-400 text-sm mb-5">
                    {step.scenes.length} scenes · {step.scenes.length * PANEL_CREDIT_COST} credits
                    {!user ? ' · New accounts get starter credits' : ''}
                  </p>
                  {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
                  <button onClick={() => handleGenerateFull(step.scenes, step.panels)}
                    className="bg-amber-500 hover:bg-amber-600 text-white font-semibold px-8 py-3 rounded-xl text-sm transition-colors">
                    {user ? 'Generate full storyboard →' : 'Sign up free & generate →'}
                  </button>
                </div>
              )
            }
          </div>
        )}

        {/* Full storyboard */}
        {step.id === 'full' && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Your storyboard</h2>
                <p className="text-sm text-slate-500">
                  {step.panels.length} panels · {step.creditsUsed} credits used · {step.creditsRemaining} remaining
                </p>
              </div>
              <button onClick={() => window.print()}
                className="text-sm font-medium text-slate-600 hover:text-slate-800 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors">
                Print / PDF
              </button>
            </div>

            <PanelGrid panels={step.panels} showDescriptions />

            {/* Open in plotwell CTA */}
            <div className="mt-8 rounded-2xl overflow-hidden">
              <div className="bg-gradient-to-r from-blue-600 to-blue-500 p-6 text-center">
                <p className="text-white font-semibold text-base mb-1">Continue in plotwell</p>
                <p className="text-blue-100 text-sm mb-5">
                  Edit panels, link to your script, collaborate with your team.
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

function PanelGrid({ panels, showDescriptions = false }: { panels: Panel[]; showDescriptions?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
      {panels.map((panel) => (
        <div key={panel.number} className="rounded-xl overflow-hidden border border-slate-200 shadow-sm">
          <div className="relative bg-slate-100 aspect-video">
            <img
              src={panel.imageUrl}
              alt={panel.heading}
              className="w-full h-full object-cover"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <div className="absolute top-2 left-2 bg-black/60 text-white text-xs font-mono px-2 py-0.5 rounded">
              #{panel.number}
            </div>
          </div>
          <div className="p-2.5">
            <p className="text-xs font-mono font-semibold text-slate-600 uppercase truncate">{panel.heading}</p>
            {showDescriptions && (
              <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{panel.description}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Spinner({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-10 h-10 rounded-full border-4 border-amber-200 border-t-amber-600 animate-spin mb-4" />
      <p className="text-sm font-medium text-slate-700">{message}</p>
    </div>
  )
}
