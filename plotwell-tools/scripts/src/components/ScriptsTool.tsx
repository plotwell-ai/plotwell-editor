import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAnonymous } from '@/hooks/useAnonymous'
import { useFileImport } from '@/hooks/useFileImport'
import { generateSceneList, generatePreview, generateFullScript, callOnboard } from '@/lib/api'
import type { SceneItem } from '@/lib/api'
import { EditorPreview } from './EditorPreview'
import { AuthModal } from './AuthModal'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://app.plotwell.co'

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Horror', 'Sci-Fi', 'Action', 'Romance', 'Documentary', 'Animation', 'Other']
const TONES = ['Serious', 'Dark', 'Humorous', 'Satirical', 'Inspirational', 'Suspenseful', 'Whimsical', 'Gritty']
const FORMATS = ['Feature Film', 'TV Pilot', 'Short Film', 'Web Series Episode']

type Step =
  | { id: 'input' }
  | { id: 'generating_scenes' }
  | { id: 'scene_list'; scenes: SceneItem[] }
  | { id: 'generating_preview'; scenes: SceneItem[] }
  | { id: 'preview'; scenes: SceneItem[]; previewContent: string }
  | { id: 'auth_gate'; scenes: SceneItem[]; previewContent: string }
  | { id: 'generating_full'; scenes: SceneItem[]; previewContent: string }
  | { id: 'full'; content: string; creditsUsed: number; creditsRemaining: number }

export function ScriptsTool() {
  const { user } = useAuth()
  const { hasUsedPreview, markPreviewUsed } = useAnonymous()
  const [step, setStep] = useState<Step>({ id: 'input' })
  const [showAuth, setShowAuth] = useState(false)
  const [authReason, setAuthReason] = useState('')
  const [error, setError] = useState('')
  const [importedFilename, setImportedFilename] = useState('')
  const [pendingOpenContent, setPendingOpenContent] = useState('')
  const [onboarding, setOnboarding] = useState(false)

  const [treatment, setTreatment] = useState('')
  const [genre, setGenre] = useState('Drama')
  const [tone, setTone] = useState('Serious')
  const [format, setFormat] = useState('Feature Film')

  const { open: openFilePicker, inputEl } = useFileImport((text, filename) => {
    setTreatment(text)
    setImportedFilename(filename)
    setError('')
  })

  async function handleGenerateScenes() {
    if (treatment.trim().length < 50) {
      setError('Add more detail — at least 50 characters.')
      return
    }
    setError('')
    setStep({ id: 'generating_scenes' })
    try {
      const { scenes } = await generateSceneList({ treatment, genre, tone, format })
      setStep({ id: 'scene_list', scenes })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStep({ id: 'input' })
    }
  }

  async function handleGeneratePreview(scenes: SceneItem[]) {
    if (hasUsedPreview() && !user) {
      setAuthReason('You\'ve used your free preview. Log in to generate the full script.')
      setShowAuth(true)
      return
    }
    setStep({ id: 'generating_preview', scenes })
    try {
      const { content } = await generatePreview({ treatment, genre, tone, format, scenes })
      markPreviewUsed()
      setStep({ id: 'preview', scenes, previewContent: content })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate preview')
      setStep({ id: 'scene_list', scenes })
    }
  }

  async function handleGenerateFull(scenes: SceneItem[], previewContent: string) {
    if (!user) {
      setStep({ id: 'auth_gate', scenes, previewContent })
      setAuthReason('Log in to generate the full script. New accounts get free starter credits.')
      setShowAuth(true)
      return
    }
    setError('')
    setStep({ id: 'generating_full', scenes, previewContent })
    try {
      const { content, credits_used, credits_remaining } = await generateFullScript({ treatment, genre, tone, format, scenes })
      setStep({ id: 'full', content, creditsUsed: credits_used, creditsRemaining: credits_remaining })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate full script')
      setStep({ id: 'preview', scenes, previewContent })
    }
  }

  async function handleAuthSuccess() {
    setShowAuth(false)
    if (step.id === 'auth_gate') {
      handleGenerateFull(step.scenes, step.previewContent)
    } else if (pendingOpenContent) {
      await doOpenInPlotwell(pendingOpenContent)
      setPendingOpenContent('')
    }
  }

  async function handleOpenInPlotwell(content: string) {
    if (!user) {
      setPendingOpenContent(content)
      setAuthReason('Create a free account to save your screenplay as a project in plotwell.')
      setShowAuth(true)
      return
    }
    await doOpenInPlotwell(content)
  }

  async function doOpenInPlotwell(content: string) {
    setOnboarding(true)
    try {
      sessionStorage.setItem('pw_import_fountain', content)
      sessionStorage.setItem('pw_import_meta', JSON.stringify({ genre, tone, format }))
      const projectName = importedFilename
        ? importedFilename.replace(/\.[^.]+$/, '')
        : undefined
      const { projectId } = await callOnboard({
        source: 'scripts-tool',
        projectName,
        sourceFountain: content,
      })
      window.location.href = `${APP_URL}/dashboard/${projectId}?section=script`
    } catch {
      window.location.href = `${APP_URL}/projects?source=scripts-tool`
    } finally {
      setOnboarding(false)
    }
  }

  const currentScenes =
    step.id === 'scene_list' || step.id === 'generating_preview' || step.id === 'preview' || step.id === 'auth_gate' || step.id === 'generating_full'
      ? step.scenes : []

  return (
    <>
      {inputEl}
      {showAuth && (
        <AuthModal onClose={() => setShowAuth(false)} onSuccess={handleAuthSuccess} reason={authReason} />
      )}

      <div className="max-w-3xl mx-auto px-4 py-10 md:py-16">

        {/* ─── Step: Input ─────────────────────────────────────────────── */}
        {step.id === 'input' && (
          <>
            <div className="text-center mb-10">
              <span className="inline-block bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold px-3 py-1 rounded-full mb-4">
                Free preview · no signup required
              </span>
              <h1 className="text-4xl font-bold text-slate-900 tracking-tight mb-3">
                Treatment to Screenplay
              </h1>
              <p className="text-slate-500 text-lg max-w-xl mx-auto leading-relaxed">
                Paste your treatment or import a file. Get a properly formatted screenplay — scene headings, action, dialogue — in the plotwell editor.
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-5">
              {/* Textarea + import */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-slate-700">Treatment, synopsis, or outline</label>
                  <button
                    onClick={openFilePicker}
                    className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Import file
                  </button>
                </div>

                {importedFilename && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
                    <svg className="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Imported: <strong>{importedFilename}</strong>
                    <button onClick={() => { setImportedFilename(''); setTreatment('') }} className="ml-auto text-emerald-600 hover:text-emerald-800">×</button>
                  </div>
                )}

                <textarea
                  value={treatment}
                  onChange={e => { setTreatment(e.target.value); setImportedFilename('') }}
                  placeholder="Paste your treatment here, or click 'Import file' to upload a .txt, .fountain, .fdx, or .docx file..."
                  rows={10}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition-shadow"
                />
                <p className="text-xs text-slate-400 mt-1">{treatment.length} chars · Supported imports: .txt .fountain .fdx .docx</p>
              </div>

              {/* Options row */}
              <div className="grid grid-cols-3 gap-3">
                {([['Genre', GENRES, genre, setGenre], ['Tone', TONES, tone, setTone], ['Format', FORMATS, format, setFormat]] as const).map(([label, opts, val, setter]) => (
                  <div key={label}>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
                    <select value={val} onChange={e => setter(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {opts.map((o: string) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-xl">{error}</p>}

              <button
                onClick={handleGenerateScenes}
                disabled={treatment.trim().length < 50}
                className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl text-sm transition-all shadow-sm hover:shadow-md"
              >
                Generate scene breakdown →
              </button>
              <p className="text-xs text-slate-400 text-center">
                Scene breakdown is free · Scene 1 preview is free · Full script costs 1 credit/scene
              </p>
            </div>
          </>
        )}

        {/* ─── Step: Loading ────────────────────────────────────────────── */}
        {step.id === 'generating_scenes' && <Spinner message="Analyzing your treatment and building scene breakdown..." />}

        {/* ─── Step: Scene list ─────────────────────────────────────────── */}
        {(step.id === 'scene_list' || step.id === 'generating_preview') && (
          <div>
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{currentScenes.length} scenes</h2>
                <p className="text-sm text-slate-500 mt-0.5">Preview Scene 1 for free — no signup needed.</p>
              </div>
              <button onClick={() => setStep({ id: 'input' })} className="text-xs text-slate-400 hover:text-slate-600 mt-1">← Back</button>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden mb-5">
              <div className="divide-y divide-slate-100">
                {currentScenes.map((scene, i) => (
                  <div key={i} className={`flex gap-3 px-4 py-3 ${i === 0 ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                    <span className="text-xs font-mono font-bold text-slate-400 mt-0.5 w-5 shrink-0 tabular-nums">{scene.number}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-mono font-semibold text-slate-700 uppercase">{scene.heading}</p>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{scene.summary}</p>
                    </div>
                    {i === 0 && <span className="ml-auto shrink-0 self-start text-xs bg-amber-100 text-amber-700 font-semibold px-2 py-0.5 rounded-full">Free</span>}
                  </div>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-xl mb-4">{error}</p>}

            {step.id === 'generating_preview'
              ? <Spinner message="Writing Scene 1 in screenplay format..." />
              : <button onClick={() => handleGeneratePreview(currentScenes)}
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white font-semibold py-3.5 rounded-xl text-sm transition-all shadow-sm hover:shadow-md">
                  Generate Scene 1 preview — free →
                </button>
            }
          </div>
        )}

        {/* ─── Step: Preview ────────────────────────────────────────────── */}
        {step.id === 'preview' && (
          <div>
            <div className="flex items-start justify-between mb-5">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Scene 1 preview</h2>
                <p className="text-sm text-slate-500 mt-0.5">This is your script in the plotwell screenplay editor.</p>
              </div>
              <button onClick={() => setStep({ id: 'scene_list', scenes: step.scenes })} className="text-xs text-slate-400 hover:text-slate-600 mt-1">← Scenes</button>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden mb-5">
              <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                <span className="text-xs text-slate-400 ml-2">plotwell screenplay editor — read-only preview</span>
              </div>
              <EditorPreview content={step.previewContent} editable={false} />
            </div>

            <div className="bg-slate-900 rounded-2xl p-6 text-center shadow-lg">
              <h3 className="text-white font-bold text-lg mb-1">Unlock the full screenplay</h3>
              <p className="text-slate-400 text-sm mb-5">
                {step.scenes.length} scenes · {step.scenes.length} credits
                {user ? ` · you have credits` : ' · new accounts get free starter credits'}
              </p>
              {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
              <button
                onClick={() => handleGenerateFull(step.scenes, step.previewContent)}
                className="bg-amber-500 hover:bg-amber-400 text-white font-bold px-10 py-3.5 rounded-xl text-sm transition-all shadow-md hover:shadow-lg"
              >
                {user ? 'Generate full screenplay →' : 'Sign up free & generate →'}
              </button>
              {!user && (
                <p className="text-xs text-slate-500 mt-3">
                  Already have an account?{' '}
                  <button onClick={() => { setAuthReason(''); setShowAuth(true) }} className="text-amber-400 hover:text-amber-300">Log in</button>
                </p>
              )}
            </div>
          </div>
        )}

        {/* ─── Step: Generating full ────────────────────────────────────── */}
        {step.id === 'generating_full' && (
          <Spinner
            message={`Writing your full screenplay (${step.scenes.length} scenes)...`}
            subMessage="This takes 30–90 seconds. Please stay on this page."
          />
        )}

        {/* ─── Step: Full script ────────────────────────────────────────── */}
        {step.id === 'full' && (
          <div>
            <div className="flex items-start justify-between mb-5">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Your screenplay is ready</h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  {step.creditsUsed} credits used · {step.creditsRemaining} remaining
                </p>
              </div>
              <button onClick={() => window.print()} className="text-xs font-medium text-slate-600 hover:text-slate-800 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors">Print / PDF</button>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden mb-5">
              <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                <span className="text-xs text-slate-400 ml-2">plotwell screenplay editor — editable</span>
              </div>
              <EditorPreview content={step.content} editable={true} />
            </div>

            <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-5 flex items-center gap-4 shadow-md">
              <div className="flex-1 min-w-0">
                <p className="text-white font-bold text-sm">Continue developing in plotwell</p>
                <p className="text-blue-200 text-xs mt-0.5">Characters, storyboard, production planning, collaboration — all in one place.</p>
              </div>
              <button
                onClick={() => handleOpenInPlotwell(step.content)}
                disabled={onboarding}
                className="bg-white text-blue-700 hover:bg-blue-50 font-bold px-4 py-2.5 rounded-xl text-sm transition-colors whitespace-nowrap shadow-sm disabled:opacity-70"
              >
                {onboarding ? 'Creating project...' : 'Open in plotwell →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Spinner({ message, subMessage }: { message: string; subMessage?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-12 h-12 rounded-full border-4 border-amber-100 border-t-amber-500 animate-spin mb-5" />
      <p className="text-base font-semibold text-slate-700">{message}</p>
      {subMessage && <p className="text-sm text-slate-400 mt-1.5">{subMessage}</p>}
    </div>
  )
}
