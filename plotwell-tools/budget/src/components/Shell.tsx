import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://app.plotwell.co'

interface ShellProps { children: React.ReactNode; onLoginClick: () => void }

function LogoMark() {
  return (
    <svg viewBox="0 0 100 100" width="28" height="28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="pw-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill="url(#pw-grad)" />
      <g fill="white">
        <rect x="25" y="22" width="50" height="6" rx="3" />
        <rect x="30" y="32" width="40" height="6" rx="3" />
        <rect x="20" y="42" width="60" height="6" rx="3" />
        <rect x="35" y="52" width="30" height="6" rx="3" />
        <rect x="15" y="62" width="70" height="6" rx="3" />
        <rect x="40" y="72" width="20" height="6" rx="3" />
      </g>
    </svg>
  )
}

export function Shell({ children, onLoginClick }: ShellProps) {
  const { user, loading } = useAuth()
  return (
    <div className="min-h-screen bg-white" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <header className="border-b border-slate-200 px-4 md:px-8 h-14 flex items-center justify-between">
        <a href="https://plotwell.co" className="flex items-center gap-2">
          <LogoMark />
          <span className="text-slate-900 font-bold text-base tracking-tight">plotwell</span>
          <span className="text-xs text-slate-400 font-medium hidden sm:inline">budget</span>
        </a>
        <div className="flex items-center gap-3">
          {!loading && !user && (
            <button onClick={onLoginClick} className="text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors">
              Log in
            </button>
          )}
          {!loading && user && (
            <div className="flex items-center gap-2">
              <a href={APP_URL} className="text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors">Open plotwell</a>
              <button onClick={() => supabase.auth.signOut()} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Sign out</button>
            </div>
          )}
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-slate-100 px-4 py-6 text-center">
        <p className="text-xs text-slate-400">A tool by <a href="https://plotwell.co" className="text-amber-600 hover:text-amber-700 font-medium">plotwell</a> — the professional screenplay platform</p>
      </footer>
    </div>
  )
}
