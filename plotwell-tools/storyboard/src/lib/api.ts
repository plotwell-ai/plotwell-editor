import { supabase } from './supabase'

const API_URL = import.meta.env.VITE_API_URL || ''

async function authHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession()
  const base = { 'Content-Type': 'application/json' }
  return session?.access_token ? { ...base, 'Authorization': `Bearer ${session.access_token}` } : base
}

async function post<T>(path: string, body: unknown, authenticated = false): Promise<T> {
  const headers = authenticated ? await authHeaders() : { 'Content-Type': 'application/json' }
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `Request failed (${res.status})`)
  }
  return res.json()
}

export interface SceneItem { number: number; heading: string; summary: string }
export interface Panel { number: number; heading: string; summary: string; imageUrl: string; description: string }

export const parseScript = (script: string) =>
  post<{ scenes: SceneItem[] }>('/api/tools/storyboard/parse', { script })

export const generatePreview = (scenes: SceneItem[], genre: string, style: string) =>
  post<{ panels: Panel[] }>('/api/tools/storyboard/preview', { scenes, genre, style })

export const generateFull = (scenes: SceneItem[], genre: string, style: string) =>
  post<{ panels: Panel[]; credits_used: number; credits_remaining: number }>(
    '/api/tools/storyboard/generate', { scenes, genre, style }, true
  )

export const getBalance = async (): Promise<number> => {
  const headers = await authHeaders()
  const res = await fetch(`${API_URL}/api/ai-credits/balance`, { headers })
  if (!res.ok) return 0
  const data = await res.json()
  return data.balance || 0
}

export const callOnboard = (body: { source: string; projectName?: string }) =>
  post<{ projectId: string }>('/api/tools/onboard', body, true)
