import { useState } from 'react'
import { supabase } from '@/lib/supabase'

interface AuthModalProps {
  onClose: () => void
  onSuccess: () => void
  reason?: string
}

export function AuthModal({ onClose, onSuccess, reason }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [checkEmail, setCheckEmail] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name } },
        })
        if (error) throw error
        setCheckEmail(true)
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onSuccess()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  if (checkEmail) {
    return (
      <Overlay onClose={onClose}>
        <div className="text-center py-4">
          <div className="text-3xl mb-3">📬</div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Check your email</h2>
          <p className="text-sm text-slate-500">
            We sent a confirmation link to <strong>{email}</strong>.
            Click it to activate your account, then come back here.
          </p>
        </div>
      </Overlay>
    )
  }

  return (
    <Overlay onClose={onClose}>
      {reason && (
        <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          {reason}
        </div>
      )}

      <h2 className="text-lg font-semibold text-slate-900 mb-1">
        {mode === 'signup' ? 'Create your free account' : 'Welcome back'}
      </h2>
      <p className="text-sm text-slate-500 mb-5">
        {mode === 'signup'
          ? 'New accounts get 10 free credits to generate your script.'
          : 'Log in to access your credits and saved scripts.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === 'signup' && (
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          minLength={8}
          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
        >
          {loading ? 'Please wait...' : mode === 'signup' ? 'Create account' : 'Log in'}
        </button>
      </form>

      <p className="text-xs text-slate-500 text-center mt-4">
        {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
        <button
          onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError('') }}
          className="text-blue-600 hover:text-blue-700 font-medium"
        >
          {mode === 'signup' ? 'Log in' : 'Sign up free'}
        </button>
      </p>
    </Overlay>
  )
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors text-lg"
        >
          ×
        </button>
        {children}
      </div>
    </div>
  )
}
