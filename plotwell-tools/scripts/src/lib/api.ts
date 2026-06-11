import { supabase } from './supabase'

const API_URL = import.meta.env.VITE_API_URL || ''

async function getAuthHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` }
  }
  return { 'Content-Type': 'application/json' }
}

export interface SceneItem {
  number: number
  heading: string
  summary: string
}

export interface GenerateScenesResponse {
  scenes: SceneItem[]
}

export interface GeneratePreviewResponse {
  content: string // Fountain format
  used_anonymous_quota: boolean
}

export interface GenerateFullResponse {
  content: string // Fountain format
  credits_used: number
  credits_remaining: number
}

/** Step 1: Extract scene list from treatment (free, no auth) */
export async function generateSceneList(body: {
  treatment: string
  genre: string
  tone: string
  format: string
}): Promise<GenerateScenesResponse> {
  const res = await fetch(`${API_URL}/api/tools/scripts/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to generate scene list')
  }
  return res.json()
}

/** Step 2: Generate Scene 1 preview (anonymous 1-shot) */
export async function generatePreview(body: {
  treatment: string
  genre: string
  tone: string
  format: string
  scenes: SceneItem[]
}): Promise<GeneratePreviewResponse> {
  const res = await fetch(`${API_URL}/api/tools/scripts/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to generate preview')
  }
  return res.json()
}

/** Step 3: Generate full script (auth required, costs credits) */
export async function generateFullScript(body: {
  treatment: string
  genre: string
  tone: string
  format: string
  scenes: SceneItem[]
}): Promise<GenerateFullResponse> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${API_URL}/api/tools/scripts/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to generate script')
  }
  return res.json()
}

/** Get credits balance (auth required) */
export async function getCreditsBalance(): Promise<{ balance: number }> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${API_URL}/api/ai-credits/balance`, { headers })
  if (!res.ok) throw new Error('Failed to get balance')
  const data = await res.json()
  return { balance: data.balance }
}

/** Create a project after auth and return its ID */
export async function callOnboard(body: {
  source: string
  projectName?: string
  sourceFountain?: string
}): Promise<{ projectId: string }> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${API_URL}/api/tools/onboard`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to create project')
  }
  return res.json()
}
