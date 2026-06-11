const STORAGE_KEY = 'pw_scripts_preview_used'

export function useAnonymous() {
  function hasUsedPreview(): boolean {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  }

  function markPreviewUsed(): void {
    localStorage.setItem(STORAGE_KEY, 'true')
  }

  return { hasUsedPreview, markPreviewUsed }
}
