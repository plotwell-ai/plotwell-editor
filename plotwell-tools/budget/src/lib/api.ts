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

export interface BudgetCategory { name: string; low: number; high: number; note: string }

export interface TopSheet {
  total_low: number
  total_high: number
  currency: string
  shooting_days_estimate: number
  assumptions: string[]
  categories: BudgetCategory[]
}

export interface LineItem { item: string; qty: number; unit: string; rate_low: number; rate_high: number; note: string }
export interface Department { name: string; line_items: LineItem[] }

export interface FullBreakdown {
  total_low: number
  total_high: number
  currency: string
  departments: Department[]
}

export interface BudgetFormData {
  description: string
  country: string
  union: string
  shooting_days: number
  cast_size: number
  genre: string
  format: string
}

export const getTopSheet = (data: BudgetFormData) =>
  post<{ estimate: TopSheet }>('/api/tools/budget/estimate', data)

export const getFullBreakdown = (data: BudgetFormData) =>
  post<{ breakdown: FullBreakdown; credits_used: number; credits_remaining: number }>(
    '/api/tools/budget/breakdown', data, true
  )

export const callOnboard = (body: { source: string; projectName?: string }) =>
  post<{ projectId: string }>('/api/tools/onboard', body, true)
